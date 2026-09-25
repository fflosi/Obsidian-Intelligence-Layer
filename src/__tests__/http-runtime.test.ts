import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { HttpRuntime } from "../http-runtime.js";
import { startHttpServer, type HttpServerHandle } from "../http-server.js";
import { DEFAULT_CONFIG } from "../config.js";

let root: string;
let vault: string;
let runtime: HttpRuntime;
let host: HttpServerHandle;
const clients: Client[] = [];
const token = "runtime-test-token-".repeat(3);

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "oil-runtime-"));
  vault = join(root, "vault");
  await mkdir(vault);
  await writeFile(join(vault, "note.md"), "# Fixture\r\n\r\n## Notes\r\noriginal\r\n");
  runtime = new HttpRuntime(vault, DEFAULT_CONFIG);
  host = await startHttpServer({
    port: 0, host: "127.0.0.1", path: "/mcp", token,
    createSessionServer: () => runtime.createSession(),
    readiness: () => runtime.status(),
    drain: () => runtime.tools.drain(),
  });
});
afterEach(async () => {
  runtime.beginStop();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all([host.close(), runtime.stop()]);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function connect() {
  const client = new Client({ name: "runtime-test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}
async function call(client: Client, name: string, args = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const content = result.content[0];
  if (content.type !== "text") throw new Error("Expected text content");
  return { result, payload: JSON.parse(content.text) };
}
async function ready() {
  await runtime.initialize();
  await expect.poll(() => runtime.status().ready, { timeout: 10_000 }).toBe(true);
}

it("initializes MCP and lists all 14 tools while index work is deliberately blocked", async () => {
  const original = runtime.graph.buildIncremental.bind(runtime.graph);
  let release!: () => void;
  const blocked = new Promise<void>((done) => { release = done; });
  vi.spyOn(runtime.graph, "buildIncremental").mockImplementation(async (...args) => {
    await blocked;
    return original(...args);
  });
  const indexing = runtime.initialize();
  try {
    const client = await connect();
    expect((await client.listTools()).tools).toHaveLength(14);
    expect((await call(client, "get_health")).payload.readiness).toMatchObject({
      state: "initializing", ready: false,
    });
    for (const [name, args] of [
      ["search_vault", { query: "Fixture" }],
      ["create_note", { path: "blocked.md", content: "must not be written" }],
      ["get_customer_context", { customer: "Fixture" }],
    ] as const) {
      const response = await call(client, name, args);
      expect(response.result.isError).toBe(true);
      expect(response.payload.error_code).toBe("STALE_INDEX");
    }
    await expect(readFile(join(vault, "blocked.md"))).rejects.toThrow();
  } finally {
    release();
    await indexing;
  }
  await expect.poll(() => runtime.status().ready).toBe(true);
});

it("shares one index build and watcher across clients, preserves writes, and drains cleanly", async () => {
  const build = vi.spyOn(runtime.graph, "buildIncremental");
  const watch = vi.spyOn(runtime.watcher, "start");
  await ready();
  const a = await connect();
  const b = await connect();
  expect(build).toHaveBeenCalledTimes(1);
  expect(watch).toHaveBeenCalledTimes(1);
  const metadata = (await call(a, "get_note_metadata", { path: "note.md" })).payload;
  const write = await call(a, "atomic_append", {
    path: "note.md", heading: "Notes", content: "from client A", expected_mtime: metadata.mtime_ms,
  });
  expect(write.payload.status).toBe("executed");
  const otherRead = await call(b, "read_note_section", { path: "note.md", heading: "Notes" });
  expect(otherRead.payload.content).toContain("from client A");
  const staleWrite = await call(b, "atomic_replace", {
    path: "note.md", content: "stale", expected_mtime: metadata.mtime_ms,
  });
  expect(staleWrite.payload.error_code).toBe("CONFLICT");
  runtime.beginStop();
  expect((await call(b, "search_vault", { query: "Fixture" })).result.isError).toBe(true);
  await Promise.all([host.close(), runtime.stop()]);
  expect(runtime.watcher.getStatus().state).toBe("stopped");
  expect(host.getStats().sessions).toBe(0);
});

it("updates the shared graph for external writes and reports degraded watcher state", async () => {
  await ready();
  const client = await connect();
  await writeFile(join(vault, "new.md"), "# New external note\n");
  await expect.poll(() => runtime.graph.getNode("new.md")?.title, { timeout: 10_000 })
    .toBe("New external note");
  await runtime.watcher.stop();
  expect(runtime.status()).toMatchObject({ state: "degraded", ready: false });
  expect((await call(client, "query_frontmatter", { key: "x", value_fragment: "y" })).result.isError).toBe(true);
  expect((await call(client, "get_health")).payload.readiness.ready).toBe(false);
});

it("captures edits arriving after the scan but before startup persistence finishes", async () => {
  const save = runtime.graph.saveToDisk.bind(runtime.graph);
  let release!: () => void;
  let saving = false;
  const blocked = new Promise<void>((done) => { release = done; });
  vi.spyOn(runtime.graph, "saveToDisk").mockImplementation(async (...args) => {
    saving = true;
    await blocked;
    return save(...args);
  });
  const indexing = runtime.initialize();
  try {
    await expect.poll(() => saving).toBe(true);
    await expect.poll(() => runtime.watcher.getStatus().active).toBe(true);
    await writeFile(join(vault, "late.md"), "# Arrived while saving\n");
  } finally {
    release();
    await indexing;
  }
  await expect.poll(() => runtime.graph.getNode("late.md")?.title, { timeout: 10_000 })
    .toBe("Arrived while saving");
});

it("serves an explicit failed state after index corruption instead of an empty successful query", async () => {
  await writeFile(join(vault, "bad.md"), "---\nbroken: [\n---\n# Malformed");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await runtime.initialize();
  const client = await connect();
  expect(runtime.status()).toMatchObject({ state: "failed", ready: false });
  expect((await call(client, "search_vault", { query: "Fixture" })).result.isError).toBe(true);
  expect((await call(client, "get_health")).payload.readiness.state).toBe("failed");
});

it("does not claim readiness when the vault disappears after startup", async () => {
  await ready();
  await runtime.watcher.stop();
  await rm(vault, { recursive: true, force: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await runtime.checkVaultAccess();
  expect(runtime.status()).toMatchObject({ state: "failed", ready: false });
});

it("cannot restart initialization after stop has begun", async () => {
  const watch = vi.spyOn(runtime.watcher, "start");
  await runtime.stop();
  await runtime.initialize();
  expect(watch).not.toHaveBeenCalled();
  expect(runtime.status()).toMatchObject({ state: "stopping", ready: false });
});

it("uses the persisted index on restart and reconciles missed changes", async () => {
  await ready();
  await runtime.stop();
  await host.close();
  await writeFile(join(vault, "missed.md"), "# Changed offline\n");
  const next = new HttpRuntime(vault, DEFAULT_CONFIG);
  const load = vi.spyOn(next.graph, "loadFromDisk");
  const fullBuild = vi.spyOn(next.graph, "build");
  try {
    await next.initialize();
    await expect.poll(() => next.status().ready).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fullBuild).not.toHaveBeenCalled();
    expect(next.graph.getNode("missed.md")?.title).toBe("Changed offline");
  } finally {
    await next.stop();
  }
});
