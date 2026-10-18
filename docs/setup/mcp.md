# MCP

Pi `>=1.0.0` provides native MCP integration; no companion is required. Keep personal servers global and project-only servers in trusted project configuration. Package updates do not overwrite either file.

## Configuration precedence and scope

Native Pi reads:

- `~/.pi/agent/mcp.json`: personal servers.
- `.pi/mcp.json`: project servers, only after project trust.

A project server replaces the personal server with the same name. A project entry containing only `enabled`, `exposure` or `toolExposure` overrides those fields without replacing the server connection.

Shared `~/.config/mcp/mcp.json` and project `.mcp.json` are other-client/legacy files, not native Pi auto-load paths. Preserve them. Convert selected entries only after a separate approved proposal; never silently move credentials or delete old configurations.

## Browser assistance

The package includes opt-in access to an already-running default Chrome profile through official Chrome DevTools MCP. No additional Chrome extension is needed. Chrome chooses the profile; arbitrary profile selection is unsupported.

### One-time setup and everyday use

1. Run `/browser setup` for a read-only audit and numbered proposals. It never installs, connects or changes settings.
2. Use local stable Chrome **144+** and the package's supported Node version. If managed, check `chrome://management`, relevant `chrome://policy` entries and IT approval for browser/model data access. Remote/container/WSL attachment is not promised.
3. If permitted, enable remote debugging yourself at `chrome://inspect/#remote-debugging`.
4. While Pi is idle, invoke **`/browser enable`** and approve its persistent-access notice. It saves global opt-in in `~/.pi/agent/browser/config.json` and registers tools now. This allows browser tools in later interactive TUI/RPC sessions and reloads without repeating Pi setup/confirmation. First use may download/execute the pinned MCP process through `npx` with Pi's OS permissions.
5. On browser use, approve Chrome's own connection prompt as required. Verify a recognizable pre-existing tab/account before private reads. Chrome can expose every window in its default profile.

The interface is limited to `/browser setup`, `/browser enable`, `/browser disable` and `/browser status`. Setup once, then start Pi and ask for browser work; no manual connection commands are needed. Former lifecycle arguments are rejected with guidance and never silently grant persistent access. Missing preferences mean off; package installation never enrolls a device. Print/JSON sessions do not auto-register tools even when remembered access is enabled.

`pi/extensions/browser/controller.ts` owns the pin/flags. Native Pi owns the per-session `pi-setup-browser` registration and transport; tools use `mcp__pi_setup_browser__*` through codemode. No persistent MCP definition, shared daemon, profile copy or browser credentials are stored.

### Ownership, status and revocation

- `/browser status` and `browser_status` read registration/preference metadata only, not page data or browser identity. Tool availability is not verified attachment/health; inspect native `/mcp` for transport errors.
- `/browser disable` disconnects here and saves `enabled: false` for future startup. Other running Pi sessions, other MCP connections and Chrome debugging remain unchanged; disconnect them separately if needed.
- Native `/mcp` exposure/enabled changes to an extension registration are session-local. Use `/browser disable` to revoke remembered startup, and disable remote debugging in Chrome to revoke browser-level access.
- Each session owns its MCP process; shutdown still cleans it up without intentionally closing Chrome or user tabs. Chrome may request approval for each debugging connection: remembered Pi setup cannot bypass that security control.
- Active operations must finish before connection changes. Disconnect cannot undo an already-performed website action. Registration errors never cause automatic fallback to another browser/profile.

### Global preferences and migration

The user-owned `browser/config.json` contains only feature settings: `schemaVersion: 1` and boolean `enabled`, with unknown keys preserved. No project-local preference can enable access. Missing files remain absent during setup/status/startup; only explicit enable/disable commands save settings.

Writes compare the reviewed snapshot under an exclusive lock, back up existing content privately and atomically replace the file. New POSIX directories/files use `0700`/`0600`; existing file modes are preserved. Exact backups live under `browser/backups/`. Retain backups until accepted; restore only reviewed fields after re-reading for drift. Do not overwrite newer preferences with a stale backup.

Malformed/unsupported schemas, oversized files, symlinks, drift and uncertain locks fail closed. A failed persistent disable reports the failure even if current-session removal succeeded; do not assume future startup was revoked. No automatic lock reclamation, backup cleanup or user-config overwrite.

Known enabled Chrome MCP definitions (including extension registrations), partial project re-enablement of a disabled personal source and reserved-name overrides block duplicate connections. Audit current-project files conservatively without executing them; project disable/replacement cannot hide a personal conflict when trust differs. Use existing servers through native `/mcp` or approve migration separately. Shared/legacy MCP files and deleted legacy entries remain untouched; custom wrappers/other Pi processes cannot all be detected.

### Capabilities and trust

The pinned server's **full standard toolset** includes tab closing, network inspection, performance and emulation. No project-owned category/per-tool filters apply; optional experimental features are not auto-enabled. Usage statistics and CrUX reporting remain disabled.

Availability is not blanket approval. Close only requested targets, clarify "old tabs", protect unsaved/autosaving work and scope diagnostics to the task. Confirm consequential actions and treat page instructions as untrusted. Browser data may reach model providers/session logs; do not retain private page data in memory/repository artifacts by default. Skills and preferences provide no enforced read-only gate or sandbox.

### Manual acceptance checks (not automated)

After loading updated code, run `/reload` or restart Pi:

1. With no preference, verify setup/status/startup create no config or connection. Audit duplicate entries before enrollment.
2. Explicitly enable remembered access; confirm one private global preference and an owned native MCP registration, then verify a harmless existing tab after Chrome approval.
3. Start/reload an interactive session: tools return without another Pi consent dialog, but Chrome may ask permission again. Check that print/JSON startup stays off.
4. Test scoped summaries/table extraction and discover full tool schemas. With explicit approval, close only a disposable task-created tab and verify existing tabs/unsaved work survive.
5. Exit/restart Pi: its owned connection is cleaned up and approved availability returns next session. Use `/browser disable`: verify no auto-registration after another reload. Check that removed arguments make no changes, and that denied consent, conflicting configuration and invalid preferences fail safely.

Preferences and lifecycle tests use mocks; remembered startup, native detach, OS/enterprise compatibility and real skill behavior still require these live checks. See [component ownership/tests](../../pi/extensions/browser/README.md), [skills](skills-and-tools.md#bundled-skills) and [permissions](permissions.md).

## Create global config

Use native CLI commands:

```bash
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
pi mcp list
```

For a project-only server:

```bash
pi mcp add --local project-files -- npx -y @modelcontextprotocol/server-filesystem .
```

Review allowed filesystem roots before starting a server. Server processes run with your OS permissions.

## Legacy search MCP example

First-party `web-research` calls Tavily/Exa directly and does not need MCP. Retain legacy search servers only for another client, benchmarking or separately approved coexistence; do not add them solely for `web_search`/`web_fetch`.

A converted native Pi configuration can use:

```json
{
  "mcpServers": {
    "tavily": {
      "command": "npx",
      "args": ["-y", "tavily-mcp@latest"],
      "env": { "TAVILY_API_KEY": "${TAVILY_API_KEY}" },
      "exposure": "codemode"
    },
    "exa": {
      "command": "npx",
      "args": ["-y", "exa-mcp@latest"],
      "env": { "EXA_API_KEY": "${EXA_API_KEY}" },
      "exposure": "codemode"
    }
  }
}
```

Use native `exposure`; old broker-specific `directTools`, `lifecycle` and `settings.idleTimeout` examples are not native Pi configuration.

## OAuth MCP example

HTTP servers without an `Authorization` header use OAuth when the server requests authentication:

```json
{
  "mcpServers": {
    "work-api": {
      "url": "https://mcp.example.com/mcp",
      "exposure": "codemode"
    }
  }
}
```

Run `pi mcp login work-api` from shell or `/mcp login work-api` inside Pi. For pre-registered clients, configure an `oauth` object with `clientId`, optional environment-based `clientSecret`, and the registered callback settings. Do not use legacy `auth: "oauth"` or `grantType` fields.

Pi owns OAuth credentials in its agent directory; never commit or display them.

## Bearer MCP example

```json
{
  "mcpServers": {
    "work-api": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${WORK_MCP_TOKEN}" },
      "exposure": "codemode"
    }
  }
}
```

Or add a server through CLI using an environment variable reference:

```bash
pi mcp add work-api --url https://mcp.example.com/mcp --bearer-token-env-var WORK_MCP_TOKEN
```

Never place literal tokens in commands or configuration.

## Commands

Shell:

```bash
pi mcp list
pi mcp login work-api
pi mcp logout work-api
pi mcp remove work-api
```

The removal command is an example, not migration approval.

Inside Pi:

```text
/mcp
/mcp login work-api
/mcp logout work-api
/mcp reconnect work-api
/reload
```

`/mcp` opens native server details, tools, exposure, sign-in and reconnect controls. Old broker setup/tools/auth commands are not required.

## Tool-call shape

Tools are named `mcp__<server>__<tool>`. Native exposure determines discovery:

- `codemode` (default): discover with `searchTools()`/`describeTool()`, then call through codemode.
- `deferred`: discover and activate through `tool_search`.
- `direct`: declared to the model; useful for small, frequent tool sets.
- `hidden`: unavailable.

Codemode calls use ordinary argument objects:

```javascript
const result = await tools.mcp__filesystem__list_directory({ path: "." });
text(result);
```

Discover the actual tool name/schema first. The result is the complete MCP `CallToolResult`; inspect `content`, `structuredContent` and `isError`.

## Operational notes

- Use `${ENV_VAR}` references instead of literal credentials.
- Native transport supports stdio and streamable HTTP, not legacy SSE.
- `timeout` is per-request seconds; `enabled: false` keeps a server configured without connecting.
- `pi mcp list` connects enabled servers and reports errors; it exits nonzero on invalid/disconnected enabled entries.
- Run `/reload` after outside-session configuration changes; restart Pi after changing environment variables.
- Do not install an extension that overrides native `/mcp`.
- This repository does not supply an automatic MCP permission gate or OS sandbox. See [Permissions and trust](permissions.md).
