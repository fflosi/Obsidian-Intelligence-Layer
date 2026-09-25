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
import { installShutdownHandlers } from "./shutdown.js";

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

  const httpPortRaw = process.env.OIL_HTTP_PORT;
  const httpPort = httpPortRaw ? Number.parseInt(httpPortRaw, 10) : undefined;
  const useHttp = httpPort !== undefined && !Number.isNaN(httpPort);
  let watcher: VaultWatcher | undefined;
  let stdioSession: SessionServer | undefined;
  let backgroundWork: Promise<void> = Promise.resolve();
  const lifecycle = installShutdownHandlers({
    stdio: !useHttp,
    cleanup: async () => {
      const results = await Promise.allSettled([
        watcher?.stop(),
        stdioSession?.server.close(),
        backgroundWork,
      ]);
      stdioSession?.dispose();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  });
  if (lifecycle.isShuttingDown()) return;

  console.error(`[OIL] Starting — vault: ${vaultPath}`);

  // ── 1. Load configuration ──────────────────────────────────────────────
  console.error("[OIL] Loading configuration...");
  const config = await loadConfig(vaultPath);
  if (lifecycle.isShuttingDown()) return;
  console.error("[OIL] Configuration loaded.");

  // ── 2. Build graph index (with persistence + background indexing) ─────
  const graph = new GraphIndex(vaultPath);
  const graphFile = config.search.graphIndexFile;

  const loaded = await graph.loadFromDisk(graphFile);
  if (lifecycle.isShuttingDown()) return;
  if (loaded) {
    // Persisted index loaded — start incremental rebuild in background
    const stats = graph.getStats();
    console.error(
      `[OIL] Graph loaded from disk — ${stats.noteCount} notes. Incremental update in background.`,
    );
    setImmediate(() => {
      if (lifecycle.isShuttingDown()) return;
      backgroundWork = graph.buildIncremental(graphFile).then(() => {}).catch((err) => {
        console.error("[OIL] Background incremental rebuild failed:", err);
      });
    });
  } else {
    // No persisted index — full build, with background fallback if slow
    console.error("[OIL] No persisted graph index — full build...");
    const startTime = Date.now();
    await graph.build();
    if (lifecycle.isShuttingDown()) return;
    const elapsed = Date.now() - startTime;
    const stats = graph.getStats();
    console.error(
      `[OIL] Graph index built in ${elapsed}ms — ${stats.noteCount} notes, ${stats.linkCount} links, ${stats.tagCount} tags.`,
    );
    // Track persistence for lifecycle cleanup and await it before serving: an
    // early shutdown would otherwise force another full rebuild next startup.
    backgroundWork = graph.saveToDisk(graphFile).catch((err) =>
      console.error("[OIL] Failed to save graph index:", err),
    );
    await backgroundWork;
    if (lifecycle.isShuttingDown()) return;
  }

  // ── 3. Initialise session cache ────────────────────────────────────────
  // (In HTTP mode each MCP session gets its own cache; the watcher is created
  //  without an initial cache and per-session caches register themselves.)

  // ── 4. Start file watcher (shared across all sessions) ─────────────────
  watcher = new VaultWatcher(vaultPath, graph);
  const activeWatcher = watcher;
  watcher.start();
  console.error("[OIL] File watcher started.");

  // ── 5. Per-session MCP server factory ──────────────────────────────────
  // The expensive state above (config, graph, watcher) is built once and
  // shared. Each MCP session gets a lightweight McpServer + its own
  // SessionCache so the write-gate pendingWrites queue stays isolated.
  const createSessionServer = (): SessionServer => {
    const cache = new SessionCache();
    activeWatcher.registerCache(cache);

    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });

    // Core visibility tool
    registerCoreTools(server, vaultPath, graph, cache, activeWatcher, config);
    // Optimized retrieve/search tools
    registerRetrieveTools(server, vaultPath, graph, cache, config);
    // Atomic write tools with mtime concurrency checks
    registerWriteTools(server, vaultPath, graph, cache, config);
    // High-value domain tools (deterministic assembly, CRM prefetch, health)
    registerDomainTools(server, vaultPath, graph, cache, config);

    return {
      server,
      dispose: () => activeWatcher.unregisterCache(cache),
    };
  };

  console.error("[OIL] Tools registered.");

  // ── 6. Connect transport ───────────────────────────────────────────────
  // OIL_HTTP_PORT switches to a shared Streamable HTTP server (one process
  // serves every session). Unset -> classic per-process stdio (default).
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
    stdioSession = createSessionServer();
    const { server } = stdioSession;
    server.server.onclose = () => lifecycle.shutdown("MCP transport closed");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    if (lifecycle.isShuttingDown()) return;
    console.error("[OIL] MCP server ready (stdio).");
  }
}

main().catch((err) => {
  console.error("[OIL] Fatal error:", err);
  process.exit(1);
});
