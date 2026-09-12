/** Process-owned cleanup. Stdio EOF is a client disconnect, not an idle timeout. */
export function installShutdownHandlers(options: {
  stdio: boolean;
  cleanup: () => Promise<void>;
  timeoutMs?: number;
}): { isShuttingDown: () => boolean; shutdown: (reason: string, code?: number) => void } {
  let stopping = false;

  const shutdown = (reason: string, code = 0): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[OIL] Shutting down: ${reason}`);

    // Keep this referenced: a stalled cleanup must not leave the process alive.
    const deadline = setTimeout(() => {
      console.error("[OIL] Shutdown timed out; forcing exit.");
      process.exit(1);
    }, options.timeoutMs ?? 5000);

    Promise.resolve().then(options.cleanup).then(
      () => {
        clearTimeout(deadline);
        process.exit(code);
      },
      (error: unknown) => {
        console.error("[OIL] Shutdown cleanup failed:", error);
        clearTimeout(deadline);
        process.exit(1);
      },
    );
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  if (options.stdio) {
    process.stdin.once("end", () => shutdown("stdin ended"));
    process.stdin.once("close", () => shutdown("stdin closed"));
    process.stdin.once("error", () => shutdown("stdin error", 1));
    process.stdout.once("error", () => shutdown("stdout error", 1));
    // Do not resume stdin here: the MCP transport must install its data handler
    // first, otherwise an initialize request arriving during indexing is lost.
    if (process.stdin.destroyed || process.stdin.readableEnded) {
      shutdown("stdin already closed");
    }
  }

  return { isShuttingDown: () => stopping, shutdown };
}
