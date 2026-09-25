import { afterEach, expect, it, vi } from "vitest";
import { request } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { startHttpServer, type HttpServerHandle, type HttpServerOptions } from "../http-server.js";
import { SessionCache } from "../cache.js";
import { ToolAccess } from "../runtime-state.js";
import { jsonResponse } from "../tool-responses.js";

const token = "test-token-".repeat(5);
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
  Accept: "application/json, text/event-stream" };
const servers: HttpServerHandle[] = [];
const clients: Client[] = [];
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
} };
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

async function start(overrides: Partial<HttpServerOptions> = {}) {
  const disposed = vi.fn();
  const host = await startHttpServer({
    host: "127.0.0.1", port: 0, path: "/mcp", token,
    readiness: () => ({ ready: true, state: "ready" }),
    createSessionServer: () => {
      const cache = new SessionCache();
      const server = new McpServer({ name: "test", version: "1" });
      server.registerTool("remember", { inputSchema: { value: z.string() } }, async ({ value }) => {
        cache.addPendingWrite({ id: value, operation: "append", path: "note.md", diff: value, createdAt: new Date() });
        return jsonResponse({ count: cache.listPendingWrites().length });
      });
      server.registerTool("pending", { inputSchema: {} }, async () =>
        jsonResponse({ count: cache.listPendingWrites().length }));
      return { server, dispose: disposed };
    },
    ...overrides,
  });
  servers.push(host);
  return { host, disposed };
}

async function connect(url: string) {
  const client = new Client({ name: "http-test", version: "1" });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

function post(url: string, body: unknown, extra: Record<string, string> = {}) {
  return fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
}
async function payload(client: Client, name: string, args = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const text = result.content[0];
  if (text.type !== "text") throw new Error("Expected text response");
  return JSON.parse(text.text);
}

it("serves multiple real SDK clients with isolated pending writes and disposes DELETE sessions", async () => {
  const { host, disposed } = await start();
  const a = await connect(host.url);
  const b = await connect(host.url);
  expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
  expect((await a.client.listTools()).tools).toHaveLength(2);
  expect(await payload(a.client, "remember", { value: "a-only" })).toEqual({ count: 1 });
  expect(await payload(b.client, "pending")).toEqual({ count: 0 });
  expect(host.getStats().sessions).toBe(2);
  await a.transport.terminateSession();
  expect(host.getStats().sessions).toBe(1);
  expect(disposed).toHaveBeenCalledTimes(1);
  await host.close();
  expect(disposed).toHaveBeenCalledTimes(2);
});

it("requires a token on all routes, rejects invalid Host/Origin, and never echoes tokens", async () => {
  const { host } = await start();
  const base = host.url.replace("/mcp", "");
  for (const route of ["/healthz", "/readyz", "/mcp"]) {
    const response = await fetch(base + route);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(token);
  }
  expect((await post(host.url, initialize, { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await post(host.url, initialize, { Origin: "http://evil.example" })).status).toBe(403);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = request(host.url, { method: "POST", headers: { ...headers, Host: "evil.example" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end(JSON.stringify(initialize));
  });
  expect(wrongHost).toBe(403);
  expect((await post(host.url, initialize, { Origin: base })).status).toBe(200);
});

it("rejects missing and stale sessions and allows reinitialization after restart", async () => {
  const { host } = await start();
  const a = await connect(host.url);
  const sid = a.transport.sessionId!;
  expect((await post(host.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(400);
  await host.close();
  const port = Number(new URL(host.url).port);
  const restarted = await start({ port });
  expect((await post(restarted.host.url, initialize, { "mcp-session-id": sid })).status).toBe(404);
  const b = await connect(restarted.host.url);
  expect((await b.client.listTools()).tools).toHaveLength(2);
});

it("bounds sessions, expires abandoned sessions, and frees capacity", async () => {
  const { host, disposed } = await start({ maxSessions: 1, idleTimeoutMs: 150 });
  const response = await post(host.url, initialize);
  expect(response.status).toBe(200);
  const sid = response.headers.get("mcp-session-id")!;
  await response.text();
  expect((await post(host.url, initialize)).status).toBe(429);
  await expect.poll(() => host.getStats().sessions, { timeout: 2000 }).toBe(0);
  expect(disposed).toHaveBeenCalledTimes(1);
  expect((await post(host.url, initialize, { "mcp-session-id": sid })).status).toBe(404);
  expect((await post(host.url, initialize)).status).toBe(200);
});

it("rejects malformed, batched, oversized, and wrong-content-type bodies", async () => {
  const { host } = await start({ maxBodyBytes: 256 });
  expect((await post(host.url, [initialize])).status).toBe(400);
  expect((await post(host.url, { data: "x".repeat(1000) })).status).toBe(413);
  expect((await fetch(host.url, { method: "POST", headers, body: "{" })).status).toBe(400);
  expect((await post(host.url, initialize, { "Content-Type": "text/plain" })).status).toBe(415);
  expect(host.getStats().sessions).toBe(0);
});

it("bounds chunked bodies and slow uploads", async () => {
  const { host } = await start({ maxBodyBytes: 64, bodyTimeoutMs: 100 });
  const send = (chunk: string, end: boolean) => new Promise<number>((resolve, reject) => {
    const req = request(host.url, { method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => { req.destroy(); resolve(res.statusCode!); });
    });
    req.on("error", reject);
    req.write(chunk);
    if (end) req.end();
  });
  expect(await send("x".repeat(100), true)).toBe(413);
  expect(await send("{", false)).toBe(408);
  expect(host.getStats().sessions).toBe(0);
});

it("disposes failed initialization allocations instead of leaking them", async () => {
  const { host, disposed } = await start();
  const response = await post(host.url, initialize, { Accept: "text/plain" });
  expect(response.status).toBe(406);
  await expect.poll(() => host.getStats().sessions).toBe(0);
  expect(disposed).toHaveBeenCalledTimes(1);
});

it("reports liveness separately from readiness without creating sessions", async () => {
  const { host } = await start({ readiness: () => ({ ready: false, state: "initializing" }) });
  const base = host.url.replace("/mcp", "");
  expect((await fetch(base + "/healthz", { headers })).status).toBe(200);
  const ready = await fetch(base + "/readyz", { headers });
  expect(ready.status).toBe(503);
  expect(await ready.json()).toMatchObject({ ready: false, state: "initializing" });
  expect(host.getStats().sessions).toBe(0);
});

it("releases session resources across repeated connect/terminate cycles", async () => {
  const { host, disposed } = await start({ maxSessions: 2 });
  for (let i = 0; i < 10; i++) {
    const { client, transport } = await connect(host.url);
    await client.listTools();
    await transport.terminateSession();
    await client.close();
    expect(host.getStats().sessions).toBe(0);
  }
  expect(disposed).toHaveBeenCalledTimes(10);
});

it("rejects connection failures without retaining an allocated session", async () => {
  const disposed = vi.fn();
  const { host } = await start({ createSessionServer: () => {
    const server = new McpServer({ name: "failed-connect", version: "1" });
    vi.spyOn(server, "connect").mockRejectedValue(new Error("fixture connect failure"));
    return { server, dispose: disposed };
  } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await post(host.url, initialize)).status).toBe(500);
  await expect.poll(() => host.getStats().sessions).toBe(0);
  expect(disposed).toHaveBeenCalledTimes(1);
});

it("bounds concurrent requests while a client has not finished its body", async () => {
  const { host } = await start({ maxRequests: 1, bodyTimeoutMs: 1000 });
  const req = request(host.url, { method: "POST", headers });
  req.on("error", () => { /* Expected when the fixture socket is deliberately closed. */ });
  req.write("{");
  try {
    await expect.poll(() => host.getStats().requests).toBe(1);
    const response = await fetch(host.url.replace("/mcp", "/healthz"), { headers });
    expect(response.status).toBe(429);
  } finally {
    req.destroy();
  }
  await expect.poll(() => host.getStats().requests).toBe(0);
});

it("keeps expensive-work capacity occupied until the actual tool completes", async () => {
  const access = new ToolAccess(() => ({ ready: true, state: "ready" }), 1);
  let release!: () => void;
  const work = access.run(async () => {
    await new Promise<void>((done) => { release = done; });
    return jsonResponse({ done: true });
  });
  const denied = await access.run(async () => jsonResponse({ shouldNotRun: true }));
  expect(denied.isError).toBe(true);
  let drained = false;
  const draining = access.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await work;
  await draining;
  expect(drained).toBe(true);
});

it("closes idempotently and fails explicitly if draining times out", async () => {
  const { host } = await start({ drain: () => new Promise(() => {}), shutdownTimeoutMs: 30 });
  const first = host.close();
  expect(host.close()).toBe(first);
  await expect(first).rejects.toThrow("timed out");
  servers.splice(servers.indexOf(host), 1);
  await expect(fetch(host.url)).rejects.toThrow();
});

it("bounds shutdown even if a session's close never resolves", async () => {
  const disposed = vi.fn();
  const { host } = await start({
    shutdownTimeoutMs: 30,
    createSessionServer: () => {
      const server = new McpServer({ name: "stalled-close", version: "1" });
      vi.spyOn(server, "close").mockImplementation(() => new Promise(() => {}));
      return { server, dispose: disposed };
    },
  });
  await connect(host.url);
  await expect(host.close()).rejects.toThrow("timed out");
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(host.getStats().sessions).toBe(0);
  servers.splice(servers.indexOf(host), 1);
  await expect(fetch(host.url)).rejects.toThrow();
});
