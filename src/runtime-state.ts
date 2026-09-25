import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResponse, type ToolErrorCode } from "./tool-responses.js";

export interface RuntimeStatus {
  state: "initializing" | "ready" | "degraded" | "failed" | "stopping";
  ready: boolean;
  reason?: string;
}

/** Shared by all HTTP sessions; requests do not queue unbounded expensive work. */
export class ToolAccess {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(
    readonly status: () => RuntimeStatus,
    private readonly maxConcurrent = 4,
  ) {}

  async run<T extends CallToolResult>(work: () => Promise<T>): Promise<T | CallToolResult> {
    const status = this.status();
    if (!status.ready) {
      return this.error("STALE_INDEX", status.reason ?? status.state);
    }
    if (this.active >= this.maxConcurrent) {
      return this.error("LIMIT_EXCEEDED", "Concurrent tool limit reached; retry later.");
    }
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      if (this.active === 0) {
        for (const done of this.waiters.splice(0)) done();
      }
    }
  }

  async drain(): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((done) => this.waiters.push(done));
  }

  private error(code: ToolErrorCode, message: string): CallToolResult {
    return { ...errorResponse(code, message, {}, {
      retryable: true,
      next_step: "Check get_health and retry when the service is ready.",
      suggested_tools: ["get_health"],
    }), isError: true };
  }
}

export function runTool<T extends CallToolResult>(
  access: ToolAccess | undefined,
  work: () => Promise<T>,
): Promise<T | CallToolResult> {
  return access ? access.run(work) : work();
}
