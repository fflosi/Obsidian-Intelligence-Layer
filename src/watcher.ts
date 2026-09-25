/**
 * OIL — File watcher
 * Monitors the vault for changes and triggers incremental graph index updates.
 */

import { FSWatcher } from "chokidar";
import type { Stats } from "node:fs";
import { relative } from "node:path";
import { isAllowedFile } from "./vault.js";
import { normalizeNotePath, type GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import { invalidateSearchIndex } from "./search.js";

type WatcherState = "stopped" | "starting" | "healthy" | "recovering" | "degraded";
const MAX_RESTARTS = 3;
const READY_WARNING_MS = 30_000;
const RETRYABLE_ERRORS = new Set(["EBUSY", "EPERM", "EACCES", "ENOENT", "EMFILE", "ENFILE", "ENOSPC"]);

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private vaultPath: string;
  private graph: GraphIndex;
  /**
   * Session caches to invalidate on file change. In stdio mode this holds a
   * single cache; in HTTP mode each connected MCP session registers its own
   * cache so the one shared watcher fans invalidations to all of them.
   */
  private caches = new Set<SessionCache>();

  /** Debounce timer for batching rapid changes */
  private pendingUpdates = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs = 300;
  private running = false;
  private generation = 0;
  private state: WatcherState = "stopped";
  private restartAttempts = 0;
  private lastError: { code: string; message: string; at: string } | null = null;
  private indexMayBeStale = false;
  private readinessDelayed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private closing: Promise<void> = Promise.resolve();
  private updates: Promise<void> = Promise.resolve();

  constructor(
    vaultPath: string,
    graph: GraphIndex,
    cache?: SessionCache,
  ) {
    this.vaultPath = vaultPath;
    this.graph = graph;
    if (cache) this.caches.add(cache);
  }

  /** Register a session cache to receive file-change invalidations. */
  registerCache(cache: SessionCache): void {
    this.caches.add(cache);
  }

  /** Stop invalidating a session cache (call when its MCP session closes). */
  unregisterCache(cache: SessionCache): void {
    this.caches.delete(cache);
  }

  /**
   * Start watching the vault for file changes.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.restartAttempts = 0;
    this.openWatcher(this.indexMayBeStale);
  }

  private shouldIgnore(fullPath: string): boolean {
    const rel = normalizeNotePath(relative(this.vaultPath, fullPath));
    if (rel === "") return false;
    if (rel.startsWith("../")) return true;
    return rel
      .split("/")
      .some((part) => part.startsWith(".") || part.toLowerCase() === "node_modules");
  }

  private ignorePath(fullPath: string, stats?: Stats): boolean {
    if (this.shouldIgnore(fullPath)) return true;
    const parts = normalizeNotePath(relative(this.vaultPath, fullPath)).split("/");
    // Exclude lock artifacts even on Chokidar's first call, before stat/watch.
    if (parts.some((part) => /\.lock$/i.test(part))) return true;
    // Directories must remain traversable; filter other files by the vault contract.
    return stats?.isFile() === true && !isAllowedFile(fullPath);
  }

  private openWatcher(recovering: boolean): void {
    const generation = ++this.generation;
    this.state = recovering ? "recovering" : "starting";
    this.readinessDelayed = false;
    const watcher = new FSWatcher({
      ignored: (fullPath, stats) => this.ignorePath(fullPath, stats),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });
    this.watcher = watcher;
    const current = () => this.running && generation === this.generation;
    // Attach error handling BEFORE add() starts filesystem work.
    watcher
      .on("error", (error) => { if (current()) this.handleFailure(error); })
      .on("add", (fullPath) => { if (current()) this.handleChange(fullPath, "add"); })
      .on("change", (fullPath) => { if (current()) this.handleChange(fullPath, "change"); })
      .on("unlink", (fullPath) => { if (current()) this.handleChange(fullPath, "unlink"); })
      .once("ready", () => {
        if (!current()) return;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.readinessDelayed = false;
        if (!recovering && !this.indexMayBeStale) {
          this.state = "healthy";
          return;
        }
        this.state = "recovering";
        this.enqueue(async () => {
          // The startup incremental build is owned by index.ts, outside our queue.
          // A large or hydrated-on-demand vault can legitimately take minutes.
          while (this.graph.building) {
            if (!current()) return;
            await new Promise((done) => setTimeout(done, 100));
          }
          if (!current()) return;
          await this.graph.build({ strict: true });
          this.clearReadCaches();
          if (!current()) return;
          this.indexMayBeStale = false;
          this.state = "healthy";
          console.error("[OIL] Watcher recovered; catch-up index rebuild completed.");
        }, generation);
      });
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (!current()) return;
      this.readinessDelayed = true;
      this.indexMayBeStale = true;
      this.clearReadCaches();
      // Slowness is not a filesystem error. Keep the same watcher scanning so
      // its eventual ready event can trigger catch-up without a restart loop.
      console.error("[OIL] Watcher initial scan is taking longer than 30 seconds; still waiting for ready.");
    }, READY_WARNING_MS);
    try {
      watcher.add(this.vaultPath);
    } catch (error) {
      this.handleFailure(error);
    }
  }

  private clearReadCaches(): void {
    for (const cache of this.caches) cache.clear(); // Keeps pending write confirmations.
    invalidateSearchIndex();
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.retryTimer = null;
    this.readyTimer = null;
    for (const timer of this.pendingUpdates.values()) clearTimeout(timer);
    this.pendingUpdates.clear();
  }

  private recordError(error: unknown): string {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code : "UNKNOWN";
    this.lastError = {
      code,
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    console.error(`[OIL] Watcher error (${code}): ${this.lastError.message}`);
    return code;
  }

  private handleFailure(error: unknown): void {
    const code = this.recordError(error);
    this.indexMayBeStale = true;
    this.clearReadCaches();
    this.clearTimers();
    const watcher = this.watcher;
    this.watcher = null;
    const generation = ++this.generation;
    const retry = this.running && RETRYABLE_ERRORS.has(code) &&
      this.restartAttempts < MAX_RESTARTS;
    this.state = retry ? "recovering" : "degraded";
    if (retry) this.restartAttempts++;
    // A failed watcher must close before replacing it; never accumulate watchers.
    this.closing = Promise.resolve().then(() => watcher?.close()).then(() => {
      if (!this.running || generation !== this.generation) return;
      if (!retry) {
        console.error("[OIL] Watcher degraded; index may be stale. Restart OIL after resolving the error.");
        return;
      }
      const delay = 1000 * 2 ** (this.restartAttempts - 1);
      console.error(`[OIL] Retrying watcher ${this.restartAttempts}/${MAX_RESTARTS} in ${delay}ms.`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.running && generation === this.generation) this.openWatcher(true);
      }, delay);
    }).catch((closeError: unknown) => {
      this.recordError(closeError);
      if (this.running && generation === this.generation) this.state = "degraded";
      console.error("[OIL] Could not close failed watcher; automatic restart cancelled.");
    });
  }

  private enqueue(operation: () => Promise<void>, generation = this.generation): void {
    this.updates = this.updates.then(async () => {
      if (!this.running || generation !== this.generation) return;
      await operation();
    }).catch((error: unknown) => {
      if (this.running && generation === this.generation) this.handleFailure(error);
      else console.error("[OIL] Watcher update failed during shutdown/replacement:", error);
    });
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    this.running = false;
    ++this.generation;
    this.state = "stopped";
    this.readinessDelayed = false;
    const watcher = this.watcher;
    this.watcher = null;
    this.clearTimers();
    await Promise.all([watcher?.close(), this.closing, this.updates]);
  }

  getStatus(): {
    backend: "chokidar";
    active: boolean;
    pendingUpdates: number;
    state: WatcherState;
    restartAttempts: number;
    indexMayBeStale: boolean;
    readinessDelayed: boolean;
    lastError: { code: string; message: string; at: string } | null;
  } {
    return {
      backend: "chokidar",
      active: this.state === "healthy" && this.watcher !== null,
      pendingUpdates: this.pendingUpdates.size,
      state: this.state,
      restartAttempts: this.restartAttempts,
      indexMayBeStale: this.indexMayBeStale,
      readinessDelayed: this.readinessDelayed,
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }

  /**
   * Handle a file change event with debouncing.
   */
  private handleChange(
    fullPath: string,
    event: "add" | "change" | "unlink",
  ): void {
    if (!this.watcher) return;
    if (!isAllowedFile(fullPath)) return;

    // `relative()` yields backslashes on Windows; the graph and session cache
    // are both keyed on POSIX-style vault paths, so normalize before dispatch.
    const notePath = normalizeNotePath(relative(this.vaultPath, fullPath));

    // Cancel any pending update for this path
    const existing = this.pendingUpdates.get(notePath);
    if (existing) clearTimeout(existing);

    // Debounce the update
    const timer = setTimeout(() => {
      this.pendingUpdates.delete(notePath);
      this.enqueue(() => this.processChange(notePath, event));
    }, this.debounceMs);

    this.pendingUpdates.set(notePath, timer);
  }

  /**
   * Process a debounced file change.
   */
  private async processChange(
    notePath: string,
    event: "add" | "change" | "unlink",
  ): Promise<void> {
    const generation = this.generation;
    while (this.graph.building) {
      if (!this.running || generation !== this.generation) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!this.running || generation !== this.generation) return;
    // Invalidate session caches first (always safe)
    for (const cache of this.caches) {
      cache.invalidateNote(notePath);
    }

    if (event === "unlink") {
      this.graph.removeNote(notePath);
    } else {
      // add or change — re-index the note
      await this.graph.updateNote(notePath);
    }

    // Invalidate search index AFTER graph is current,
    // so rebuilt index reflects the updated node data.
    invalidateSearchIndex();
  }
}
