# MCP

The MCP adapter is a separately managed [required companion package](../../README.md#required-npm-package-manifest). Keep shared servers global and project-only servers in project root; first-party or companion package updates do not overwrite either config.

## Configuration precedence and scope

Preferred global file:

```text
~/.config/mcp/mcp.json
```

Project-local file:

```text
.mcp.json
```

Pi-specific global override:

```text
~/.pi/agent/mcp.json
```

Use generic examples below as starting points.

Never commit credentials.

## Create global config

```bash
mkdir -p ~/.config/mcp
$EDITOR ~/.config/mcp/mcp.json
```

## Search MCP example

```json
{
  "settings": {
    "idleTimeout": 60
  },
  "mcpServers": {
    "tavily": {
      "command": "npx",
      "args": ["-y", "tavily-mcp@latest"],
      "env": {
        "TAVILY_API_KEY": "${TAVILY_API_KEY}"
      },
      "lifecycle": "lazy",
      "directTools": true
    },
    "exa": {
      "command": "npx",
      "args": ["-y", "exa-mcp@latest"],
      "env": {
        "EXA_API_KEY": "${EXA_API_KEY}"
      },
      "lifecycle": "lazy",
      "directTools": true
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search@latest"],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}"
      },
      "lifecycle": "lazy",
      "directTools": true
    }
  }
}
```

## OAuth MCP example

```json
{
  "mcpServers": {
    "work-api": {
      "url": "https://mcp.your-company.com/mcp",
      "auth": "oauth",
      "oauth": {
        "grantType": "authorization_code"
      },
      "lifecycle": "keep-alive",
      "headers": {
        "X-Custom-Header": "${WORK_CUSTOM_HEADER}"
      }
    }
  }
}
```

## Bearer MCP example

```json
{
  "mcpServers": {
    "work-api": {
      "url": "https://mcp.your-company.com/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "WORK_MCP_TOKEN",
      "lifecycle": "keep-alive"
    }
  }
}
```

## Commands

```text
/mcp
/mcp setup
/mcp tools
/mcp-auth work-api
/mcp reconnect <server-name>
/reload
```

## Tool-call shape

```text
mcp({ search: "web search" })
mcp({ describe: "tool_name" })
mcp({ tool: "tool_name", args: '{"query":"example"}' })
```

`args` must be JSON string.

## Operational notes

- Use `${ENV_VAR}` references rather than literal credentials.
- Use `directTools: true` only when direct tool exposure is worth context cost.
- Use `lifecycle: "lazy"` for on-demand servers and `"keep-alive"` when persistent sessions are required.
- After edits, run `/mcp reconnect <server-name>` and `/reload`.
- If OAuth fails, run `/mcp-auth <server-name>`.
- If direct tools are missing, reconnect server, then reload.
