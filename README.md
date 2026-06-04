# My Pi Setup

Personal notes for setting up [Pi](https://pi.dev) as a coding-agent environment with MCP tools, subagents, and reusable skills.

## What this setup includes

- Pi coding agent installed globally
- MCP adapter for Tavily, Exa, Brave Search, and optional OAuth/bearer-token servers
- Subagent support for delegated workflows
- Intercom coordination between parent and child agents
- Permission approval gates for tools, bash, MCP, skills, and external paths
- Context-mode workflows and context tooling with `context-mode`
- User-question and Markdown preview helpers
- Todo tracking and task management with `rpiv-todo`
- A curated set of agent skills for research, reviews, diagrams, frontend work, and decision sparring
- Persistent cross-session memory via `agentmemory`

## How to use this repo

The `pi/` directory in this repository contains **example/template files** for your Pi agent configuration (themes, extensions, etc.).

> ⚠️ **Do not** blindly copy the entire `pi/` folder to `~/.pi/` — that will overwrite your existing Pi installation, settings, and any extensions you already have. Instead, copy only the specific files you need:
>
> ```bash
> # Example: copy just the theme
> cp pi/themes/gruvbox-dark.json ~/.pi/agent/themes/
>
> # Example: copy just the agentmemory extension backup
> cp -r pi/extensions/agentmemory ~/.pi/agent/extensions/
> ```

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
pi install npm:@tintinweb/pi-subagents

# Permission system: approval gates for tools, bash, MCP, skills, and special operations
pi install npm:@gotgenes/pi-permission-system

# Intercom: coordination channel between parent and child subagents
pi install npm:pi-intercom

# Context mode: switchable context/mode workflows
pi install npm:context-mode

# Ask-user-question helper extension
pi install npm:@juicesharp/rpiv-ask-user-question

# Markdown preview extension
pi install npm:pi-markdown-preview

# Todo: task tracking and todo management
pi install npm:@juicesharp/rpiv-todo

# 9router: model routing extension
pi install git:github.com/irfansofyana/pi-9router-ext
```

Restart Pi after installing extensions.

Useful extension commands inside Pi:

```text
/mcp                 # Open MCP status/configuration UI
/mcp setup           # Guided MCP setup
/mcp tools           # List available MCP tools
/permission-system   # Open pi-permission-system settings
/agentmemory-status     # Check agentmemory health
/reload                 # Reload extensions, skills, prompts, and config
```

### Permission policy

Create the global Pi permission policy file:

```bash
mkdir -p ~/.pi/agent/extensions/pi-permission-system
$EDITOR ~/.pi/agent/extensions/pi-permission-system/config.json
```

Current policy:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json",
  "permissionReviewLog": true,
  "permission": {
    "*": "ask",
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "tavily_*": "allow",
    "exa_*": "allow",
    "brave_search_*": "allow",
    "ask_user_question": "allow",
    "todo": "allow",
    "write": "ask",
    "edit": "ask",
    "subagent": "ask",
    "bash": {
      "*": "ask",
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
    "skill": {
      "*": "allow"
    },
    "external_directory": "ask"
  }
}
```

> **Note:** `@gotgenes/pi-permission-system` uses a flat `permission` format. If you still have a legacy `~/.pi/agent/pi-permissions.jsonc` from the old `pi-permission-system` extension, move or remove it — the new extension will warn about legacy files but still reads them for backward compatibility.

Run `/reload` or restart Pi after changing the policy.

## 3. Theme

This setup includes a Gruvbox Dark theme. For global use, place it at:

```text
~/.pi/agent/themes/gruvbox-dark.json
```

This repo also keeps a project-local copy at:

```text
pi/themes/gruvbox-dark.json
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
| `pi/mcp.json` | Pi project-local example | Copy what you need to `~/.pi/agent/mcp.json` |

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

## 8. Agent memory (agentmemory)

Persistent cross-session memory via [agentmemory](https://github.com/rohitg00/agentmemory). It captures what the agent does, compresses it into searchable memory, and injects relevant context when the next session starts. Shared across Pi, Claude Code, Codex CLI, Gemini CLI, Hermes, OpenClaw, and more.

> **Prerequisite:** agentmemory requires the **iii-engine** runtime — a separate native binary (Rust) that runs as a background process. The `npx @agentmemory/agentmemory` wrapper will try to install/manage it automatically, but on some platforms you may need to install it manually.
>
> **Pinned version:** agentmemory currently pins `iii-engine` to **v0.11.2** (v0.11.6+ introduces a sandbox model that agentmemory hasn't refactored for yet). Override with `AGENTMEMORY_III_VERSION=<version>` if needed.
>
> **macOS manual install:**
> ```bash
> mkdir -p ~/.local/bin
> curl -fsSL https://github.com/iii-hq/iii/releases/download/iii/v0.11.2/iii-aarch64-apple-darwin.tar.gz | tar -xz -C ~/.local/bin
> chmod +x ~/.local/bin/iii
> ```
>
> **Data directory:** The server stores its SQLite database (`data/state_store.db`) relative to its working directory. Start it from a dedicated location (e.g., `~/.agentmemory`) so it doesn't pollute random project directories:
> ```bash
> mkdir -p ~/.agentmemory && cd ~/.agentmemory
> npx @agentmemory/agentmemory
> ```
> If a `data/` directory keeps appearing in an unwanted location, a zombie `iii` process is probably still running from there. Find it with `lsof -i :3111`, kill it, and restart from the correct directory.

### Start the memory server

In a separate terminal:

```bash
# Recommended: run from a dedicated directory
cd ~/.agentmemory
npx @agentmemory/agentmemory
```

The server runs on `http://localhost:3111` by default. Keep this terminal open while using Pi.

### Install the Pi extension

The integration files are copied to `~/.pi/agent/extensions/agentmemory/`. A project-local backup is also kept at `pi/extensions/agentmemory/` in this repo.

Pi auto-discovers extensions placed in `~/.pi/agent/extensions/`. Do **not** also add the extension to the `packages` array in `settings.json` — that causes a double-load and tool name conflicts (`memory_health`, `memory_search`, `memory_save` will all fail to register).

Run `/reload` or restart Pi after copying the files.

> **Note:** Upstream `agentmemory` now ships `agentmemory connect` for automated agent wiring. The pi adapter is currently a stub, so manual copy-and-reload remains the recommended install path for now.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENTMEMORY_URL` | `http://localhost:3111` | agentmemory server URL |
| `AGENTMEMORY_SECRET` | (none) | Bearer token for protected instances |
| `AGENTMEMORY_REQUIRE_HTTPS` | (off) | Set to `1` to refuse sending bearer tokens over plaintext HTTP to non-loopback hosts |
| `AGENTMEMORY_DEBUG` | (off) | Set to `1` to trace MCP shim probe and standalone fallback decisions to stderr |
| `AGENTMEMORY_VIEWER_URL` | (derived) | Override the viewer URL printed by `agentmemory status` |
| `AGENTMEMORY_EXPORT_ROOT` | `~/agentmemory-backup` | Default destination for `agentmemory export` |

Add any needed variables to your shell profile.

### Verify

Inside Pi:

```text
/reload
/agentmemory-status
```

You should see `agentmemory healthy` and a footer status like `🧠 agentmemory`.

Available tools/commands:

- `memory_health` — confirm the memory server is reachable
- `memory_search` — search prior decisions, bugs, workflows, and preferences
- `memory_save` — write durable facts back to long-term memory
- `/agentmemory-status` — quick health check from inside Pi

## 9. Verify the setup

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

Test agentmemory:

```text
/agentmemory-status
memory_save content="This project uses Express with TypeScript"
memory_search query="Express TypeScript"
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
| agentmemory not responding | Ensure `npx @agentmemory/agentmemory` is running and `AGENTMEMORY_URL` is correct |
| `/agentmemory-status` shows unhealthy | Check the server terminal for errors; verify port 3111 is free |
| `data/` directory keeps reappearing in a repo | A zombie `iii` process is running from that directory. `lsof -i :3111` to find it, `kill <pid>`, then restart from `~/.agentmemory` |
| agentmemory won't start on Windows | The Node.js package isn't enough — you need the `iii-engine` native binary. Download `iii-x86_64-pc-windows-msvc.zip` from the [iii-hq/iii releases v0.11.2](https://github.com/iii-hq/iii/releases/tag/iii%2Fv0.11.2) page, extract `iii.exe` to a directory on your PATH, then retry |

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
