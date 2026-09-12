import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
const fixturePids = new Set<number>();
const vaults: string[] = [];
const entryUrl = pathToFileURL(resolve("dist/index.js")).href;
const shutdownUrl = pathToFileURL(resolve("dist/shutdown.js")).href;
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

function waitForExit(child: ChildProcessWithoutNullStreams, timeout = 8000) {
  return new Promise<number | null>((resolveExit, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`PID ${child.pid} did not exit within ${timeout}ms`));
    }, timeout);
    function onExit(code: number | null) {
      clearTimeout(timer);
      resolveExit(code);
    }
    child.once("exit", onExit);
  });
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntilGone(pid: number) {
  const deadline = Date.now() + 8000;
  while (isAlive(pid) && Date.now() < deadline) await sleep(50);
  expect(isAlive(pid), `fixture PID ${pid} should exit after its client dies`).toBe(false);
}

async function createVault() {
  const vault = await mkdtemp(join(tmpdir(), "oil-lifecycle-"));
  vaults.push(vault);
  await writeFile(join(vault, "test.md"), "# Lifecycle fixture\n");
  return vault;
}

function launch(file: string, vault: string, httpPort = "") {
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault, OIL_HTTP_PORT: httpPort,
      OIL_HTTP_HOST: "127.0.0.1", OIL_HTTP_PATH: "/mcp" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  // Retain stdout for assertions without risking a full pipe.
  let stdout = "";
  child.stdout.on("data", (data: string) => { stdout += data; });
  return { child, stdout: () => stdout };
}

function waitForReady(child: ChildProcessWithoutNullStreams, marker = "MCP server ready (stdio)") {
  return new Promise<void>((resolveReady, reject) => {
    let stderr = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr.off("data", onData);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Exited before ready (${code}): ${stderr}`));
    };
    const onData = (chunk: string) => {
      stderr += chunk;
      if (stderr.includes(marker)) { cleanup(); resolveReady(); }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Startup timeout: ${stderr}`));
    }, 60000);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stderr.on("data", onData);
  });
}

async function startServer() {
  const vault = await createVault();
  const server = launch(resolve("dist/index.js"), vault);
  await waitForReady(server.child);
  return server;
}

afterEach(async () => {
  // Kill only processes created by these tests; never enumerate user processes.
  for (const pid of fixturePids) {
    if (isAlive(pid)) process.kill(pid);
  }
  fixturePids.clear();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child);
    }
  }
  for (const vault of vaults.splice(0)) {
    await rm(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it("exits after the MCP client closes stdin, without a termination signal", async () => {
  const { child } = await startServer();
  const exited = waitForExit(child);
  child.stdin.end();
  expect(await exited).toBe(0);
}, 90000);

it("keeps initialize data sent during startup and exposes the tool catalog", async () => {
  const vault = await createVault();
  const { child, stdout } = launch(resolve("dist/index.js"), vault);
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "lifecycle-test", version: "1" } },
  }) + "\n");
  await waitForReady(child);
  await expect.poll(() => stdout(), { timeout: 5000 }).toContain('"id":1');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await expect.poll(() => stdout(), { timeout: 5000 }).toContain('"id":2');
  const response = stdout().trim().split("\n").map((line) => JSON.parse(line))
    .find((message) => message.id === 2);
  expect(response.result.tools.map((tool: { name: string }) => tool.name)).toContain("get_health");
  const exited = waitForExit(child);
  child.stdin.end();
  expect(await exited).toBe(0);
}, 90000);

it("exits when stdin is closed before initialization finishes", async () => {
  const vault = await createVault();
  const { child } = launch(resolve("dist/index.js"), vault);
  const exited = waitForExit(child, 60000);
  child.stdin.end();
  expect(await exited).toBe(0);
}, 90000);

it("cleans up three independent stdio servers", async () => {
  const servers = await Promise.all([startServer(), startServer(), startServer()]);
  const exits = servers.map(({ child }) => {
    const exited = waitForExit(child);
    child.stdin.end();
    return exited;
  });
  expect(await Promise.all(exits)).toEqual([0, 0, 0]);
}, 90000);

it("exits after a client is killed, including the Windows cmd launcher", async () => {
  const vault = await createVault();
  const runner = join(vault, "server.mjs");
  const client = join(vault, "client.mjs");
  const pidFile = join(vault, "server.pid");
  const launcherPidFile = join(vault, "launcher.pid");
  await writeFile(runner, `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    await import(${JSON.stringify(entryUrl)});
  `);
  // The host owns the input pipe. Force-killing it closes that pipe without
  // delivering SIGTERM to the server, like a disappearing MCP client.
  await writeFile(client, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const windows = process.platform === "win32";
    const command = windows ? '"' + process.execPath + '"' : process.execPath;
    const args = [windows ? '"' + ${JSON.stringify(runner)} + '"' : ${JSON.stringify(runner)}];
    const server = spawn(command, args, {
      shell: windows, stdio: ["pipe", "inherit", "inherit"], windowsHide: true
    });
    server.on("error", (error) => { console.error(error); process.exit(1); });
    writeFileSync(${JSON.stringify(launcherPidFile)}, String(server.pid));
  `);
  const { child } = launch(client, vault);
  await waitForReady(child);
  const serverPid = Number(await readFile(pidFile, "utf8"));
  const launcherPid = Number(await readFile(launcherPidFile, "utf8"));
  fixturePids.add(serverPid);
  fixturePids.add(launcherPid);
  const exited = waitForExit(child);
  child.kill("SIGKILL");
  await exited;
  await waitUntilGone(serverPid);
  await waitUntilGone(launcherPid);
}, 90000);

it("runs shutdown once and forces exit if cleanup never settles", async () => {
  const vault = await createVault();
  const fixture = join(vault, "stalled.mjs");
  await writeFile(fixture, `
    import { installShutdownHandlers } from ${JSON.stringify(shutdownUrl)};
    const lifecycle = installShutdownHandlers({
      stdio: true, timeoutMs: 200,
      cleanup: () => { console.error("cleanup-called"); return new Promise(() => {}); }
    });
    process.stdin.resume();
    process.stdin.on("end", () => lifecycle.shutdown("duplicate"));
    setInterval(() => {}, 1000);
    console.error("fixture-ready");
  `);
  const { child } = launch(fixture, vault);
  let stderr = "";
  child.stderr.on("data", (data: string) => { stderr += data; });
  await waitForReady(child, "fixture-ready");
  const exited = waitForExit(child);
  child.stdin.end();
  expect(await exited).toBe(1);
  expect(stderr.match(/cleanup-called/g)).toHaveLength(1);
  expect(stderr).toContain("Shutdown timed out");
}, 90000);

it("reports cleanup rejection as a failed shutdown", async () => {
  const vault = await createVault();
  const fixture = join(vault, "rejected.mjs");
  await writeFile(fixture, `
    import { installShutdownHandlers } from ${JSON.stringify(shutdownUrl)};
    installShutdownHandlers({
      stdio: true, cleanup: async () => { throw new Error("fixture failure"); }
    });
    process.stdin.resume();
    console.error("fixture-ready");
  `);
  const { child } = launch(fixture, vault);
  let stderr = "";
  child.stderr.on("data", (data: string) => { stderr += data; });
  await waitForReady(child, "fixture-ready");
  const exited = waitForExit(child);
  child.stdin.end();
  expect(await exited).toBe(1);
  expect(stderr).toContain("Shutdown cleanup failed");
}, 90000);

it("handles shutdown signals once even when stdin also ends", async () => {
  const vault = await createVault();
  const fixture = join(vault, "signal.mjs");
  await writeFile(fixture, `
    import { installShutdownHandlers } from ${JSON.stringify(shutdownUrl)};
    installShutdownHandlers({
      stdio: true,
      cleanup: async () => {
        console.error("cleanup-called");
        await new Promise((done) => setTimeout(done, 50));
      }
    });
    process.stdin.on("data", () => {
      process.emit("SIGTERM");
      process.emit("SIGINT");
    });
    console.error("fixture-ready");
  `);
  const { child } = launch(fixture, vault);
  let stderr = "";
  child.stderr.on("data", (data: string) => { stderr += data; });
  await waitForReady(child, "fixture-ready");
  const exited = waitForExit(child);
  child.stdin.end("signal\n");
  expect(await exited).toBe(0);
  expect(stderr.match(/cleanup-called/g)).toHaveLength(1);
}, 90000);

it("exits on a broken stdout pipe rather than leaving the watcher running", async () => {
  const { child } = await startServer();
  const exited = waitForExit(child);
  child.stdout.destroy();
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "broken-output-test", version: "1" } },
  }) + "\n");
  expect(await exited).toBe(1);
}, 90000);

it("keeps the HTTP service alive when stdin closes", async () => {
  const socket = createServer();
  await new Promise<void>((ready) => socket.listen(0, "127.0.0.1", ready));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()));
  const vault = await createVault();
  const { child } = launch(resolve("dist/index.js"), vault, String(address.port));
  await waitForReady(child, "MCP server ready (HTTP)");
  child.stdin.end();
  await sleep(300);
  expect(child.exitCode).toBeNull();
  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
}, 90000);
