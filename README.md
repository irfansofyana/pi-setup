# My Pi Setup

Personal notes for setting up [Pi](https://pi.dev) as a coding-agent environment with MCP tools, subagents, and reusable skills.

## What this setup includes

- Pi coding agent installed globally
- MCP adapter for Tavily, Exa, Brave Search, and optional OAuth/bearer-token servers
- LiteLLM provider support for company-hosted LiteLLM proxies
- Ollama Cloud provider support with direct cloud model discovery and optional web tools
- Subagent support for delegated workflows
- Permission approval gates for tools, bash, MCP, skills, and external paths
- Nicer tool output and edit/write diff rendering with `pi-tool-display`
- Context-mode workflows and context tooling with `context-mode`
- User-question and Markdown preview helpers
- A curated set of agent skills for research, reviews, diagrams, frontend work, and decision sparring

## Prerequisites

- Node.js and npm available on your `PATH`
- A shell profile such as `~/.zshrc` or `~/.bashrc`
- API keys for any MCP/search providers you want to use
- At least one LLM provider configured through `/login` or environment variables

## 1. Install Pi

Choose one installation method:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

or:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Verify the install:

```bash
pi --version
pi
```

## 2. Install Pi extensions

Install the required extensions:

```bash
# MCP adapter: connects Pi to MCP servers
pi install npm:pi-mcp-adapter

# Subagents: adds delegated-agent workflows
pi install npm:pi-subagents

# Permission system: approval gates for tools, bash, MCP, skills, and special operations
pi install npm:pi-permission-system

# Tool display: compact tool output and nicer edit/write diffs
pi install npm:pi-tool-display

# Context mode: switchable context/mode workflows
pi install npm:context-mode

# Ask-user-question helper extension
pi install npm:@juicesharp/rpiv-ask-user-question

# Markdown preview extension
pi install npm:pi-markdown-preview

# LiteLLM provider: connect Pi to a self-hosted/company LiteLLM proxy
pi install npm:pi-provider-litellm

# Ollama Cloud provider: direct Ollama Cloud models and optional web tools
pi install npm:pi-ollama-cloud
```

Restart Pi after installing extensions.

Useful extension commands inside Pi:

```text
/mcp                 # Open MCP status/configuration UI
/mcp setup           # Guided MCP setup
/mcp tools           # List available MCP tools
/permission-system   # Open pi-permission-system settings
/login litellm       # Configure LiteLLM base URL and API key
/litellm-refresh        # Refresh discovered LiteLLM models
/ollama-cloud-refresh # Refresh discovered Ollama Cloud models
/reload                 # Reload extensions, skills, prompts, and config
```

### Permission policy

Create the global Pi permission policy file:

```bash
$EDITOR ~/.pi/agent/pi-permissions.jsonc
```

Current policy:

```jsonc
{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "allow",
    "special": "ask"
  },
  "tools": {
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "tavily_*": "allow",
    "exa_*": "allow",
    "brave_search_*": "allow",
    "write": "ask",
    "edit": "ask",
    "bash": "ask",
    "mcp": "ask",
    "subagent": "ask"
  },
  "bash": {
    "git*": "allow"
  },
  "mcp": {
    "*": "ask",
    "tavily": "allow",
    "tavily:*": "allow",
    "tavily_*": "allow",
    "exa": "allow",
    "exa:*": "allow",
    "exa_*": "allow",
    "brave-search": "allow",
    "brave-search:*": "allow",
    "brave-search_*": "allow",
    "brave_search_*": "allow"
  },
  "skills": {
    "*": "allow"
  },
  "special": {
    "external_directory": "ask"
  }
}
```

Run `/reload` or restart Pi after changing the policy.

## 3. Theme

This setup includes a Gruvbox Dark theme. For global use, place it at:

```text
~/.pi/agent/themes/gruvbox-dark.json
```

This repo also keeps a project-local copy at:

```text
.pi/themes/gruvbox-dark.json
```

Enable it in Pi via `/settings`, or add this to your Pi settings:

```json
{
  "theme": "gruvbox-dark"
}
```

Run `/reload` or restart Pi after changing theme discovery/settings.

## 4. Configure secrets

Add only the keys you use to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
# LLM provider example
export ANTHROPIC_API_KEY="sk-ant-..."

# MCP/search providers
export TAVILY_API_KEY="tvly-..."
export EXA_API_KEY="exa-..."
export BRAVE_API_KEY="BSA..."

# Optional work MCP server examples
export WORK_CUSTOM_HEADER="..."
export WORK_MCP_TOKEN="..."

# Optional LiteLLM provider credentials
export LITELLM_API_KEY="..."

# Optional Ollama Cloud credentials
export OLLAMA_API_KEY="..."
```

Reload your shell:

```bash
source ~/.zshrc
# or
source ~/.bashrc
```

## 5. Authenticate LLM providers

Start Pi and run:

```text
/login
```

Configure the providers you use, for example:

- Codex / OpenAI OAuth
- OpenCode Go
- OpenRouter
- Kimi For Coding
- Anthropic via `ANTHROPIC_API_KEY`
- Company LiteLLM proxy via `/login litellm`

For LiteLLM, run:

```text
/login litellm
```

Enter your company LiteLLM base URL and API key. The `pi-provider-litellm` extension discovers models from `/model/info` and falls back to `/v1/models`. Refresh discovered models with:

```text
/litellm-refresh
```

For Ollama Cloud, set `OLLAMA_API_KEY`, restart Pi or run `/reload`, then refresh models:

```text
/ollama-cloud-refresh
```

Ollama Cloud models appear under the `ollama-cloud` provider in `/model`. The extension can also register `ollama_web_search` and `ollama_web_fetch` tools.

Switch models later with:

```text
/model
```

## 6. Configure MCP

Pi MCP adapter reads standard MCP config files automatically. Preferred locations:

| File | Scope | Notes |
| --- | --- | --- |
| `~/.config/mcp/mcp.json` | Global shared MCP config | Works across MCP-compatible tools |
| `.mcp.json` | Project-local shared MCP config | Preferred for project-specific servers |
| `~/.pi/agent/mcp.json` | Pi global override | Pi-specific settings/imports |
| `.pi/mcp.json` | Pi project override | Pi-specific project overrides |

Recommended global config path:

```bash
mkdir -p ~/.config/mcp
$EDITOR ~/.config/mcp/mcp.json
```

### Search MCP servers

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

Notes:

- `lifecycle: "lazy"` starts a server only when it is used.
- `directTools: true` exposes MCP tools directly to Pi. For large servers, prefer proxy mode or list only selected tools to reduce context usage.
- Environment values such as `${TAVILY_API_KEY}` are expanded from your shell environment.

### OAuth MCP server

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

Authenticate inside Pi:

```text
/mcp-auth work-api
```

For machine-to-machine auth, use client credentials:

```json
{
  "oauth": {
    "grantType": "client_credentials"
  }
}
```

### Bearer-token MCP server

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

### Using MCP tools from Pi

Through the MCP proxy:

```text
mcp({ search: "web search" })
mcp({ describe: "tool_name" })
mcp({ tool: "tool_name", args: '{"query":"example"}' })
```

Important: `args` is a JSON string, not a JSON object.

## 7. Install agent skills

### Skills from `irfansofyana/ai-marketplace`

```bash
npx skills add irfansofyana/ai-marketplace --global --skill mermaid
npx skills add irfansofyana/ai-marketplace --global --skill web-researcher
npx skills add irfansofyana/ai-marketplace --global --skill code-review
npx skills add irfansofyana/ai-marketplace --global --skill decision-sparring
npx skills add irfansofyana/ai-marketplace --global --skill idea-refinery
```

### Skills from `mattpocock/skills`

```bash
npx skills@latest add mattpocock/skills --global --skill grill-me
npx skills@latest add mattpocock/skills --global --skill caveman
```

### Skills from `anthropics/skills`

```bash
npx skills add https://github.com/anthropics/skills --skill frontend-design --global
npx skills add https://github.com/anthropics/skills --skill skill-creator --global
```

## 8. Verify the setup

Inside Pi:

```text
/reload
/mcp
/mcp tools
```

Then test the workflow:

```text
Use web-researcher to find current Pi MCP adapter docs.
Create a Mermaid diagram of this repository setup.
Review README.md for clarity and missing setup steps.
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Pi cannot find a command installed by npm | Check `npm bin -g` / global npm path and restart the shell |
| MCP server does not start | Run `/mcp`, inspect the server error, and verify API keys are exported |
| OAuth server is unauthorized | Run `/mcp-auth <server-name>` again |
| Direct MCP tools do not appear | Run `/mcp reconnect <server-name>` then `/reload` |
| Too many MCP tools in context | Remove `directTools: true` or set `directTools` to a small list of tool names |
| Skills do not trigger | Restart Pi or run `/reload`, then confirm the skill appears in the startup header |

## Maintenance

Update Pi and installed packages:

```bash
pi update
```

Update packages only:

```bash
pi update --extensions
```

List installed Pi packages:

```bash
pi list
```

Reload configuration without restarting:

```text
/reload
```
