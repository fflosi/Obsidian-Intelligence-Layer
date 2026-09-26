# Obsidian Intelligence Layer (OIL)

**OIL is an [MCP](https://modelcontextprotocol.io/) server that gives AI agents efficient, safe access to an Obsidian vault.** Instead of flooding context with raw file dumps, it provides targeted reads, ranked search, and mtime-safe writes — so the LLM spends its context on reasoning, not data wrangling.

**Node 20+** · **TypeScript** · **ES modules** · **MIT**

**Windows users:** run OIL as one authenticated, loopback-only Windows service
and connect multiple GitHub Copilot CLI sessions to the same graph and watcher.
The service runs under a Windows user account, independently of user sign-in.

### Navigation

- [Quick start and HTTP configuration](#quick-start)
- [Install the Windows HTTP service](#install-the-windows-http-service)
- [Configure GitHub Copilot CLI](#configure-github-copilot-cli)
- [Use OIL from Copilot](#use-oil-from-copilot)
- [Service operation and maintenance](#service-operation-and-maintenance)
- [Troubleshooting](#http-service-troubleshooting)
- [Rollback and uninstall](#rollback-and-uninstall)
- [Tools reference](#tools-reference)
- [Development](#development)

<p align="center">
  <img src="docs/assets/oil-overview.gif" alt="OIL overview — your AI agent's second brain" width="800" />
</p>

---

## Why OIL?

**The problem:** Your Obsidian vault is your second brain — customer notes, meeting summaries, project docs, action items. When you ask your AI assistant to help ("what are the open action items for Contoso?"), it needs to read your vault.

Without a smart interface, the agent does the dumb thing:
- Dumps 50 full notes into context → burns thousands of tokens
- Searches by grep → misses structure, relationships, and frontmatter
- Writes blindly → risks overwriting your edits mid-session

**The solution:** OIL is a structured interface between your AI and your vault. It speaks [Model Context Protocol](https://modelcontextprotocol.io/) — the protocol AI agents use to discover and call tools. When Copilot or Claude needs something from your vault, it calls OIL's tools instead:

- **Search** returns ranked snippets, not whole files
- **Reads** are section-level — ask for `## Team` and get just that heading
- **Writes** are mtime-checked — the agent can't clobber your edits by accident
- **Domain tools** assemble full customer snapshots, extract CRM identifiers, and surface vault hygiene issues — encoding business logic the LLM would otherwise have to reconstruct from scratch

> **For customer-facing teams:** OIL includes purpose-built tools for account management workflows. If you track customers, opportunities, and meetings in Obsidian, the domain tools (`get_customer_context`, `prepare_crm_prefetch`, `check_vault_health`) are the highest-value part of the set.

---

## What This Is (and Isn't)

**OIL is not a REST API wrapper around Obsidian.** It's an MCP server that speaks the
[Model Context Protocol](https://modelcontextprotocol.io/) over stdio or opt-in
shared Streamable HTTP. The HTTP endpoint still uses MCP initialization, sessions,
and tool calls; it is not a set of REST endpoints for notes.

| Without OIL | With OIL |
|---|---|
| Dump full note to context | `read_note_section(path, "Team")` → just the section you need |
| Full-vault file scan for backlinks | `get_related_entities(path)` → graph-traversed refs, capped at 50 |
| Free-text grep across files | `search_vault(query)` → ranked results with snippets, folder + tag filters |
| Blind file overwrite | `atomic_append(path, heading, content, expected_mtime)` → rejected if file changed since last read |
| Manual review for stale notes | `check_vault_health()` → surfaces stale insights, missing IDs, orphaned meetings |
| Manual context assembly per customer | `get_customer_context(customer)` → assembled snapshot: team, meetings, opportunities, action items |

---

## Quick Start

### Prerequisites

- **Node.js ≥ 20**
- An **Obsidian vault** on disk (Obsidian doesn't need to be running — OIL works directly on the files)

### Install and Build

```powershell
git clone 'https://github.com/fflosi/Obsidian-Intelligence-Layer.git' 'C:\src\Obsidian-Intelligence-Layer'
Set-Location 'C:\src\Obsidian-Intelligence-Layer'
npm ci
npm run build
```

Use a revision containing the HTTP service code, not the upstream `v0.5.5` tag.
The tested implementation is commit `e0874565d49422f42ad28f17337aed96487d398a`
on `feat/windows-service-foundations`. A clone of the fork's default branch is
not proof that it contains that revision. Confirm the branch/commit is published
and fetch it before installation; if it is missing, obtain it from the maintainer
rather than substituting the upstream release. The runtime still reports package
version `0.5.5`, so record the Git revision as well as the package version.

### Run

```powershell
node 'C:\src\Obsidian-Intelligence-Layer\dist\cli.js' mcp --transport stdio --vault-path 'D:\Notes\Vault'
```

The server communicates over **stdio** by default; an MCP client connects to it.
This fork also supports opt-in shared HTTP with a required client token.

### Shared HTTP host

Each host instance runs one Node process with one graph and watcher for its
configured vault, regardless of client count. Each client receives its own MCP
server and session cache. Configure all clients to use the same service; separate
stdio launches or manually started HTTP instances still create extra processes.
Stdio remains the default and retains its client-disconnect cleanup behavior.

**Migration:** older HTTP configurations that set only `OIL_HTTP_PORT` now fail
explicitly until `OIL_HTTP_TOKEN_FILE` is configured. There is no unauthenticated
HTTP mode and no fallback to stdio for invalid HTTP settings.

Example foreground command, using a disposable vault and a pre-provisioned token:

```powershell
node 'V:\GitHub\Obsidian-Intelligence-Layer\dist\cli.js' mcp --transport http --vault-path 'C:\OIL-Trial\vault' --http-port 8020 --http-token-file 'C:\OIL-Trial\secrets\http-token'
```

The token file must be outside the vault and contain a cryptographically random
base64url token (at least 32 characters, at most 512; 32 random bytes encoded as
base64url is recommended). Restrict its Windows ACL to the service account and
administrators. Do not commit it, log it, put the token value in process
arguments, or put it inside the vault where tools could retrieve it.
Filesystem ACL provisioning is an installation responsibility; the Node
application itself does not modify ACLs.

All routes require `Authorization: Bearer <token>`, including health probes.
Configure clients to send this header through their supported secret mechanism;
do not embed real credentials in shared client configuration. This is a local
shared-secret mechanism, not an OAuth authorization server or per-user
permissions system. Whoever has the token can call the vault tools.

| Startup argument | Environment fallback | Default |
|---|---|---|
| `--transport` | `OIL_TRANSPORT` | `stdio`, or `http` if `OIL_HTTP_PORT` is nonempty |
| `--vault-path` | `OBSIDIAN_VAULT_PATH` | Required absolute directory |
| `--http-host` | `OIL_HTTP_HOST` | `127.0.0.1` (the only permitted bind address) |
| `--http-port` | `OIL_HTTP_PORT` | `8020` in explicit HTTP mode |
| `--http-path` | `OIL_HTTP_PATH` | `/mcp` |
| `--http-token-file` | `OIL_HTTP_TOKEN_FILE` | Required in HTTP mode |

Explicit flags take precedence over environment variables. `--transport stdio`
ignores inherited HTTP environment settings, but rejects HTTP flags on the same
command line. Vault paths are canonicalized and checked for directory/read/write
access. Unknown arguments, bad ports, missing credentials, and inaccessible
vaults fail startup. HTTP mode also rejects malformed `oil.config.yaml` rather
than silently applying defaults. Use `mcp --help` for the argument contract.

The vault path and token are startup settings, not hot-reload settings.
Changing either requires a controlled restart. The Windows service persists
these arguments in `C:\ProgramData\OIL\OILMCP.xml`; see the maintenance procedure
below for changing the vault without reinstalling the service.
Do not use the Services console's temporary start parameters as a substitute for
the wrapper's persistent executable arguments.

#### Readiness, limits, and shutdown

HTTP MCP initialization and tool discovery do not wait for indexing. All 14 tool
names and input schemas are retained. The persisted graph is reconciled in the
background, with the watcher started before scanning to capture intervening edits.
Watcher updates wait for graph builds rather than mutating an in-progress build.

| Surface | Meaning |
|---|---|
| Authenticated `GET /healthz` | Listener responds; returns liveness, readiness, and session count. HTTP 200 is **not** proof that vault tools are ready. |
| Authenticated `GET /readyz` | HTTP 200 only when ready; otherwise HTTP 503 with initializing/degraded/failed/stopping state. |
| MCP `get_health` | Remains available during indexing/degradation, with additive `readiness` data and existing graph/watcher/cache details. |
| Other tools | Return an MCP `isError` result with `STALE_INDEX` while unready, rather than empty successful results. |

Strict HTTP startup exposes unreadable/malformed notes as initialization failure.
The listener remains available for diagnostics; fix the cause and restart.
A lightweight access probe every five seconds detects a missing/inaccessible
vault root and marks the runtime failed; it is not a full scan, synchronization
check, or hang supervisor. Watcher-reported staleness also blocks vault tools.

Current limits: 64 sessions, 30 minutes idle expiry, 1 MiB request bodies,
10-second body timeout, 32 active HTTP requests, and 4 concurrent vault-tool
executions across all sessions. Excess HTTP requests/sessions get HTTP 429;
tool saturation returns `LIMIT_EXCEEDED`. Tool slots are held until actual
execution finishes, even if the caller disconnects. There is no unbounded work
queue. These limits are internal defaults, not currently CLI settings.

Clients may terminate sessions with MCP HTTP DELETE. Lost/expired session IDs
return HTTP 404; clients must initialize a new session without the old ID.
Pending write confirmations are not transferred across sessions or restarts.
The host uses JSON responses and returns HTTP 405 for standalone GET/SSE streams;
tools requiring server-initiated notifications are not supported in this mode.
Host/Origin checks only accept the listener's exact `127.0.0.1:port` authority
(Origin may be omitted by non-browser clients). No wildcard CORS is enabled.

Shutdown stops new work, drains tools, closes sessions and listener, and stops
the watcher. HTTP close has a three-second deadline; process cleanup has a
five-second forced-exit backstop. Unfinished writes can still be interrupted
when a deadline is exceeded, so forced termination is not a clean-write guarantee.
Closing a chat, its stdin, or its HTTP connection does not stop the shared host.

**Deployment evidence:** on September 25, 2026, the host was installed under
the operator's Windows account using WinSW 2.12.0. Live, read-only tests verified
two SDK clients, all 14 tools, healthy indexing, metadata matching disk, and a
section read. Stopping through Windows Service Control Manager delivered SIGINT,
released the port, and terminated the Node child. Restart created one new Node
child and restored readiness. A fresh Copilot CLI session, and then the restarted
interactive session, successfully used OIL. No note writes were performed by
those live tests; indexing and runtime logs still write derived state.

The full release gate passed 420 tests plus packaged startup validation on that
revision. **Not yet validated:** boot before sign-in, behavior after sign-out,
Scout migration, automatic recovery of an already-open chat after server restart,
failure-recovery exhaustion, and a representative workday soak. Configuration
alone is not proof of these behaviors. The repository contains the runtime and
tests; the machine-specific installation helpers listed below are not shipped
in a fresh clone. Keep runtime files, logs, backups, and secrets outside the vault.

### Client disconnect and process cleanup

In stdio mode, closing the client's input pipe (`stdin` end/close), an input/output
pipe error, or MCP transport closure triggers shutdown. OIL closes the MCP server,
unregisters its session cache, stops the persistent vault watcher and cancels its
pending debounce timers. It also waits for tracked background graph persistence.
`SIGINT` and `SIGTERM` use the same idempotent cleanup path, registered before
vault initialization. Startup input is not consumed until the MCP transport is
connected, so an early initialize request is preserved.

Normal cleanup exits with code 0. Pipe errors or cleanup failure exit with code 1;
a five-second backstop forces exit with code 1 if cleanup stalls. A forced exit
can interrupt unfinished work, so it is a fallback, not the normal shutdown path.
Diagnostics go to stderr, leaving stdout for MCP messages.

This fixes the case where the client closes its pipes but OIL's persistent
watcher otherwise keeps Node alive. It does not impose an idle timeout or reduce
the number of live stdio sessions. If another process retains the client's input
pipe open, EOF will not arrive; this change is not a general process-tree reaper.
Already-orphaned processes running an older build are not affected.

HTTP mode deliberately ignores stdin closure: a shared service must survive an
individual client's disconnect. No switch to HTTP is required for this fix.

### Watcher errors and stale indexes

The watcher excludes dot-directories, `node_modules`, and `.lock` artifacts
before opening filesystem watches. Other regular files are watched only if they
match the vault's supported `.md`, `.markdown`, or `.txt` extensions. Directories
remain traversable; the automation's lock files are never deleted or modified.
Filtering uses a predicate, not glob strings (Chokidar v4 does not support globs).

Watcher errors are logged to stderr and do not terminate the MCP transport.
For `EBUSY`, `EPERM`, `EACCES`, `ENOENT`, `EMFILE`, `ENFILE`, and `ENOSPC`,
OIL closes the failed watcher before retrying, with at most three restarts per
watcher lifetime (delays: 1, 2, 4 seconds). Reaching `ready` does not reset this
budget, preventing an endless restart loop. Unknown errors, exhausted retries,
or failed cleanup leave the watcher degraded. Shutdown cancels retries and
ignores late events.

A slow initial scan is not an error. After 30 seconds OIL logs a warning and
sets `readinessDelayed` and `indexMayBeStale`, but leaves the same watcher running
in `starting` (or `recovering`) state. When `ready` eventually arrives, OIL performs
catch-up before declaring the index fresh. It also waits for any ongoing startup
graph build rather than aborting it after an arbitrary deadline. This prevents
large or OneDrive-backed vaults from losing their watcher just because enumeration
takes longer than 30 seconds. If readiness never arrives, health remains visibly
pending; no periodic restart loop is created.

After a restart reaches `ready`, a strict catch-up rebuild reconciles changes
missed during the gap. Note/traversal/search caches are invalidated without
discarding pending write confirmations. A failed rebuild does not report a
fresh index; ordinary startup retains its existing lenient parsing behavior.
Watcher events use forward-slash vault-relative paths on Windows, matching the
graph and cache keys.

`get_health` includes:

- `watcher.state`: `stopped`, `starting`, `healthy`, `recovering`, or `degraded`.
- `watcher.active`: true only when watching is healthy.
- `watcher.indexMayBeStale`: true after a failure until catch-up succeeds.
- `watcher.readinessDelayed`: initial scanning has exceeded 30 seconds and is
  still pending (cleared on `ready` or stop).
- `watcher.restartAttempts`: retries used in this watcher lifetime.
- `watcher.lastError`: the most recent error's code, message, and timestamp
  (retained as history even after recovery).

In HTTP mode, `get_health` remains available while degraded, but other vault
tools are gated with `STALE_INDEX`. Stdio retains its existing behavior and may
return stale or partial graph-backed answers; inspect health before relying on
them. Resolve the filesystem
problem and restart OIL if retries are exhausted. An old chat whose OIL process
already crashed will still need a fresh connection; editing source cannot
repair an existing dead transport.

### Alternative: stdio connections for VS Code and Copilot CLI

**Do not use these stdio examples when the goal is one shared Windows service.**
They start a Node process per connection. Use
[Configure GitHub Copilot CLI](#configure-github-copilot-cli) below for shared HTTP.

**Option A: Run from GitHub** — add to `.vscode/mcp.json` in any workspace:

```json
{
  "servers": {
    "oil": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "--package=github:JinLee794/Obsidian-Intelligence-Layer#v0.5.5",
        "--",
        "obsidian-intelligence-layer",
        "mcp"
      ],
      "envFile": "${workspaceFolder}/.env"
    }
  }
}
```

The `.env` file must define `OBSIDIAN_VAULT_PATH` with an absolute path. The
release tag keeps installs reproducible, but this option runs the stable upstream
release and does not include this fork's HTTP transport or lifecycle extensions.
Use a local checkout when those extensions are required.

**Option B: Run a local checkout** — build the project first, then use:

```json
{
  "servers": {
    "oil": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/obsidian-intelligence-layer",
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/obsidian/vault"
      }
    }
  }
}
```

**Option C: Global local checkout** — add to `~/.copilot/mcp-config.json` so OIL is available across all Copilot CLI sessions and workspaces:

```json
{
  "mcpServers": {
    "oil": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/obsidian-intelligence-layer/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/obsidian/vault"
      }
    }
  }
}
```

> **Note:** Use absolute paths in `args` since there's no workspace-relative root. The top-level key is `mcpServers` (not `servers` like the workspace config).

Once configured, the agent can call any of OIL's 14 live tools by name.

---

## Install the Windows HTTP service

### Architecture and prerequisites

```text
Windows Service Control Manager
  OILMCP (WinSW, running as the selected Windows user)
    node.exe -> versioned OIL runtime
      http://127.0.0.1:8020/mcp
        one graph + one watcher
        separate MCP session/cache for each client
```

This is a real Windows service, not a Startup-folder launcher or a logon task.
It is configured for automatic delayed start and does not depend on Copilot
being open. One WinSW process plus one Node process is expected.

You need:

- Windows x64, PowerShell 7, Git, and Node/npm installed at an explicit path.
  The live deployment used Node `24.16.0`; the package declares Node 20 or newer.
  Review your organization's supported Node policy before choosing a version.
- Administrator approval for service creation, access controls, and account
  rights. Routine Copilot use does not require elevation.
- A Windows account with a usable password, permission to **Log on as a service**,
  and read/write access to the vault. A Windows Hello PIN is not that password.
  Do not switch silently to LocalSystem if account authentication fails.
- A real local vault directory available to that account. Do not depend on a
  drive mapped only in an interactive session.
- Port `8020` free on loopback. No inbound LAN firewall rule is required.
- A protected deployment directory outside the watched vault.

The service account has the selected user's filesystem privileges; it is not
sandboxed to the vault by Windows. OIL applies its own vault-path validation.
Use the least-privileged account appropriate for your machine.

For OneDrive vaults, mark required content **Always keep on this device** and
test access under the actual account. A service does not launch the user's
interactive OneDrive client or guarantee remote synchronization before sign-in.
BitLocker/unavailable volumes and files-on-demand can also delay access.

### Installation options

**On the original deployment machine**, helper scripts exist under
`V:\OneDrive\ghcli-working\scripts`:

| Script | Purpose |
|---|---|
| `Install-OilWindowsService.ps1` | Elevated initial installation, credential prompt, account validation, staging, and readiness check |
| `Get-OilDeploymentStatus.ps1` | Sanitized OIL configuration and service-process summary |
| `Test-OilHttpLive.mjs` | Read-only live MCP test with two clients; does not print note contents |
| `Restart-OilServiceTest.ps1` | Elevated stop/restart test; verifies port release and child exit |
| `Set-CopilotOilHttp.ps1` | Back up and change only the user-level `oil` entry; supports rollback |

These are **workspace-local operator tools, not repository files**. The installer
is pinned to the tested revision, Node location, and original account assumptions.
It refuses an existing service/configuration and is not an upgrade command.
The probe and client helper also contain machine-specific paths. Review them
before use on another machine; do not copy account tokens or private settings.

For a fresh machine without those helpers, follow the manual procedure below.
The manual examples reproduce the installed layout and settings, but should be
reviewed and validated on each target machine.

### 1. Build and verify the source

In a **fresh checkout** containing the feature commit, verify the source and run
the release checks. Do not discard an existing dirty worktree to follow this step.

```powershell
Set-Location 'C:\src\Obsidian-Intelligence-Layer'
git status --short
git show --no-patch --oneline 'e0874565d49422f42ad28f17337aed96487d398a'
git switch --detach 'e0874565d49422f42ad28f17337aed96487d398a'
npm ci
npm run build
npm run check:release
```

Stop if any command fails. `npm ci` runs the repository's `prepare` build;
the explicit build above ensures subprocess tests use current compiled output.
For a newer approved release, substitute its reviewed commit consistently in
the source checkout and deployment folder.

### 2. Prepare a protected deployment directory

Open **PowerShell 7 as Administrator**. Run installation steps 2-5 in the same
session, because later snippets use the settings defined here. Change the
example account and paths before running. Do not rerun over an existing service.

```powershell
$ErrorActionPreference = 'Stop'
$source = 'C:\src\Obsidian-Intelligence-Layer'
$root = 'C:\ProgramData\OIL'
$release = 'C:\ProgramData\OIL\releases\e087456'
$vault = 'D:\Notes\Vault'
$account = 'MYPC\alice' # Replace with the actual service account.
$node = 'C:\Program Files\nodejs\node.exe'
$npm = 'C:\Program Files\nodejs\npm.cmd'
$port = 8020

if (Get-Service -Name 'OILMCP' -ErrorAction SilentlyContinue) {
    throw 'OILMCP already exists. Use the maintenance procedure instead.'
}
if (Test-Path -LiteralPath $root) {
    throw 'Deployment directory already exists. Inspect it before continuing.'
}
if (!(Test-Path -LiteralPath $vault -PathType Container)) {
    throw 'The vault directory does not exist.'
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw 'The selected port is already in use.'
}
$sid = [Security.Principal.NTAccount]::new($account).Translate(
    [Security.Principal.SecurityIdentifier])
```

Create the directory with inheritance disabled. Administrators and SYSTEM own
deployment changes; the runtime account receives read/execute access. Only the
logs directory grants the runtime account Modify. This avoids running service
code from a broadly writable development directory.

```powershell
function Set-OilDirectoryAccess([string]$path, [bool]$writable) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in @('S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($id),
            'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    $rights = if ($writable) { 'Modify' } else { 'ReadAndExecute' }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid, $rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    Set-Acl -LiteralPath $path -AclObject $acl
}

New-Item -ItemType Directory -Path $root | Out-Null
Set-OilDirectoryAccess $root $false
foreach ($path in @($release, (Join-Path $root 'logs'), (Join-Path $root 'secrets'))) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}
Set-OilDirectoryAccess (Join-Path $root 'logs') $true
```

Do not continue if ACL setup fails. Confirm the runtime account separately has
the needed vault permissions; do not recursively replace the vault's ACLs.

### 3. Stage WinSW, production dependencies, and the token

Use the pinned WinSW x64 release below. The SHA-256 was cross-checked with the
Scoop package manifest during the deployment. It is a checksum pin, not a claim
of publisher signing. Re-review both release and checksum before changing versions.

```powershell
$wrapper = Join-Path $root 'OILMCP.exe'
Invoke-WebRequest `
    -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' `
    -OutFile $wrapper
$expected = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
if ((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash -ne $expected) {
    throw 'WinSW checksum mismatch. Do not execute it.'
}

Copy-Item -LiteralPath (Join-Path $source 'dist') -Destination $release -Recurse
foreach ($name in @('package.json', 'package-lock.json', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $release $name)
}
Push-Location $release
try {
    & $npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
} finally {
    Pop-Location
}
& icacls.exe $release /setowner '*S-1-5-32-544' /T /Q
if ($LASTEXITCODE -ne 0) { throw 'Could not set runtime ownership.' }

$tokenPath = Join-Path $root 'secrets\http-token'
$token = [Convert]::ToBase64String(
    [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).TrimEnd('=').Replace('+', '-').Replace('/', '_')
[IO.File]::WriteAllText($tokenPath, $token, [Text.UTF8Encoding]::new($false))
$token = $null
```

`--ignore-scripts` is intentional for this production copy: it already contains
the compiled `dist` output, and TypeScript is omitted with the development
dependencies. Do not use this command as a substitute for building the source.
Do not copy an arbitrary `node_modules` directory or `.npmrc` with credentials.

Expected layout:

```text
C:\ProgramData\OIL\
  OILMCP.exe
  OILMCP.xml
  releases\e087456\
    dist\
    node_modules\
    package.json
    package-lock.json
    README.md
  secrets\http-token
  logs\
```

### 4. Write the persistent service configuration

The wrapper executable and XML must have the same base name. This configuration
launches Node directly, without a PowerShell launcher or a new Node per chat.
XML escaping preserves paths containing spaces or `&`.

```powershell
$arguments = '"' + (Join-Path $release 'dist\index.js') +
    '" --transport http --vault-path "' + $vault +
    '" --http-host 127.0.0.1 --http-port ' + $port +
    ' --http-path /mcp --http-token-file "' + $tokenPath + '"'
$xml = @"
<service>
  <id>OILMCP</id>
  <name>OIL Shared MCP</name>
  <description>Shared authenticated loopback MCP host for a local vault.</description>
  <executable>$([Security.SecurityElement]::Escape($node))</executable>
  <arguments>$([Security.SecurityElement]::Escape($arguments))</arguments>
  <workingdirectory>$([Security.SecurityElement]::Escape($release))</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart/>
  <stoptimeout>15sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <logpath>$([Security.SecurityElement]::Escape((Join-Path $root 'logs')))</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@
[IO.File]::WriteAllText((Join-Path $root 'OILMCP.xml'), $xml, [Text.UTF8Encoding]::new($false))
```

The XML contains the **token-file path**, never the token or account password.
The vault is a persistent process-start argument; it is not an SCM temporary
"Start parameters" value. The log threshold is 10,240 KB with five retained
roll files per output stream.

### 5. Grant service logon and register the account

Before starting the service, an administrator must grant the chosen account
**Log on as a service**. In Local Security Policy (`secpol.msc`), open
**Local Policies > User Rights Assignment > Log on as a service** and add the
account. Confirm it is not denied by **Deny log on as a service**. On managed
machines, use the approved policy process; do not override organization policy.
If that console is unavailable, ask the Windows administrator to provision the
right. The original local installer uses the Windows LSA API for this step.

Register the service using a local secure credential prompt:

```powershell
$credential = Get-Credential -UserName $account -Message 'Windows account password for OIL service'
if ($null -eq $credential) { throw 'Credential entry cancelled.' }
$credentialSid = [Security.Principal.NTAccount]::new($credential.UserName).Translate(
    [Security.Principal.SecurityIdentifier])
if ($credentialSid.Value -ne $sid.Value) { throw 'Credentials belong to a different account.' }
try {
    New-Service -Name 'OILMCP' -DisplayName 'OIL Shared MCP' `
        -Description 'Shared authenticated loopback MCP host for a local vault.' `
        -BinaryPathName ('"' + $wrapper + '"') -StartupType Automatic -Credential $credential
} finally {
    $credential = $null
}
sc.exe config OILMCP start= delayed-auto
if ($LASTEXITCODE -ne 0) { throw 'Could not configure delayed startup.' }
```

Do not additionally run `OILMCP.exe install` after `New-Service`: the service is
already registered. Omitting account configuration from a wrapper installation
can result in the wrapper's default identity rather than the selected user.
Windows manages the service credential; no password belongs in this README,
the XML, command-line arguments, transcripts, or source control.

Open `services.msc` and inspect **OIL Shared MCP**:

- **Log On:** confirm the intended account, not LocalSystem.
- **Recovery:** first failure = Restart after 10 seconds; second failure =
  Restart after 30 seconds; subsequent failures = Take No Action; reset count
  after one day. Verify the resulting settings with `sc.exe qfailure OILMCP`.
  Recovery is for process failure, not a promise of hang detection or fresh data.
- **Startup type:** Automatic (Delayed Start).

Start it:

```powershell
Start-Service -Name 'OILMCP'
Get-CimInstance Win32_Service -Filter "Name='OILMCP'" |
    Select-Object Name, State, StartName, StartMode, ProcessId
```

If startup fails, stop here and troubleshoot; do not change clients yet.
For the first trial, use a disposable vault. Switching to a live vault permits
normal OIL indexing/persistence and, once enabled in clients, write-tool use.

### 6. Verify readiness and the single Node child

Use a local PowerShell script or session to read the token in memory. Do not
put its literal value into a `curl -H` command or share headers in diagnostics.

```powershell
$token = [IO.File]::ReadAllText('C:\ProgramData\OIL\secrets\http-token').Trim()
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8020/readyz' `
        -Headers @{ Authorization = ('Bearer ' + $token) } -TimeoutSec 10
} finally {
    $token = $null
}
```

HTTP 503 can be normal during indexing; retry with a bounded delay and inspect
logs if it persists. Expected eventual result: `state: ready`, `ready: true`.
An unauthenticated request returning 401 is expected, not a service failure.
Use the exact `127.0.0.1` authority; `localhost` is not an accepted Host alias.

In an elevated session, verify service ownership and processes:

```powershell
$service = Get-CimInstance Win32_Service -Filter "Name='OILMCP'"
Get-CimInstance Win32_Process -Filter "ParentProcessId=$($service.ProcessId)" |
    Select-Object Name, ProcessId, ParentProcessId
Get-NetTCPConnection -LocalPort 8020 -State Listen |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

Expect one `node.exe` child and a `127.0.0.1` listener. Also check for old stdio
launches or scheduled tasks; parent-child inspection alone does not detect all
duplicate OIL processes. Disable only identified obsolete OIL launchers after
successful cutover. **Never kill all Node processes.**

## Configure GitHub Copilot CLI

### User configuration and authentication

Run Copilot as your normal Windows user. Its user configuration is
`~\.copilot\mcp-config.json`, where `~` means that user's actual profile directory.
It is not necessarily `C:\Users\<account-name>`; renamed accounts can retain an
older profile folder. The tested installation used the user's global config.

1. Confirm `/readyz` succeeds before changing anything.
2. Back up `mcp-config.json` into a user-private folder. The backup may contain
   credentials for other MCPs and must be protected too.
3. Through File Explorer **Properties > Security > Advanced**, restrict the
   config file and backup folder to the current user, SYSTEM, and Administrators.
   Disable inherited broad access and remove other explicit grants. Preserve
   the intended user's ability to read/write the config. Follow organizational
   policy if it requires different managed principals.
4. Merge the following **`oil` entry only** under the existing `mcpServers` key.
   Do not replace the whole file or duplicate that key.

```json
{
  "mcpServers": {
    "oil": {
      "type": "http",
      "url": "http://127.0.0.1:8020/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_LOCAL_TOKEN"
      },
      "tools": ["*"],
      "timeout": 60000
    }
  }
```

The placeholder is not a working credential. In a private local editor, replace
it with the token from `C:\ProgramData\OIL\secrets\http-token` and retain the
`Bearer ` prefix. Do not commit, paste into chat, or share either file. Avoid
clipboard-history/cloud-clipboard exposure. The tested setup stores the header
value directly in the access-restricted user configuration: **it is not encrypted
or dynamically read from the token file by Copilot**. Do not substitute an
unverified `${env:...}` or file-reference syntax and assume it will resolve.

If Copilot runs under a different Windows account, explicitly authorize that
account and provision its client credential; do not grant token access to
Everyone. Possession of the shared token permits access to all enabled vault
tools. `"tools": ["*"]` includes write tools; for read-only clients, list only
the desired read-tool names.

Remove the old OIL `command`, `args`, `env`, and `envFile` fields when replacing
a stdio entry. The HTTP service already has its vault configuration. Do not leave
an old OIL entry enabled under another name. `OIL_HTTP_TOKEN_FILE` configures the
**server**, not the client's Authorization header.

The CLI also provides `/mcp add` and `copilot mcp add --transport http`, but
avoid passing a real token via `--header` on the shell command line: it can be
captured in shell history/process arguments. Prefer the access-restricted local
configuration or a client-supported secure credential entry workflow.

On the original machine, the local helper performs readiness validation,
protected backups, a guarded configuration replacement, and preservation of
other MCP entries without printing the token:

```powershell
& 'V:\OneDrive\ghcli-working\scripts\Set-CopilotOilHttp.ps1' -Mode Apply
```

This helper is not distributed in the repository and is pinned to the local
endpoint and token location. Do not rerun it if you have intentionally selected
a different port/path without first adapting those settings.

### Verify Copilot

```powershell
copilot mcp list
```

Confirm `oil (http)` appears. Inspect workspace/plugin configuration for duplicate
OIL entries or overrides. Do not use `--show-secrets` in shared diagnostic output.
For direct configuration-file edits, exit/relaunch Copilot or use `/restart` so
the current process loads the new settings. The interactive `/mcp` workflow may
apply changes immediately, but a fresh process is the verified cutover path.

In the restarted session, ask:

> Call OIL get_health. Report readiness, watcher status, and indexed note count.
> Then search for a note, retrieve its metadata, and read one heading section.
> Do not modify any notes.

Success means actual tool calls appear and return results, not just an assistant
saying that the service is connected. Expected health includes `ready: true`,
watcher `healthy`, and a plausible nonempty note count.

For a narrowly scoped non-interactive check on the tested CLI:

```powershell
copilot --no-custom-instructions --disable-builtin-mcps --available-tools 'oil-get_health' --allow-tool 'oil(get_health)' --no-ask-user --stream off -p 'Call oil get_health once. Report only readiness, watcher state and indexed note count. Do not use other tools.'
```

This restricts model-visible tools; it does not necessarily prevent all other
configured MCP servers from starting. To exclude those from a diagnostic run,
add `--disable-mcp-server NAME` for the actual unrelated server names shown by
`copilot mcp list`. Tool-name filtering/flags may vary by CLI version; check local
`--help`. Do not enable blanket tool permissions just to perform a health check.

Copilot CLI and VS Code have separate registries. For VS Code HTTP configuration,
the equivalent workspace entry goes under `servers` in `.vscode\mcp.json`, not
`mcpServers`. Never commit a real token in a shared workspace file. Scout also
has independent configuration and has not been migrated by this procedure.

## Use OIL from Copilot

Example read-only requests:

- "Check OIL health before answering."
- "Search my vault for the project kickoff; show the matching note paths."
- "Get metadata for this note, then read its Team section only."
- "Find notes where the status frontmatter contains active."
- "Show entities linked to this note."

Tools accept **vault-relative note paths**, such as `Projects/Example.md`, not
Windows absolute paths. Section headings omit Markdown `#` prefixes. Ask for
metadata first when you do not know the exact heading.

For an explicitly approved write, fetch `get_note_metadata`, then pass its fresh
`mtime_ms` as `expected_mtime` to `atomic_append` or `atomic_replace`.
`create_note` fails if the target already exists. Re-read after a conflict rather
than guessing a timestamp. Existing write tools are not made read-only by HTTP
authentication, and safe-write checks are not a replacement for note backups.

All HTTP clients share the index/watcher but have separate session caches.
Closing one chat or Copilot does not stop OIL. Sessions expire after 30 idle
minutes. Following expiry or service restart, the client must reinitialize;
if an existing chat cannot recover, reconnect/restart that client. Automatic
recovery of every already-open client is not guaranteed.

## Service operation and maintenance

### Start, stop, status, and logs

Run service-control commands in elevated PowerShell:

```powershell
Get-Service -Name 'OILMCP'
Start-Service -Name 'OILMCP'
Stop-Service -Name 'OILMCP'
Restart-Service -Name 'OILMCP'
sc.exe qc OILMCP
sc.exe qfailure OILMCP
```

These are separate operations, not a sequence to run unconditionally.
Before a planned stop, finish outstanding write requests. WinSW attempts Ctrl+C
and waits up to 15 seconds; OIL's own bounded cleanup may exit earlier.
Verify `/readyz` after a restart, and remember that old MCP session IDs expire.

```powershell
Get-Content -LiteralPath 'C:\ProgramData\OIL\logs\OILMCP.err.log' -Tail 60
Get-ChildItem -LiteralPath 'C:\ProgramData\OIL\logs'
```

OIL diagnostics normally appear in the stderr log; WinSW also produces wrapper
diagnostics and may report failures in Windows Event Viewer. Logs can contain
vault paths or operational details: sanitize them before sharing. In the local
helper workflow, `install-status.json` and `restart-test.json` provide sanitized
outcomes; the manual installation does not generate those files.

### Change the vault path or port without reinstalling

1. Verify the new directory exists, is local/available, and grants the service
   account appropriate access. Keep the token outside **both** old and new vaults.
2. Stop OIL and wait for the service/child/listener to stop.
3. Back up `C:\ProgramData\OIL\OILMCP.xml` inside the protected deployment directory.
4. In an elevated local editor, change only the quoted `--vault-path` value in
   `<arguments>`. Preserve the runtime path, token-file path, and XML escaping.
   If changing `--http-port` or `--http-path`, update every client URL too.
5. Start OIL and check `/readyz`, `get_health`, and a read-only note lookup from
   the intended vault. The new vault may require a full initial index.
6. If validation fails, stop OIL, restore the XML backup, restart, and restore
   any changed client URLs.

Do not use the Services console's temporary "Start parameters" box. Do not
restart while editing a partially written XML file. There is no hot-switch API
or shipped general-purpose update command yet.

### Upgrade OIL

Build and validate a reviewed revision in a separate clean checkout. Stage its
`dist`, package/lock files, and production dependencies into a **new versioned
directory** under `releases`, using the same permissions as the original.
Do not build over the running deployment or use a moving Git branch as the
service's executable location.

Back up XML, stop OIL, then change both the entrypoint in `<arguments>` and
`<workingdirectory>` to the new release. Retain the vault, token, and endpoint
settings. Start and run the readiness/MCP read tests. If they fail, stop and point
XML back to the previous release. Do not delete the old release until the trial
is accepted. Check release notes for index-format compatibility before rollback.
Changing source files or pulling this repository does **not** update the running
service automatically. Node itself is an external installed dependency; validate
Node upgrades separately.

### Rotate the HTTP token or account password

The HTTP token and Windows account password are different credentials:

- **HTTP token:** stop OIL, replace only the protected token file with a new
  randomly generated value, update the Authorization header in each protected
  client configuration, then start OIL and restart/reconnect clients. Verify
  that the old token receives 401. Rotate if the token or config backup leaks.
- **Windows password:** after changing the account password, update the service
  credential locally in **Services > OIL Shared MCP > Properties > Log On**.
  Test a stop/start afterward; an already-running process can mask a credential
  problem until the next start. Never put the password in XML or Git.

### Acceptance checks still required for your machine

Test startup after reboot and before sign-in, access to locally cached cloud
files, a deliberately unavailable vault, and client recovery from session expiry.
Observe a representative workday with multiple chats and scheduled automation:
CPU, memory, session counts, watcher freshness, and tool latency should stabilize.
A running service or a 200 liveness response alone does not establish this.
Failure-recovery policy should be tested in a controlled maintenance window.
Do not promise a fixed RAM/CPU reduction merely because there is now one host.

## HTTP service troubleshooting

| Symptom | Check / action |
|---|---|
| UAC or credential window cancelled | Installation is incomplete; verify service existence before retrying. Enter credentials only in the local prompt. |
| Account logon fails / service error 1069 | Use the account password, not a PIN; confirm account identity, password policy, service-logon right, and deny policies. Avoid repeated attempts that risk lockout. |
| Installer reports an existing service or XML | Inspect the partial/existing deployment. Do not delete it or rerun an initial installer blindly; use maintenance or deliberate rollback. |
| Native error detail is absent from a local helper | Read the local window and Windows service/event logs. An empty helper status is not proof of a bad password. |
| Service Running but tools fail | Check authenticated `/readyz` and MCP `get_health`; the process may be initializing or degraded. |
| HTTP 401 | Missing/wrong token or a client still using the old header after rotation. |
| HTTP 403 | Invalid Host/Origin. Use exactly `http://127.0.0.1:8020`, not `localhost`, a machine name, proxy, or LAN IP. |
| HTTP 404 with a session ID | The session expired or the service restarted. Reinitialize without the old ID. |
| HTTP 405 for `GET /mcp` | Expected: standalone SSE is not offered. Select Streamable HTTP, not legacy SSE; use MCP POST initialization/tool calls. |
| HTTP 413 / 415 | Request too large / incorrect content type. MCP POST uses `application/json`. |
| HTTP 429 / `LIMIT_EXCEEDED` | Concurrency or session limit reached. Back off, release unused sessions, and retry; do not create unlimited clients. |
| `/readyz` 503 / `STALE_INDEX` | Wait for initialization, or investigate watcher/permissions/parse errors. `get_health` remains available. |
| Missing vault or malformed YAML | Correct the path, access, or syntax, then restart. HTTP startup must not silently substitute an empty healthy vault. |
| Port 8020 already occupied | Identify its owning PID/service. Do not kill unrelated processes. Stop only an obsolete OIL launcher, or select another port consistently. |
| Copilot lists OIL but cannot call it | Confirm header, exact endpoint, tool filter, fresh CLI session, workspace/plugin overrides, and organization MCP allowlist. |
| More than one OIL Node process | Check for old stdio entries, Startup-folder launches, tasks, manual listeners, and other clients still configured for stdio. |
| Slow OneDrive/initial scan | Confirm files are local. A slow scan is not itself a reason to restart repeatedly. Inspect readiness and actual watcher state. |
| Stop hangs or forced-exit message | Inspect outstanding work and logs. Forced shutdown can interrupt writes; do not claim a graceful stop based only on the service status. |

## Rollback and uninstall

For client rollback, restore **only the former `oil` entry** from the protected
backup, or remove it if no entry existed. Preserve unrelated MCP settings added
since the backup. Restart Copilot. On the original machine, the helper supports:

```powershell
& 'V:\OneDrive\ghcli-working\scripts\Set-CopilotOilHttp.ps1' -Mode Rollback -BackupPath 'C:\Users\Example\.copilot\oil-service-backups\mcp-config-before-oil-YYYYMMDD-HHMMSS.json'
```

Replace the illustrative backup path with the actual one. Returning to stdio
creates per-client Node processes again; stop the shared service after clients
have switched away to avoid running both deployments unnecessarily.

To uninstall service registration, first remove/switch client entries, then:

```powershell
# Elevated PowerShell; confirm the target service name before running.
Stop-Service -Name 'OILMCP'
sc.exe delete OILMCP
```

Confirm the child exits and the port is free. Close Services/Event Viewer handles
if Windows reports the service is marked for deletion. Keep logs/config/runtime
for diagnosis until rollback is accepted, then remove only the specifically
reviewed OIL deployment files. Removing the service does not revoke an account's
service-logon right; consult the administrator before removing a right that
another service may also need.

**Never delete the vault, note backups, automation lock files, or unrelated Node
processes as part of uninstall.** Service registration, client settings, runtime
files, credentials, and vault data are separate lifecycle concerns.

### Reference documentation

- [WinSW 2.12.0 XML configuration](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md)
- [WinSW logging and rotation](https://github.com/winsw/winsw/blob/v2.12.0/doc/loggingAndErrorReporting.md)
- [WinSW 2.12.0 release](https://github.com/winsw/winsw/releases/tag/v2.12.0)
- [Scoop WinSW manifest (checksum corroboration; moving reference)](https://github.com/ScoopInstaller/Main/blob/master/bucket/winsw.json)
- [GitHub Copilot CLI: adding MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [Windows service user accounts](https://learn.microsoft.com/en-us/windows/win32/services/service-user-accounts)

---

## Tools Reference

OIL exposes **14 live tools** across five categories.

### Core Visibility (1 tool) — Tiny runtime summary

Use this first when a client needs fast runtime state without paying the cost of a detailed audit read.

| Tool | What It Does |
|---|---|
| `get_health` | Returns server identity, live tool-surface counts, index freshness, cache stats, watcher state, and whether audit logs are available. This is the summary visibility tool; use `get_agent_log` only when you need detailed write history. |

### Search & Inspect (6 tools) — Token-efficient reads

All read-only. No confirmation needed.

<p align="center">
  <img src="docs/assets/oil-search-inspect.gif" alt="Search & Inspect tools — ranked snippets, section reads, graph traversal" width="800" />
</p>

| Tool | What It Does |
|---|---|
| `search_vault` | Unified search across lexical and fuzzy tiers, with optional folder and tag filters. Returns ranked results with excerpts. |
| `semantic_search` | Natural-language search combining fuzzy title matching with in-memory content search. Returns ranked results with short snippets. |
| `query_frontmatter` | Lookup notes by frontmatter key and value fragment — resolved from the in-memory graph, no disk scan. Example: find all notes where `tpid` contains `"12345"`. Returns up to 20 paths. |
| `get_note_metadata` | Peek at a note before loading full content — returns frontmatter, timestamps, word count, heading list, and `mtime_ms` (needed for writes). |
| `read_note_section` | Read only a specific heading section from a note. The most token-efficient read — request `## Team` instead of loading a 5,000-word note. |
| `get_related_entities` | Graph traversal from a note — returns linked notes up to N hops away, paths and titles only, capped at 50. Default: 2 hops. |

### Safe Writes (3 tools) — Atomic writes with mtime concurrency

All write tools require `expected_mtime` (from `get_note_metadata`) or check for file existence. If the file has changed since you last read it, the write is rejected immediately.

<p align="center">
  <img src="docs/assets/oil-safe-writes.gif" alt="Safe Writes — mtime concurrency check flow" width="800" />
</p>

| Tool | What It Does |
|---|---|
| `atomic_append` | Append content under a specific heading. Requires `expected_mtime`. Rejected if the file changed since you read it. Returns new `mtime_ms`. |
| `atomic_replace` | Replace entire note content. Same `expected_mtime` check. Use for full-file rewrites when section-level append isn't enough. Returns new `mtime_ms`. |
| `create_note` | Create a new note at a given path. Fails cleanly if the note already exists — use `atomic_replace` to update existing notes. |

### Customer Workflows (3 tools) — Domain-specific assembly

High-level tools that encode business logic the LLM would otherwise need to reconstruct from scratch on every request.

<p align="center">
  <img src="docs/assets/oil-customer-workflows.gif" alt="Customer Workflows — single call assembles full customer snapshot" width="800" />
</p>

| Tool | What It Does |
|---|---|
| `get_customer_context` | Assembles a full customer snapshot: frontmatter, opportunities with GUIDs, milestones, team composition, recent meetings, linked people, and open action items. Accepts a customer name or TPID, plus `view=brief|full|write` for compact reads or deterministic write scaffolding. |
| `prepare_crm_prefetch` | Extracts vault-stored CRM identifiers (opportunity GUIDs, TPIDs, account IDs) for one or more customers. Returns structured data with OData filter hints ready for CRM query construction. |
| `check_vault_health` | Scans the vault for stale Agent Insights (>30 days), opportunities or milestones missing IDs, notes without a `## Team` section, and orphaned meeting notes. Returns a prioritized issue list. |

### Audit & Observability (1 tool)

<p align="center">
  <img src="docs/assets/oil-audit-log.gif" alt="Audit & Observability — every write logged with timestamp and detail" width="800" />
</p>

| Tool | What It Does |
|---|---|
| `get_agent_log` | Read the agent write audit log for a given date (default: today). Every `atomic_append`, `atomic_replace`, and `create_note` call is logged here with timestamp, path, and operation detail. |

### Write Safety Pattern

The write tools use **mtime-based concurrency checks** — no write queues, no approval flows:

```
1. Agent calls get_note_metadata(path) → receives mtime_ms
2. Agent decides to write
3. Agent calls atomic_append(path, heading, content, expected_mtime=mtime_ms)
      │
      ├─ Read current mtime from disk
      │
      ├─ Matches? → Execute write, invalidate cache, return new mtime_ms
      │
      └─ Mismatch? → "Stale write rejected" — agent must re-read and retry
```

If a workflow requires user approval, that's handled by the Copilot UI — the MCP server simply executes or rejects.

---

## Configuration

Create `oil.config.yaml` in your vault root to customize folder layout and field names. Omit it entirely to use sensible defaults. Supports **snake_case YAML** that remaps to camelCase internally.

```yaml
# Folder layout (where things live in your vault)
schema:
  customers_root: "Customers/"
  people_root: "People/"
  meetings_root: "Meetings/"
  projects_root: "Projects/"
  weekly_root: "Weekly/"
  templates_root: "Templates/"
  agent_log: "_agent-log/"
  connect_hooks_backup: ".connect/hooks/hooks.md"
  opportunities_subdir: "opportunities/"
  milestones_subdir: "milestones/"
  insights_subdir: "insights/"

# Frontmatter field names (match your vault conventions)
frontmatter_schema:
  customer_field: "customer"
  tags_field: "tags"
  date_field: "date"
  status_field: "status"
  project_field: "project"
  tpid_field: "tpid"
  accountid_field: "accountid"

# Search and indexing
search:
  graph_index_file: "_oil-graph.json"         # Persisted link graph
  background_index_threshold_ms: 3000         # Background rebuild threshold (ms)

# Write configuration
write_gate:
  diff_format: "markdown"
  log_all_writes: true                        # Log every write to _agent-log/
  batch_diff_max_notes: 50
  auto_confirmed_sections:
    - "Agent Insights"
    - "Connect Hooks"
  auto_confirmed_operations:
    - "log_agent_action"
    - "capture_connect_hook"
    - "patch_note_designated"
```

---

## Project Structure

```
src/
├── index.ts          # Entry point — startup sequence, tool registration, shutdown
├── cli.ts            # CLI wrapper — .env loading, subcommand routing
├── startup-config.ts # Validated startup arguments, vault path, loopback/token settings
├── http-server.ts    # Authenticated HTTP listener, sessions, limits, and bounded close
├── http-runtime.ts   # Shared graph/watcher, background initialization, health, tool wiring
├── runtime-state.ts  # Readiness/concurrency gate shared by HTTP vault tools
├── shutdown.ts       # Process cleanup; stdio EOF handling, signals, forced-exit backstop
├── types.ts          # Shared TypeScript types (NoteRef, OilConfig, etc.)
├── config.ts         # Reads oil.config.yaml from vault root; merges with defaults
├── validation.ts     # Input validation — path safety, GUID format, ISO dates
├── vault.ts          # Filesystem read layer — note parsing, frontmatter, sections, wikilinks
├── graph.ts          # GraphIndex — bidirectional link graph, tag index, N-hop traversal
├── cache.ts          # SessionCache — LRU note cache (200 notes, 5min TTL)
├── watcher.ts        # VaultWatcher — chokidar file watcher, invalidates caches on change
├── gate.ts           # Write helpers — appendToSection, executeWrite, audit logging
├── query.ts          # Frontmatter predicate query engine
├── search.ts         # Fuzzy search (fuse.js) + in-memory content search
├── hygiene.ts        # Vault freshness scanning, staleness detection, health scoring
├── correlate.ts      # Entity matching — cross-references external IDs with vault notes
├── tool-responses.ts # Shared MCP JSON response helpers — structured errors, refs, version hints
├── version.ts        # Server identity — name/version shared by runtime and tools
└── tools/
    ├── core.ts       # 1 tool — get_health
    ├── retrieve.ts   # 6 tools — search, semantic search, query, metadata, section reads, related
    ├── write.ts      # 4 tools — atomic_append, atomic_replace, create_note, get_agent_log
    ├── domain.ts     # 3 tools — get_customer_context, prepare_crm_prefetch, check_vault_health
    ├── orient.ts     # (unregistered) Context assembly primitives from earlier design
    └── composite.ts  # (unregistered) Cross-MCP workflow tools from earlier design
```

### What Each Layer Does

| Layer | Role |
|---|---|
| **startup-config.ts** | Resolves explicit arguments/environment values and validates HTTP startup requirements |
| **http-server.ts** | Authenticates loopback requests and manages bounded per-client MCP sessions |
| **http-runtime.ts / runtime-state.ts** | Own shared vault state and guard tool calls until ready, with concurrency limits |
| **vault.ts** | Reads markdown files from disk, parses frontmatter + section maps |
| **graph.ts** | Builds a bidirectional link graph from wikilinks across all notes |
| **cache.ts** | LRU cache — avoids re-reading disk across multi-turn conversations |
| **search.ts** | Finds notes by content: fuzzy title match + in-memory body snippet scan |
| **gate.ts** | Section-level appends and full-file writes with audit logging |
| **hygiene.ts** | Domain-aware staleness checks (insights age, missing IDs, orphaned meetings) |
| **validation.ts** | Rejects bad paths, names, and IDs before they hit disk |
| **tools/*.ts** | Exposes everything above as named MCP tools |

---

## How It Works

### Startup Sequence

Both `node dist/index.js` and `node dist/cli.js mcp` use the same runtime.
The CLI additionally loads `.env` from its working directory. The Windows
service launches `dist/index.js` directly with explicit persistent arguments.

**HTTP mode:**

```
1. Validate arguments, canonical vault directory, loopback settings, and token file
2. Load oil.config.yaml (missing file uses defaults; parse/access errors fail)
3. Open authenticated HTTP listener; MCP initialize and health can respond
4. Start the shared watcher, then load/reconcile the graph (full build if needed)
5. Mark ready only when index initialization and watcher health permit it
6. Create a separate MCP server/cache for each connecting client; expose 14 tools
7. Gate vault tools on readiness and shared concurrency; keep get_health available
```

Clients may initialize at step 3, before the index is ready. Watcher events
arriving during a build wait before updating the graph.

**Stdio mode (compatibility option):**

```
1. Resolve arguments or OBSIDIAN_VAULT_PATH and load vault configuration
2. Load the persisted index or perform the initial full build
3. Reconcile a loaded index in the background; await persistence on a cold build
4. Start watcher, create session/cache, and register all 14 tools
5. Connect stdio transport
6. Clean up on client EOF, transport closure, or shutdown signal
```

### Request Flow (Example: read the Team section from a customer note)

```
Agent calls: read_note_section({ path: "Customers/Contoso.md", heading: "Team" })
      │
      ▼
  retrieve.ts handler
      │
      ├─ validation.ts → validateVaultPath()    ← reject traversal attacks, bad chars
      │
      ├─ vault.readNote("Customers/Contoso.md") ← parse file, extract sections map
      │
      ├─ sections.get("Team")                   ← O(1) lookup
      │
      └─ Return JSON: { path, heading, content }
```

The agent gets **just the section it needs** — not the entire note.

---

## Architecture Deep Dive

### Index Stack

OIL maintains in-memory indices so most tool calls resolve in milliseconds:

```
┌──────────────────────────────────────────────────────┐
│  Tier 0: Graph Index (persistent, _oil-graph.json)   │
│  Wikilinks, backlinks, tags, frontmatter per note    │
│  Full rebuild on first run; incremental on startup   │
│  Backlink lookup: O(1)                               │
├──────────────────────────────────────────────────────┤
│  Tier 1: Fuzzy Search Index (in-memory, lazy)        │
│  fuse.js — built on first search, invalidated on     │
│  file change. Subsequent searches: ~10ms             │
├──────────────────────────────────────────────────────┤
│  Tier 2: Session Cache (in-memory, per-connection)   │
│  LRU, 200 notes, 5min TTL — avoids re-reading disk   │
│  across multi-turn conversations                     │
└──────────────────────────────────────────────────────┘
```

### Frontmatter Index

`query_frontmatter` resolves against an in-memory index derived from the graph on each call — mapping every frontmatter key to `{ path, value }` entries across all notes. No disk scan needed, no separate index file.

### File Watcher

`chokidar` watches the vault for changes. When a file changes:

1. Graph index re-indexes that node (rebuild outlinks, recompute backlinks)
2. Session cache invalidates the note entry
3. Fuzzy search index marked dirty (rebuilt on next search call)

### Response Shaping

Every tool response minimizes tokens while maximizing usability:

- **Sections, not full files:** `read_note_section` returns only the heading you asked for
- **Metadata before content:** `get_note_metadata` lets the agent peek (word count, headings) before committing to a full read
- **Snippets, not documents:** search tools return match snippets, not entire notes
- **Capped results:** Search capped at 20, graph traversals at 50 — prevents context blowout
- **mtime in every metadata read:** Included so the agent can chain read → write without an extra round-trip

---

## Development

### Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode (recompiles on change)
npm run lint         # Type-check without emitting
npm test             # Unit/lifecycle tests, then isolated performance gates
npm run test:unit    # Unit tests (accepts Vitest file filters)
npm run test:perf    # Performance gates without competing test files
npm run test:package # Package, install in a temporary project, test stdio MCP
npm start            # Run the server (needs OBSIDIAN_VAULT_PATH)
npm run bench        # Run benchmark suite (vitest)
npm run bench:watch  # Benchmarks in watch mode
```

### Build Requirements

The lifecycle regression tests spawn the compiled server against disposable
vaults (never the user's vault). Build first:

```bash
npm run build
npx vitest run src/__tests__/stdio-lifecycle.test.ts
```

Coverage includes ordinary EOF, startup input preservation, early EOF, multiple
clients, a force-killed client (with a `cmd.exe` launcher on Windows), cleanup
failure/timeout, watcher-error survival followed by EOF shutdown, and HTTP
remaining available after stdin closes. The tests
terminate only their own fixture processes.

The HTTP suites cover authenticated clients, session isolation/expiry, resource
limits, readiness during blocked indexing, startup edits, stale writes, vault
failure, and graceful shutdown. Run the complete release gate after building:

```powershell
npm run build
npm run check:release
```

Source-level watcher/health tests do not require rebuilding `dist`:

```bash
npx vitest run src/__tests__/watcher.test.ts src/__tests__/watcher-recovery.test.ts src/__tests__/graph.test.ts src/__tests__/tools-core.test.ts
npm run lint
```

- Node.js ≥ 20
- TypeScript 5.7+
- ES2022 target, Node16 module resolution

### Adding a New Tool

1. Decide which category: `retrieve` (read-only), `write` (modifies vault), or `domain` (business logic assembly).

2. Open the corresponding file in `src/tools/`.

3. Add a `server.registerTool()` call:

```typescript
server.registerTool(
  "my_tool_name",
  {
    // Write the description as a routing signal — tell the LLM WHEN to call this.
    description: "Does X when the agent needs Y. Primary tool for [workflow step].",
    inputSchema: {
      param_name: z.string().describe("What this param means"),
    },
  },
  async ({ param_name }) => {
    const result = { /* ... */ };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);
```

4. If the tool writes to the vault, use the mtime concurrency pattern:
   - Accept `expected_mtime` as a required parameter
   - Check the current mtime before writing; reject immediately if mismatched
   - Invalidate the session cache after a successful write
   - Return the new `mtime_ms` so the agent can chain further writes
   - Call `logWrite()` for the audit trail

5. Rebuild: `npm run build`

### Key Conventions

- **Zod v4**: `z.record()` needs two args: `z.record(z.string(), z.unknown())`, not one.
- **ES modules**: All imports use `.js` extensions (`import { foo } from "./bar.js"`).
- **Logging**: Use `console.error()` (not `console.log`) — stdout is reserved for MCP protocol messages.
- **Tool descriptions**: Write them as routing instructions. Answer "When should the agent call this?" not just "What does it do?"

---

## FAQ

### Why MCP instead of a REST API?

MCP is the protocol that AI agents (Copilot, Claude, etc.) use to discover and call tools. A REST API would require the agent to know your endpoint URL, handle auth, and parse responses — MCP handles all of that via the client integration.

### Does Obsidian need to be running?

No. OIL reads/writes the vault folder directly on disk. Obsidian will pick up changes when it's next opened (or immediately if it's running, since it also watches the folder).

### What's the difference between `search_vault` and `semantic_search`?

`search_vault` is the primary search tool — it runs lexical (substring) search first, then falls back to fuzzy title matching, with folder and tag filter support. `semantic_search` is broader: it combines fuzzy title matching with in-memory body snippet scanning for natural-language queries. Both return ranked results with snippets. Neither requires an external API or model download.

### What about CRM integration?

OIL doesn't query CRM directly. It surfaces vault-stored identifiers (opportunity GUIDs, TPIDs, account IDs) through `prepare_crm_prefetch`. The agent takes those IDs and calls a separate CRM MCP (e.g., MSX) itself.

### What happens if I don't create `oil.config.yaml`?

All defaults are used. Customers in `Customers/`, people in `People/`, meetings in `Meetings/`, etc. See the [Configuration](#configuration) section for the full default set.

### How do I see what the agent wrote to my vault?

Use `get_health` first if you only need a quick status check. Use `get_agent_log` when you need the detailed write audit for today (or any specified date in `YYYY-MM-DD` format). Every `atomic_append`, `atomic_replace`, and `create_note` call is logged with timestamp, path, and operation detail.

### Can I undo agent writes?

Writes require a valid mtime check, so accidental stale overwrites are prevented. For rollback, use Obsidian's built-in file recovery or git.
