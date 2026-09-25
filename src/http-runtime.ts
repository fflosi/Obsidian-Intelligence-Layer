import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphIndex } from "./graph.js";
import { SessionCache } from "./cache.js";
import { VaultWatcher } from "./watcher.js";
import { registerCoreTools } from "./tools/core.js";
import { registerRetrieveTools } from "./tools/retrieve.js";
import { registerWriteTools } from "./tools/write.js";
import { registerDomainTools } from "./tools/domain.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { ToolAccess, type RuntimeStatus } from "./runtime-state.js";
import type { OilConfig } from "./types.js";
import type { SessionServer } from "./http-server.js";

/** Shared vault state, independent of the listener and of individual clients. */
export class HttpRuntime {
  readonly graph: GraphIndex;
  readonly watcher: VaultWatcher;
  readonly tools = new ToolAccess(() => this.status());
  private phase: "initializing" | "ready" | "failed" | "stopping" = "initializing";
  private initialization?: Promise<void>;
  private vaultProbe?: NodeJS.Timeout;
  private probing = false;
  private probeWork: Promise<void> = Promise.resolve();

  constructor(private readonly vaultPath: string, private readonly config: OilConfig) {
    this.graph = new GraphIndex(vaultPath);
    this.watcher = new VaultWatcher(vaultPath, this.graph);
  }

  status(): RuntimeStatus {
    if (this.phase !== "ready") {
      return {
        state: this.phase,
        ready: false,
        reason: this.phase === "failed"
          ? "Vault initialization/access failed. Inspect service logs and restart after correction."
          : `Service is ${this.phase}.`,
      };
    }
    const watcher = this.watcher.getStatus();
    if (this.graph.building || !watcher.active || watcher.indexMayBeStale) {
      return { state: "degraded", ready: false, reason: "Index or watcher is not current; check get_health." };
    }
    return { state: "ready", ready: true };
  }

  createSession(): SessionServer {
    const cache = new SessionCache();
    this.watcher.registerCache(cache);
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerCoreTools(server, this.vaultPath, this.graph, cache, this.watcher, this.config, () => this.status());
    registerRetrieveTools(server, this.vaultPath, this.graph, cache, this.config, this.tools);
    registerWriteTools(server, this.vaultPath, this.graph, cache, this.config, this.tools);
    registerDomainTools(server, this.vaultPath, this.graph, cache, this.config, this.tools);
    return { server, dispose: () => { this.watcher.unregisterCache(cache); cache.clear(); } };
  }

  initialize(): Promise<void> {
    if (this.phase === "stopping") return Promise.resolve();
    this.initialization ??= this.build();
    return this.initialization;
  }

  private async build(): Promise<void> {
    try {
      // The listener is already serving initialize/tools/list/get_health.
      // Strict parsing avoids advertising a partially indexed vault as ready.
      // Watch before scanning so edits made during startup are not lost.
      this.watcher.start();
      await this.graph.buildIncremental(this.config.search.graphIndexFile, { strict: true });
      if (this.phase === "stopping") return;
      this.phase = "ready";
      this.vaultProbe = setInterval(() => {
        if (this.probing || this.phase !== "ready") return;
        this.probing = true;
        this.probeWork = this.checkVaultAccess().finally(() => { this.probing = false; });
      }, 5000);
      this.vaultProbe.unref();
    } catch (error) {
      if (this.phase !== "stopping") this.phase = "failed";
      console.error("[OIL] HTTP vault initialization failed:", error);
    }
  }

  async checkVaultAccess(): Promise<void> {
    try {
      if (!(await stat(this.vaultPath)).isDirectory()) throw new Error("Vault is not a directory.");
      await access(this.vaultPath, constants.R_OK | constants.W_OK);
    } catch (error) {
      if (this.phase === "stopping") return;
      this.phase = "failed";
      console.error("[OIL] Vault became unavailable; restart after correcting access:", error);
    }
  }

  beginStop(): void {
    this.phase = "stopping";
    if (this.vaultProbe) clearInterval(this.vaultProbe);
  }

  async stop(): Promise<void> {
    this.beginStop();
    await Promise.all([this.initialization, this.probeWork, this.tools.drain()]);
    await this.watcher.stop();
  }
}
