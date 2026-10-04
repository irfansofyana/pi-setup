# MCP

Pi `>=1.0.0` provides native MCP integration; no companion is required. Keep personal servers global and project-only servers in trusted project configuration. Package updates do not overwrite either file.

## Configuration precedence and scope

Native Pi reads:

- `~/.pi/agent/mcp.json`: personal servers.
- `.pi/mcp.json`: project servers, only after project trust.

A project server replaces the personal server with the same name. A project entry containing only `enabled`, `exposure` or `toolExposure` overrides those fields without replacing the server connection.

Shared `~/.config/mcp/mcp.json` and project `.mcp.json` are other-client/legacy files, not native Pi auto-load paths. Preserve them. Convert selected entries only after a separate approved proposal; never silently move credentials or delete old configurations.

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
