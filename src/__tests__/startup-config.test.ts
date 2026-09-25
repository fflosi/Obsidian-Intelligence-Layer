import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveStartupConfig } from "../startup-config.js";
import { loadConfig } from "../config.js";

let root: string;
let vault: string;
let tokenFile: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "oil-config-"));
  vault = join(root, "vault with spaces");
  tokenFile = join(root, "token");
  await mkdir(vault);
  await writeFile(tokenFile, "x".repeat(43));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const env = () => ({ OBSIDIAN_VAULT_PATH: vault, OIL_HTTP_TOKEN_FILE: tokenFile });

it("keeps stdio the default and accepts a canonical absolute vault", async () => {
  expect(await resolveStartupConfig([], env())).toEqual({ transport: "stdio", vaultPath: vault });
});

it("CLI overrides env, including an explicit stdio choice over an HTTP environment", async () => {
  expect((await resolveStartupConfig(["--transport", "stdio"], { ...env(), OIL_HTTP_PORT: "8020" })).transport)
    .toBe("stdio");
  const config = await resolveStartupConfig([
    "mcp", "--transport", "http", "--vault-path", vault, "--http-port", "8123",
  ], { ...env(), OBSIDIAN_VAULT_PATH: "missing", OIL_HTTP_PORT: "bad" });
  expect(config.http).toMatchObject({ port: 8123, host: "127.0.0.1", path: "/mcp" });
});

it("explicit HTTP defaults to 8020 and legacy HTTP env still works with a token", async () => {
  expect((await resolveStartupConfig(["--transport", "http"], env())).http?.port).toBe(8020);
  expect((await resolveStartupConfig([], { ...env(), OIL_HTTP_PORT: "8080" })).http?.port).toBe(8080);
});

it.each(["bad", "-1", "0", "65536", "8020oops", "3.5", " "])("rejects invalid port %s without stdio fallback", async (port) => {
  await expect(resolveStartupConfig([], { ...env(), OIL_HTTP_PORT: port })).rejects.toThrow("HTTP port");
});

it("rejects unknown arguments and conflicting CLI flags", async () => {
  await expect(resolveStartupConfig(["--wat"], env())).rejects.toThrow();
  await expect(resolveStartupConfig(["--transport", "stdio", "--http-port", "8020"], env())).rejects.toThrow();
});

it("rejects missing, relative, nonexistent, and non-directory vaults", async () => {
  for (const path of ["", "relative", join(root, "missing"), tokenFile]) {
    await expect(resolveStartupConfig(["--vault-path", path], env())).rejects.toThrow();
  }
});

it.each(["0.0.0.0", "localhost", "::", "192.168.1.1"])("rejects bind host %s", async (host) => {
  await expect(resolveStartupConfig(["--transport", "http", "--http-host", host], env())).rejects.toThrow("loopback");
});

it.each(["/healthz", "/readyz", "//mcp", "/mcp?secret=a", "mcp", "/../mcp"])("rejects invalid endpoint %s", async (path) => {
  await expect(resolveStartupConfig(["--transport", "http", "--http-path", path], env())).rejects.toThrow("HTTP path");
});

it("requires a token and refuses secrets inside the vault", async () => {
  await expect(resolveStartupConfig(["--transport", "http"], { OBSIDIAN_VAULT_PATH: vault }))
    .rejects.toThrow("token-file");
  const inside = join(vault, "token.txt");
  await writeFile(inside, "x".repeat(43));
  await expect(resolveStartupConfig(["--transport", "http", "--http-token-file", inside], env()))
    .rejects.toThrow("outside");
  await writeFile(tokenFile, "short");
  await expect(resolveStartupConfig(["--transport", "http"], env())).rejects.toThrow("32-512");
});

it("strict HTTP configuration does not hide invalid YAML", async () => {
  await expect(loadConfig(vault, true)).resolves.toBeDefined();
  await writeFile(join(vault, "oil.config.yaml"), "schema: [\n");
  await expect(loadConfig(vault, true)).rejects.toThrow();
  await expect(loadConfig(vault)).resolves.toBeDefined();
});
