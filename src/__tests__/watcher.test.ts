/**
 * Tests for watcher.ts — VaultWatcher: start/stop, debounced file change handling.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { FSWatcher } from "chokidar";
import { VaultWatcher } from "../watcher.js";
import { GraphIndex } from "../graph.js";
import { SessionCache } from "../cache.js";
import { mkdtemp, realpath, rm, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let vaultRoot: string;

beforeAll(async () => {
  // libuv on Windows can assert when a watcher is opened through an 8.3 short
  // temp path but events arrive with the long path. Canonicalize the root so
  // the watched directory and event filenames use the same representation.
  tempDir = await mkdtemp(join(await realpath(tmpdir()), "oil-watcher-"));
  vaultRoot = join(tempDir, "vault");
  await mkdir(join(vaultRoot, "notes"), { recursive: true });

  await writeFile(
    join(vaultRoot, "notes/existing.md"),
    `---\ntags: [note]\n---\n# Existing\n`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("VaultWatcher — lifecycle", () => {
  it("starts and stops without error", async () => {
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    const watcher = new VaultWatcher(vaultRoot, graph, cache);

    watcher.start();
    // Double-start should be a no-op
    watcher.start();
    await watcher.stop();
  });

  it("stop is safe when not started", async () => {
    const graph = new GraphIndex(vaultRoot);
    await graph.build();
    const cache = new SessionCache();
    const watcher = new VaultWatcher(vaultRoot, graph, cache);
    await watcher.stop(); // Should not throw
  });
});

describe("VaultWatcher — file change detection", () => {
  let graph: GraphIndex;
  let cache: SessionCache;
  let watcher: VaultWatcher;

  afterEach(async () => {
    if (watcher) await watcher.stop();
    vi.restoreAllMocks();
  });

  it("detects new file and updates graph", { retry: 2 }, async () => {
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();

    watcher = new VaultWatcher(vaultRoot, graph, cache);
    watcher.start();

    // Give chokidar time to initialize the watcher
    await new Promise((r) => setTimeout(r, 500));

    const initialCount = graph.nodeCount;

    // Create a new file
    await writeFile(
      join(vaultRoot, "notes/new-note.md"),
      `---\ntags: [new]\n---\n# New Note\n`,
      "utf-8",
    );

    // Poll for graph update (chokidar timing varies by platform)
    let detected = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (graph.nodeCount > initialCount) {
        detected = true;
        break;
      }
    }
    expect(detected).toBe(true);

    // Clean up
    await unlink(join(vaultRoot, "notes/new-note.md"));
    await new Promise((r) => setTimeout(r, 600));
  });

  it("removes from graph when called directly after file unlink", async () => {
    // Create a file first
    await writeFile(
      join(vaultRoot, "notes/to-delete.md"),
      `---\ntags: [temp]\n---\n# To Delete\n`,
      "utf-8",
    );

    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    watcher = new VaultWatcher(vaultRoot, graph, cache);

    expect(graph.getNode("notes/to-delete.md")).toBeDefined();

    // Simulate what the watcher would do on unlink:
    // removeNote from graph and invalidate cache
    cache.putNote("notes/to-delete.md", { path: "notes/to-delete.md", frontmatter: {}, content: "", sections: new Map(), rawContent: "" } as any);
    graph.removeNote("notes/to-delete.md");
    cache.invalidateNote("notes/to-delete.md");

    expect(graph.getNode("notes/to-delete.md")).toBeUndefined();
    expect(cache.getNote("notes/to-delete.md")).toBeUndefined();

    // Clean up
    await unlink(join(vaultRoot, "notes/to-delete.md")).catch(() => {});
  });

  it("invalidates cache on file change", async () => {
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();

    // Cache a note
    cache.putNote("notes/existing.md", { path: "notes/existing.md", frontmatter: {}, content: "old", sections: new Map(), rawContent: "" } as any);

    watcher = new VaultWatcher(vaultRoot, graph, cache);
    watcher.start();

    // Give chokidar time to initialize
    await new Promise((r) => setTimeout(r, 500));

    // Modify the file
    await writeFile(
      join(vaultRoot, "notes/existing.md"),
      `---\ntags: [note]\n---\n# Existing\nUpdated content.\n`,
      "utf-8",
    );

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 1500));

    // Cache should be invalidated
    expect(cache.getNote("notes/existing.md")).toBeUndefined();

    // Restore
    await writeFile(
      join(vaultRoot, "notes/existing.md"),
      `---\ntags: [note]\n---\n# Existing\n`,
      "utf-8",
    );
    await new Promise((r) => setTimeout(r, 600));
  });

  it("ignores non-markdown files", async () => {
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    watcher = new VaultWatcher(vaultRoot, graph, cache);
    watcher.start();

    const before = graph.nodeCount;

    // Create a non-markdown file
    await writeFile(join(vaultRoot, "notes/data.json"), '{"key": "value"}', "utf-8");
    await new Promise((r) => setTimeout(r, 1000));

    expect(graph.nodeCount).toBe(before);

    // Clean up
    await unlink(join(vaultRoot, "notes/data.json"));
    await new Promise((r) => setTimeout(r, 600));
  });

  it("does not watch lock artifacts and catches up changes missed during recovery", async () => {
    graph = new GraphIndex(vaultRoot);
    await graph.build();
    cache = new SessionCache();
    const lockPath = join(vaultRoot, "notes/operation.lock");
    const missedPath = join(vaultRoot, "notes/missed.md");
    await writeFile(lockPath, "fixture lock - not a note");
    const add = vi.spyOn(FSWatcher.prototype, "add");
    vi.spyOn(console, "error").mockImplementation(() => {});
    watcher = new VaultWatcher(vaultRoot, graph, cache);
    watcher.start();
    try {
      await expect.poll(() => watcher.getStatus().state, { timeout: 10000 }).toBe("healthy");
      const fsWatcher: FSWatcher = add.mock.results[0].value;
      const watchedNames = Object.values(fsWatcher.getWatched()).flat();
      expect(watchedNames).not.toContain("operation.lock");
      expect(watchedNames).toContain("existing.md");
      fsWatcher.emit("error", Object.assign(new Error("fixture locked file"), { code: "EBUSY" }));
      expect(watcher.getStatus().indexMayBeStale).toBe(true);
      await writeFile(missedPath, "# Missed during restart\n");
      await expect.poll(() => watcher.getStatus().state, { timeout: 15000 }).toBe("healthy");
      expect(graph.getNode("notes/missed.md")).toBeDefined();
      expect(watcher.getStatus().indexMayBeStale).toBe(false);
      await writeFile(missedPath, "# Updated after restart\n");
      await expect.poll(() => graph.getNode("notes/missed.md")?.title, { timeout: 10000 })
        .toBe("Updated after restart");
    } finally {
      await watcher.stop();
      await rm(lockPath, { force: true });
      await rm(missedPath, { force: true });
    }
  });
});
