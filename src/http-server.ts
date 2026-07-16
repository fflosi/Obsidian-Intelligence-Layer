/**
 * OIL — Streamable HTTP transport server.
 *
 * Exposes the OIL MCP server over Streamable HTTP so that ONE long-lived OIL
 * process serves every Copilot/Scout session, instead of each session spawning
 * its own stdio child. The expensive shared state (config, graph index, file
 * watcher) is built once by the caller; this module creates a lightweight
 * per-session `McpServer` + `SessionCache` on each MCP `initialize`, and routes
 * subsequent requests to it by `mcp-session-id`.
 *
 * Uses Node's built-in `http` server (no express dependency).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A freshly-built MCP server bound to a per-session cache. */
export interface SessionServer {
  server: McpServer;
  /** Release per-session resources (e.g. unregister the cache from the watcher). */
  dispose: () => void;
}

export interface HttpServerOptions {
  port: number;
  path: string;
  host: string;
  /** Factory invoked once per new MCP session. */
  createSessionServer: () => SessionServer;
}

/** Collect and JSON-parse a request body. Returns undefined for an empty body. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function badRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/**
 * Start the Streamable HTTP server. Resolves once it is listening.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<void> {
  // sessionId -> transport. Each entry is one connected MCP client session,
  // all served from this single process against the shared graph/watcher.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // Lightweight health probe for startup scripts / monitoring.
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        return;
      }

      if (url.pathname !== opts.path) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        const body = await readBody(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
          // Only a fresh `initialize` may open a new session.
          if (!isInitializeRequest(body)) {
            badRequest(res, "Bad Request: No valid session ID");
            return;
          }

          const session = opts.createSessionServer();
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, newTransport);
            },
          });
          newTransport.onclose = () => {
            const sid = newTransport.sessionId;
            if (sid) transports.delete(sid);
            try {
              session.dispose();
            } catch {
              // best-effort cleanup
            }
          };
          await session.server.connect(newTransport);
          transport = newTransport;
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid or missing session ID");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { "Content-Type": "text/plain" }).end("Method Not Allowed");
    } catch (err) {
      console.error("[OIL] HTTP handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });
}
