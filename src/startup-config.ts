import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { parseArgs } from "node:util";

export interface StartupConfig {
  vaultPath: string;
  transport: "stdio" | "http";
  http?: {
    host: "127.0.0.1";
    port: number;
    path: string;
    token: string;
  };
}

export const STARTUP_HELP = `Usage: obsidian-intelligence-layer mcp [options]
  --transport stdio|http   Default: stdio, or http when OIL_HTTP_PORT is set
  --vault-path PATH        Absolute local vault directory
  --http-host 127.0.0.1    Loopback only
  --http-port PORT         Default: 8020 in explicit HTTP mode
  --http-path PATH         Default: /mcp
  --http-token-file PATH   Absolute path to a protected token file outside the vault

CLI options override environment variables:
OIL_TRANSPORT, OBSIDIAN_VAULT_PATH, OIL_HTTP_HOST, OIL_HTTP_PORT,
OIL_HTTP_PATH, OIL_HTTP_TOKEN_FILE.
HTTP requires a token file containing 32-512 base64url characters.
No token value should be passed on the command line.`;

export async function resolveStartupConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartupConfig> {
  const { values } = parseArgs({
    args: args[0] === "mcp" ? args.slice(1) : args,
    options: {
      transport: { type: "string" },
      "vault-path": { type: "string" },
      "http-host": { type: "string" },
      "http-port": { type: "string" },
      "http-path": { type: "string" },
      "http-token-file": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const rawPort = values["http-port"] ?? env.OIL_HTTP_PORT;
  const transport = values.transport ?? env.OIL_TRANSPORT ??
    (rawPort ? "http" : "stdio");
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("Transport must be stdio or http.");
  }
  if (transport === "stdio" && Object.keys(values).some((key) => key.startsWith("http-"))) {
    throw new Error("HTTP options cannot be combined with --transport stdio.");
  }
  const rawVault = values["vault-path"] ?? env.OBSIDIAN_VAULT_PATH;
  if (!rawVault || !isAbsolute(rawVault)) {
    throw new Error("An absolute vault path is required (--vault-path or OBSIDIAN_VAULT_PATH).");
  }
  const vaultPath = await realpath(rawVault);
  if (!(await stat(vaultPath)).isDirectory()) throw new Error("Vault path must be a directory.");
  await access(vaultPath, transport === "http" ? constants.R_OK | constants.W_OK : constants.R_OK);
  if (transport === "stdio") return { transport, vaultPath };

  const host = values["http-host"] ?? env.OIL_HTTP_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("HTTP host must be 127.0.0.1 (loopback only).");
  const portText = rawPort ?? "8020";
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error("HTTP port must be an integer from 1 to 65535.");
  }
  const path = values["http-path"] ?? env.OIL_HTTP_PATH ?? "/mcp";
  if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes("//") ||
      ["/healthz", "/readyz"].includes(path)) {
    throw new Error("HTTP path must be an absolute URL path other than /healthz or /readyz.");
  }
  const tokenFile = values["http-token-file"] ?? env.OIL_HTTP_TOKEN_FILE;
  if (!tokenFile || !isAbsolute(tokenFile)) {
    throw new Error("HTTP requires an absolute --http-token-file or OIL_HTTP_TOKEN_FILE.");
  }
  const canonicalTokenFile = await realpath(tokenFile);
  const rel = relative(vaultPath, canonicalTokenFile);
  if (rel === "" || (!rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel))) {
    throw new Error("The HTTP token file must be outside the watched vault.");
  }
  const tokenStat = await stat(canonicalTokenFile);
  if (!tokenStat.isFile() || tokenStat.size > 1024) throw new Error("Invalid HTTP token file.");
  const token = (await readFile(canonicalTokenFile, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) {
    throw new Error("HTTP token must contain 32-512 base64url characters.");
  }
  return { transport, vaultPath, http: { host, port: Number(portText), path, token } };
}
