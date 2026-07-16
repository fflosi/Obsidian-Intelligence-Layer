/**
 * OIL — MCP Server
 * Obsidian Intelligence Layer server entry point.
 * Startup sequence: config → graph index → file watcher → session cache → tools → ready.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { GraphIndex } from "./graph.js";
import { SessionCache } from "./cache.js";
import { VaultWatcher } from "./watcher.js";
import { registerCoreTools } from "./tools/core.js";
import { registerRetrieveTools } from "./tools/retrieve.js";
import { registerWriteTools } from "./tools/write.js";
import { registerDomainTools } from "./tools/domain.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { startHttpServer, type SessionServer } from "./http-server.js";

async function main(): Promise<void> {
  // ── Resolve vault path ─────────────────────────────────────────────────
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error(
      "Error: OBSIDIAN_VAULT_PATH environment variable is required.\n" +
        "Set it to the absolute path of your Obsidian vault.",
    );
    process.exit(1);
  }

  console.error(`[OIL] Starting — vault: ${vaultPath}`);

  // ── 1. Load configuration ──────────────────────────────────────────────
  console.error("[OIL] Loading configuration...");
  const config = await loadConfig(vaultPath);
  console.error("[OIL] Configuration loaded.");

  // ── 2. Build graph index (with persistence + background indexing) ─────
  const graph = new GraphIndex(vaultPath);
  const graphFile = config.search.graphIndexFile;
  const bgThreshold = config.search.backgroundIndexThresholdMs;

  const loaded = await graph.loadFromDisk(graphFile);
  if (loaded) {
    // Persisted index loaded — start incremental rebuild in background
    const stats = graph.getStats();
    console.error(
      `[OIL] Graph loaded from disk — ${stats.noteCount} notes. Incremental update in background.`,
    );
    setImmediate(async () => {
      try {
        await graph.buildIncremental(graphFile);
      } catch (err) {
        console.error("[OIL] Background incremental rebuild failed:", err);
      }
    });
  } else {
    // No persisted index — full build, with background fallback if slow
    console.error("[OIL] No persisted graph index — full build...");
    const startTime = Date.now();
    await graph.build();
    const elapsed = Date.now() - startTime;
    const stats = graph.getStats();
    console.error(
      `[OIL] Graph index built in ${elapsed}ms — ${stats.noteCount} notes, ${stats.linkCount} links, ${stats.tagCount} tags.`,
    );
    // Save to disk for next startup
    graph.saveToDisk(graphFile).catch((err) =>
      console.error("[OIL] Failed to save graph index:", err),
    );
  }

  // ── 3. Initialise session cache ────────────────────────────────────────
  // (In HTTP mode each MCP session gets its own cache; the watcher is created
  //  without an initial cache and per-session caches register themselves.)

  // ── 4. Start file watcher (shared across all sessions) ─────────────────
  const watcher = new VaultWatcher(vaultPath, graph);
  watcher.start();
  console.error("[OIL] File watcher started.");

  // ── 5. Per-session MCP server factory ──────────────────────────────────
  // The expensive state above (config, graph, watcher) is built once and
  // shared. Each MCP session gets a lightweight McpServer + its own
  // SessionCache so the write-gate pendingWrites queue stays isolated.
  const createSessionServer = (): SessionServer => {
    const cache = new SessionCache();
    watcher.registerCache(cache);

    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });

    // Core visibility tool
    registerCoreTools(server, vaultPath, graph, cache, watcher, config);
    // Optimized retrieve/search tools
    registerRetrieveTools(server, vaultPath, graph, cache, config);
    // Atomic write tools with mtime concurrency checks
    registerWriteTools(server, vaultPath, graph, cache, config);
    // High-value domain tools (deterministic assembly, CRM prefetch, health)
    registerDomainTools(server, vaultPath, graph, cache, config);

    return {
      server,
      dispose: () => watcher.unregisterCache(cache),
    };
  };

  console.error("[OIL] Tools registered.");

  // ── 6. Connect transport ───────────────────────────────────────────────
  // OIL_HTTP_PORT switches to a shared Streamable HTTP server (one process
  // serves every session). Unset -> classic per-process stdio (default).
  const httpPortRaw = process.env.OIL_HTTP_PORT;
  const httpPort = httpPortRaw ? Number.parseInt(httpPortRaw, 10) : undefined;

  if (httpPort !== undefined && !Number.isNaN(httpPort)) {
    const httpPath = process.env.OIL_HTTP_PATH ?? "/mcp";
    const httpHost = process.env.OIL_HTTP_HOST ?? "127.0.0.1";
    await startHttpServer({
      port: httpPort,
      path: httpPath,
      host: httpHost,
      createSessionServer,
    });
    console.error(
      `[OIL] MCP server ready (HTTP) — http://${httpHost}:${httpPort}${httpPath}`,
    );
  } else {
    const { server } = createSessionServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[OIL] MCP server ready (stdio).");
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async () => {
    console.error("[OIL] Shutting down...");
    await watcher.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[OIL] Fatal error:", err);
  process.exit(1);
});
