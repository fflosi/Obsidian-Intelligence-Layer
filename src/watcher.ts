/**
 * OIL — File watcher
 * Monitors the vault for changes and triggers incremental graph index updates.
 */

import { watch, type FSWatcher } from "chokidar";
import { relative } from "node:path";
import { isAllowedFile } from "./vault.js";
import type { GraphIndex } from "./graph.js";
import type { SessionCache } from "./cache.js";
import { invalidateSearchIndex } from "./search.js";

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
    if (this.watcher) return;

    this.watcher = watch(this.vaultPath, {
      ignored: [
        /(^|[/\\])\../, // dotfiles/dirs
        "**/node_modules/**",
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher
      .on("add", (fullPath) => this.handleChange(fullPath, "add"))
      .on("change", (fullPath) => this.handleChange(fullPath, "change"))
      .on("unlink", (fullPath) => this.handleChange(fullPath, "unlink"));
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    // Clear any pending debounced updates
    for (const timer of this.pendingUpdates.values()) {
      clearTimeout(timer);
    }
    this.pendingUpdates.clear();
  }

  getStatus(): {
    backend: "chokidar";
    active: boolean;
    pendingUpdates: number;
  } {
    return {
      backend: "chokidar",
      active: this.watcher !== null,
      pendingUpdates: this.pendingUpdates.size,
    };
  }

  /**
   * Handle a file change event with debouncing.
   */
  private handleChange(
    fullPath: string,
    event: "add" | "change" | "unlink",
  ): void {
    if (!isAllowedFile(fullPath)) return;

    const notePath = relative(this.vaultPath, fullPath);

    // Cancel any pending update for this path
    const existing = this.pendingUpdates.get(notePath);
    if (existing) clearTimeout(existing);

    // Debounce the update
    const timer = setTimeout(() => {
      this.pendingUpdates.delete(notePath);
      this.processChange(notePath, event);
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
