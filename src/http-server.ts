import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeStatus } from "./runtime-state.js";

export interface SessionServer {
  server: McpServer;
  dispose: () => void;
}

export interface HttpServerOptions {
  port: number;
  path: string;
  host: string;
  token: string;
  createSessionServer: () => SessionServer;
  readiness: () => RuntimeStatus;
  drain?: () => Promise<void>;
  maxSessions?: number;
  idleTimeoutMs?: number;
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  maxRequests?: number;
  shutdownTimeoutMs?: number;
}

export interface HttpServerHandle {
  url: string;
  getStats: () => { sessions: number; requests: number; closing: boolean };
  close: () => Promise<void>;
}

interface Session {
  owner: SessionServer;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
  inFlight: number;
  disposed: boolean;
  closing?: Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: Error) => { cleanup(); req.pause(); reject(error); };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new HttpError(400, "Request aborted."));
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return fail(new HttpError(413, "Request body too large."));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Expected a single JSON-RPC message.");
        }
        resolve(body);
      } catch {
        reject(new HttpError(400, "Expected a single valid JSON-RPC object."));
      }
    };
    const timer = setTimeout(() => fail(new HttpError(408, "Request body timed out.")), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(status >= 400 ? { Connection: "close" } : {}),
  });
  res.end(JSON.stringify(body));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** A single loopback listener; every MCP session owns its own server and cache. */
export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  if (opts.host !== "127.0.0.1") throw new Error("HTTP host must be 127.0.0.1.");
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(opts.token)) throw new Error("Invalid HTTP token.");
  const maxSessions = opts.maxSessions ?? 64;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? 10_000;
  const maxRequests = opts.maxRequests ?? 32;
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 3000;
  for (const value of [maxSessions, idleTimeoutMs, maxBodyBytes, bodyTimeoutMs, maxRequests, shutdownTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("HTTP limits must be positive integers.");
  }
  const expectedToken = digest(`Bearer ${opts.token}`);
  const sessions = new Map<string, Session>();
  const owned = new Set<Session>();
  let closing = false;
  let requests = 0;
  let endpoint = "";
  let closePromise: Promise<void> | undefined;

  const dispose = (session: Session) => {
    if (session.disposed) return;
    session.disposed = true;
    if (session.transport.sessionId) sessions.delete(session.transport.sessionId);
    owned.delete(session);
    session.owner.dispose();
  };
  const closeSession = (session: Session): Promise<void> => {
    session.closing ??= Promise.resolve().then(async () => {
      try {
        await session.owner.server.close();
      } finally {
        dispose(session);
      }
    });
    return session.closing;
  };

  const httpServer = createServer(async (req, res) => {
    let counted = false;
    let session: Session | undefined;
    let sessionCounted = false;
    let fresh = false;
    try {
      for (const name of ["host", "origin", "authorization", "mcp-session-id"]) {
        const count = req.rawHeaders.filter((_, index) =>
          index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
        if (count > 1) throw new HttpError(400, "Duplicate request header.");
      }
      if (req.headers.host !== new URL(endpoint).host ||
          (req.headers.origin !== undefined && req.headers.origin !== endpoint)) {
        throw new HttpError(403, "Invalid Host or Origin.");
      }
      if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expectedToken)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="oil"');
        throw new HttpError(401, "Authentication required.");
      }
      if (closing) throw new HttpError(503, "Service is stopping.");
      if (requests >= maxRequests) throw new HttpError(429, "Concurrent request limit reached.");
      requests++;
      counted = true;
      if (req.method === "GET" && req.url === "/healthz") {
        reply(res, 200, { live: true, readiness: opts.readiness(), sessions: owned.size });
        return;
      }
      if (req.method === "GET" && req.url === "/readyz") {
        const status = opts.readiness();
        reply(res, status.ready ? 200 : 503, status);
        return;
      }
      if (req.url !== opts.path) throw new HttpError(404, "Not found.");
      const sessionId = req.headers["mcp-session-id"];
      if (Array.isArray(sessionId)) throw new HttpError(400, "Invalid session header.");
      session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && (!session || session.closing || session.disposed)) {
        throw new HttpError(404, "Session expired; initialize a new session without a session ID.");
      }
      if (session && session.inFlight === 0 && Date.now() - session.lastUsed >= idleTimeoutMs) {
        await closeSession(session);
        throw new HttpError(404, "Session expired; initialize a new session without a session ID.");
      }
      // No standalone SSE stream is needed for this request/response tool server.
      if (req.method !== "POST" && req.method !== "DELETE") {
        res.setHeader("Allow", "POST, DELETE");
        throw new HttpError(405, "Method not allowed.");
      }
      if (req.method === "DELETE") {
        if (!session) throw new HttpError(400, "Missing session ID.");
        await closeSession(session);
        reply(res, 200, { terminated: true });
        return;
      }
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        throw new HttpError(415, "Content-Type must be application/json.");
      }
      if (Number(req.headers["content-length"] ?? 0) > maxBodyBytes) {
        throw new HttpError(413, "Request body too large.");
      }
      // Reserve an existing session against expiry while its request body arrives.
      if (session) {
        session.inFlight++;
        sessionCounted = true;
      }
      const body = await readBody(req, maxBodyBytes, bodyTimeoutMs);
      if (closing) throw new HttpError(503, "Service is stopping.");
      if (!session) {
        if (!isInitializeRequest(body)) throw new HttpError(400, "Missing session ID.");
        if (owned.size >= maxSessions) throw new HttpError(429, "Session limit reached.");
        const owner = opts.createSessionServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            if (session) sessions.set(id, session);
          },
        });
        session = { owner, transport, lastUsed: Date.now(), inFlight: 1, disposed: false };
        const current = session;
        owned.add(current);
        fresh = true;
        sessionCounted = true;
        transport.onclose = () => dispose(current);
        await owner.server.connect(transport);
      }
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error("[OIL] HTTP request failed:", error);
      if (!res.headersSent && !res.destroyed) {
        const status = error instanceof HttpError ? error.status : 500;
        reply(res, status, { error: error instanceof HttpError ? error.message : "Internal server error." });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    } finally {
      if (session && sessionCounted) {
        session.inFlight = Math.max(0, session.inFlight - 1);
        session.lastUsed = Date.now();
        if (fresh && (!session.transport.sessionId || res.statusCode >= 400)) {
          await closeSession(session).catch((error) => console.error("[OIL] Session cleanup failed:", error));
        }
      }
      if (counted) requests--;
    }
  });
  httpServer.maxConnections = maxRequests + maxSessions;
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listener address.");
  endpoint = `http://${opts.host}:${address.port}`;
  httpServer.on("error", (error) => console.error("[OIL] HTTP listener error:", error));

  const sweep = setInterval(() => {
    for (const session of owned) {
      if (session.inFlight === 0 && Date.now() - session.lastUsed >= idleTimeoutMs) {
        void closeSession(session).catch((error) => console.error("[OIL] Session expiry failed:", error));
      }
    }
  }, Math.min(idleTimeoutMs, 30_000));
  sweep.unref();

  return {
    url: `${endpoint}${opts.path}`,
    getStats: () => ({ sessions: owned.size, requests, closing }),
    close: () => {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(sweep);
        const listenerClosed = new Promise<void>((resolve, reject) =>
          httpServer.close((error) => error ? reject(error) : resolve()));
        // Observe immediately even while tool draining is still in progress.
        const stopped = listenerClosed.then(() => undefined);
        void stopped.catch((error) => console.error("[OIL] HTTP close failed:", error));
        let timer: NodeJS.Timeout | undefined;
        const graceful = async () => {
          await opts.drain?.();
          const results = await Promise.allSettled([...owned].map(closeSession));
          for (const result of results) {
            if (result.status === "rejected") console.error("[OIL] Session close failed:", result.reason);
          }
          if (results.some((result) => result.status === "rejected")) {
            throw new Error("One or more MCP sessions failed to close.");
          }
        };
        try {
          await Promise.race([
            graceful(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("HTTP shutdown timed out.")), shutdownTimeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          for (const session of owned) {
            void closeSession(session).catch((error) => console.error("[OIL] Forced session close failed:", error));
            dispose(session);
          }
          httpServer.closeAllConnections();
          await stopped;
        }
      })();
      return closePromise;
    },
  };
}
