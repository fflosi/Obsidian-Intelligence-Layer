import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FSWatcher } from "chokidar";
import { statSync } from "node:fs";
import { resolve, join } from "node:path";
import { VaultWatcher } from "../watcher.js";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { parseNote } from "../vault.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCoreTools } from "../tools/core.js";
import { DEFAULT_CONFIG } from "../config.js";

const root = resolve("test-vault");
let instances: FSWatcher[];
let watcher: VaultWatcher;
let graph: GraphIndex;
let cache: SessionCache;

function error(code: string) {
  return Object.assign(new Error(`fixture ${code}`), { code });
}

beforeEach(() => {
  vi.useFakeTimers();
  instances = [];
  vi.spyOn(FSWatcher.prototype, "add").mockImplementation(function (this: FSWatcher) {
    instances.push(this);
    return this;
  });
  vi.spyOn(FSWatcher.prototype, "close").mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  graph = new GraphIndex(root);
  vi.spyOn(graph, "build").mockResolvedValue(undefined);
  vi.spyOn(graph, "updateNote").mockResolvedValue(undefined);
  cache = new SessionCache();
  watcher = new VaultWatcher(root, graph, cache);
});

afterEach(async () => {
  await watcher.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function begin() {
  watcher.start();
  instances[0].emit("ready");
  await vi.advanceTimersByTimeAsync(0);
}

describe("pre-watch exclusions", () => {
  it("filters lock files before stats and retains directories and supported notes", () => {
    watcher.start();
    const ignored = instances[0].options.ignored[0];
    if (typeof ignored !== "function") throw new Error("Expected predicate filter");
    const file = statSync(new URL(import.meta.url));
    const directory = statSync(new URL(".", import.meta.url));
    expect(ignored(join(root, "Automation", "operation.lock"))).toBe(true);
    expect(ignored(join(root, "operation.LOCK"), file)).toBe(true);
    expect(ignored(join(root, ".obsidian", "settings.json"))).toBe(true);
    expect(ignored(join(root, "node_modules", "package", "readme.md"))).toBe(true);
    expect(ignored(join(root, "notes"), directory)).toBe(false);
    expect(ignored(root, directory)).toBe(false);
    expect(ignored(join(root, "notes", "project.v1"), directory)).toBe(false);
    expect(ignored(join(root, "notes", "note.md"), file)).toBe(false);
    expect(ignored(join(root, "notes", "note.markdown"), file)).toBe(false);
    expect(ignored(join(root, "notes", "note.txt"), file)).toBe(false);
    expect(ignored(join(root, "notes", "cache.json"), file)).toBe(true);
  });
});

describe("watcher error recovery", () => {
  it("catches EBUSY, coalesces errors, rebuilds after ready, and preserves write confirmations", async () => {
    await begin();
    cache.putNote("note.md", parseNote("note.md", "# Old"));
    cache.addPendingWrite({
      id: "pending", operation: "append", path: "note.md", diff: "+ content", createdAt: new Date(),
    });
    const beforePending = cache.listPendingWrites();
    expect(() => instances[0].emit("error", error("EBUSY"))).not.toThrow();
    instances[0].emit("error", error("EBUSY"));
    expect(watcher.getStatus()).toMatchObject({
      active: false, state: "recovering", restartAttempts: 1, indexMayBeStale: true,
      lastError: { code: "EBUSY" },
    });
    expect(cache.getNote("note.md")).toBeUndefined();
    expect(cache.listPendingWrites()).toEqual(beforePending);
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances).toHaveLength(2);
    expect(FSWatcher.prototype.close).toHaveBeenCalledTimes(1);
    expect(graph.build).not.toHaveBeenCalled();
    instances[1].emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(graph.build).toHaveBeenCalledTimes(1);
    expect(graph.build).toHaveBeenCalledWith({ strict: true });
    expect(watcher.getStatus()).toMatchObject({
      active: true, state: "healthy", indexMayBeStale: false, restartAttempts: 1,
    });
    instances[1].emit("change", join(root, "note.md"));
    await vi.advanceTimersByTimeAsync(300);
    expect(graph.updateNote).toHaveBeenCalledWith("note.md");
  });

  it("exhausts its budget even if each failing attempt emits ready", async () => {
    await begin();
    for (let attempt = 0; attempt < 3; attempt++) {
      instances[attempt].emit("error", error("EBUSY"));
      await vi.advanceTimersByTimeAsync(1000 * 2 ** attempt);
      instances[attempt + 1].emit("ready");
      await vi.advanceTimersByTimeAsync(0);
    }
    instances[3].emit("error", error("EBUSY"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(4);
    expect(watcher.getStatus()).toMatchObject({
      active: false, state: "degraded", restartAttempts: 3, indexMayBeStale: true,
    });
  });

  it("reports unknown errors without crashing or retrying indefinitely", async () => {
    await begin();
    instances[0].emit("error", new Error("Unexpected watcher failure"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
    expect(watcher.getStatus()).toMatchObject({
      active: false, state: "degraded", indexMayBeStale: true,
      lastError: { code: "UNKNOWN", message: "Unexpected watcher failure" },
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("does not replace a watcher whose close fails", async () => {
    await begin();
    vi.mocked(FSWatcher.prototype.close).mockRejectedValueOnce(new Error("close failed"));
    instances[0].emit("error", error("EBUSY"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
    expect(watcher.getStatus()).toMatchObject({ state: "degraded", indexMayBeStale: true });
    expect(console.error).toHaveBeenCalledWith(
      "[OIL] Could not close failed watcher; automatic restart cancelled.",
    );
  });

  it("catches synchronous watcher startup errors", async () => {
    vi.mocked(FSWatcher.prototype.add).mockImplementationOnce(function (this: FSWatcher) {
      instances.push(this);
      throw error("EPERM");
    });
    expect(() => watcher.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances).toHaveLength(2);
    instances[1].emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getStatus().state).toBe("healthy");
  });

  it("warns on slow startup without closing the watcher and catches up on late ready", async () => {
    watcher.start();
    expect(watcher.getStatus()).toMatchObject({ active: false, state: "starting" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(watcher.getStatus()).toMatchObject({
      active: false, state: "starting", indexMayBeStale: true,
      readinessDelayed: true, restartAttempts: 0, lastError: null,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(instances).toHaveLength(1);
    expect(FSWatcher.prototype.close).not.toHaveBeenCalled();
    instances[0].emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(graph.build).toHaveBeenCalledWith({ strict: true });
    expect(watcher.getStatus()).toMatchObject({
      active: true, state: "healthy", indexMayBeStale: false, readinessDelayed: false,
    });
  });

  it("allows a slow replacement scan without consuming more retry attempts", async () => {
    await begin();
    instances[0].emit("error", error("EBUSY"));
    await vi.advanceTimersByTimeAsync(1000 + 60_000);
    expect(watcher.getStatus()).toMatchObject({
      state: "recovering", restartAttempts: 1, readinessDelayed: true,
    });
    expect(instances).toHaveLength(2);
    expect(FSWatcher.prototype.close).toHaveBeenCalledTimes(1);
    instances[1].emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getStatus().state).toBe("healthy");
  });

  it("waits for a long background graph build rather than disabling the watcher", async () => {
    await begin();
    const building = vi.spyOn(graph, "building", "get").mockReturnValue(true);
    instances[0].emit("error", error("EBUSY"));
    await vi.advanceTimersByTimeAsync(1000);
    instances[1].emit("ready");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(graph.build).not.toHaveBeenCalled();
    expect(watcher.getStatus()).toMatchObject({ state: "recovering", indexMayBeStale: true });
    building.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(watcher.getStatus()).toMatchObject({ state: "healthy", indexMayBeStale: false });
  });

  it("cancels a slow initial scan and ignores its late ready after stop", async () => {
    watcher.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await watcher.stop();
    instances[0].emit("ready");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(graph.build).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    expect(watcher.getStatus()).toMatchObject({ state: "stopped", readinessDelayed: false });
  });

  it("stops pending retries and ignores late events", async () => {
    await begin();
    instances[0].emit("error", error("EBUSY"));
    await watcher.stop();
    instances[0].emit("ready");
    instances[0].emit("change", join(root, "note.md"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
    expect(graph.updateNote).not.toHaveBeenCalled();
    expect(watcher.getStatus()).toMatchObject({ active: false, state: "stopped", pendingUpdates: 0 });
  });

  it("does not report healthy when the catch-up rebuild fails", async () => {
    await begin();
    vi.mocked(graph.build).mockRejectedValueOnce(new Error("rebuild failed"));
    instances[0].emit("error", error("EBUSY"));
    await vi.advanceTimersByTimeAsync(1000);
    instances[1].emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getStatus()).toMatchObject({
      active: false, state: "degraded", indexMayBeStale: true,
      lastError: { message: "rebuild failed" },
    });
  });

  it("handles rejected note updates without an unhandled rejection", async () => {
    await begin();
    vi.mocked(graph.updateNote).mockRejectedValueOnce(error("EBUSY"));
    instances[0].emit("change", join(root, "note.md"));
    await vi.advanceTimersByTimeAsync(300);
    expect(watcher.getStatus()).toMatchObject({
      state: "recovering", indexMayBeStale: true, lastError: { code: "EBUSY" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    instances[1].emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getStatus().state).toBe("healthy");
  });

  it("keeps MCP health calls usable and exposes degradation after a watcher error", async () => {
    await begin();
    vi.useRealTimers();
    const server = new McpServer({ name: "watcher-test", version: "1" });
    const client = new Client({ name: "watcher-test", version: "1" });
    registerCoreTools(server, root, graph, cache, watcher, DEFAULT_CONFIG);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      instances[0].emit("error", new Error("fixture failure"));
      const result = await client.callTool({ name: "get_health", arguments: {} });
      expect(result).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining('"state": "degraded"') }],
      });
      expect(result).toMatchObject({
        content: [{ text: expect.stringContaining('"indexMayBeStale": true') }],
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
