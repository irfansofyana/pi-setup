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
- Local `/goal` command template for Codex/Claude-style goal loops in Pi
- A curated set of agent skills for research, reviews, diagrams, frontend work, decision sparring, and Notion workflows
- Notion CLI (`ntn`) plus Notion agent skills from `makenotion/skills`
- Optional Understand-Anything plugin/skills for Pi codebase graphs
- Persistent cross-session memory via `agentmemory`

## How to use this repo

The `pi/` directory in this repository contains **example/template files** for your Pi agent configuration (themes, extensions, etc.).

> ⚠️ **Do not** blindly copy the entire `pi/` folder to `~/.pi/` — that will overwrite your existing Pi installation, settings, and any extensions you already have. Instead, copy only the specific files you need:
>
> ```bash
> # Example: copy just the theme
> cp pi/themes/irfan-gruvbox.json ~/.pi/agent/themes/
>
> # Example: copy just the signature UI extension
> cp pi/extensions/pi-signature.ts ~/.pi/agent/extensions/
>
> # Example: copy just the local goal-loop extension template
> cp -r pi/extensions/goal-loop ~/.pi/agent/extensions/
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

# Context mode: switchable context/mode workflows
pi install npm:context-mode

# Ask-user-question helper extension
pi install npm:@juicesharp/rpiv-ask-user-question

# Markdown preview extension
pi install npm:pi-markdown-preview

# Todo: task tracking and todo management
pi install npm:@juicesharp/rpiv-todo

# 9router: model routing extension
pi install npm:pi-9router-ext

# Stats: Pi usage statistics extension
pi install npm:pi-stats-ext

# Ponytail: ponytail extension
pi install git:github.com/DietrichGebert/ponytail

# Caveman: ultra-compressed communication mode (manual install)
# pi install git:github.com/jonjonrankin/pi-caveman
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

### Local goal loop command

This repo includes a local Pi extension template at `pi/extensions/goal-loop/` that adds a project-scoped `/goal` command inspired by Codex Goal mode and Claude Code `/goal`.

Install the template globally:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/goal-loop ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
```

Commands:

```text
/goal <objective>          # create a project goal and start auto-continuing
/goal status               # show objective, status, loop count, verification
/goal pause                # stop auto-continuing but keep state
/goal resume               # resume a paused or stopped goal
/goal clear                # remove this project's goal
/goal edit <objective>     # replace the goal text
/goal verify <command>     # add an explicit verification command
```

The extension stores one active goal per project in:

```text
~/.pi/agent/goal-loop/state.json
```

Optional config lives at:

```text
~/.pi/agent/goal-loop/config.json
```

Default config:

```json
{
  "allowModelCreateGoal": false
}
```

Keep this false so YOLO mode cannot silently start goals while you brainstorm. Set it to `true` and `/reload` only if you want the model-callable `create_goal` tool back.

How the loop works:

- `/goal <objective>` stores the goal and immediately asks Pi to continue toward it.
- `before_agent_start` injects the active goal into the turn instructions.
- The extension registers model-callable `get_goal` and `update_goal` tools so the agent can inspect persisted state and record evidence while it works.
- Human goal creation stays on `/goal <objective>` by default; optional config can re-enable model-created goals.
- The footer shows animated status like `goal ◐ loops 0/8`; this counts auto-continue loops used, not total assistant turns.
- The goal state keeps the last 10 evidence entries from verification, notes, or tool observations.
- When `@tintinweb/pi-subagents` exposes the `Agent` tool, the prompt asks the worker to call a foreground read-only evaluator subagent before terminal decisions.
- The agent must end each loop turn with `GOAL_STATUS` and `GOAL_REASON` markers.
- If an evaluator subagent returns `GOAL_EVAL_STATUS`, `GOAL_EVAL_REASON`, and `GOAL_EVAL_CONFIDENCE`, those evaluator markers take precedence.
- `agent_end` reads the marker and auto-continues when the status is `continue`; idle continuations are sent without `deliverAs: "followUp"` so Pi starts the next turn reliably.
- The loop stops on `complete`, `blocked`, `needs_user`, or after the turn budget.

Status markers:

```text
GOAL_STATUS: complete | continue | blocked | needs_user
GOAL_REASON: one short sentence
```

Evaluator markers:

```text
GOAL_EVAL_STATUS: complete | continue | blocked | needs_user
GOAL_EVAL_REASON: one short sentence
GOAL_EVAL_CONFIDENCE: low | medium | high
```

Agent tools by default:

```text
get_goal       # inspect objective, status, verification commands, and evidence
update_goal    # record evidence, add verification commands, or stop the goal
```

Optional `allowModelCreateGoal: true` also registers:

```text
create_goal    # create or replace the current project goal
```

Keep `@gotgenes/pi-permission-system` enabled. The goal loop does not bypass your policy; writes, shell commands, unknown MCP tools, subagents, and external directories should still follow the permission gates in this README.

Current limitations:

- Evaluator spawning is prompt-mediated through the `Agent` tool; the extension does not yet call `subagents:rpc:spawn` directly.
- Goals do not run after Pi exits.
- Verification commands are instructions to the agent, not commands the extension runs directly.

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

## 3. Signature UI and theme

This setup includes:

- `irfan-gruvbox` — Gruvbox Dark base with a personal theme name
- `pi-signature.ts` — big gradient `π` signature header, auto-detected running user, fixed `crafted from Irfan's Pi setup` credit, and a `π` working spinner with short programmer-joke flavor text

Install globally:

```bash
mkdir -p ~/.pi/agent/themes ~/.pi/agent/extensions
cp pi/themes/irfan-gruvbox.json ~/.pi/agent/themes/
cp pi/extensions/pi-signature.ts ~/.pi/agent/extensions/
```

Enable the theme in Pi via `/settings`, or add this to your Pi settings:

```json
{
  "theme": "irfan-gruvbox"
}
```

Override the displayed owner if needed:

```bash
export PI_SIGNATURE_NAME="Your Name"
```

Run `/reload` or restart Pi after changing theme or extension files.

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
npx skills add irfansofyana/ai-marketplace --global --skill 9router-web-researcher
npx skills add irfansofyana/ai-marketplace --global --skill code-review
npx skills add irfansofyana/ai-marketplace --global --skill decision-sparring
npx skills add irfansofyana/ai-marketplace --global --skill idea-refinery
```

### Skills from `mattpocock/skills`

```bash
npx skills@latest add mattpocock/skills --global --skill grill-me
npx skills@latest add mattpocock/skills --global --skill caveman
npx skills@latest add mattpocock/skills --global --skill teach
```

### Skills from `anthropics/skills`

```bash
npx skills add https://github.com/anthropics/skills --skill frontend-design --global
npx skills add https://github.com/anthropics/skills --skill skill-creator --global
```

### Skills from `hardikpandya/stop-slop`

A single-skill repo that catches and removes AI-writing tells (banned phrases, structural clichés, sentence-level rules). Useful when editing or reviewing prose in Pi.

```bash
npx skills add hardikpandya/stop-slop --global --skill stop-slop
```

### Skills from `makenotion/skills`

Install Notion skills so Pi agents can use Notion CLI workflows instead of guessing command syntax:

```bash
# Install all Notion skills
npx skills add makenotion/skills --global

# Or install only the Notion CLI skill
npx skills add makenotion/skills --global --skill notion-cli
```

## 8. Optional: Understand-Anything for Pi

Understand-Anything adds Pi slash commands for codebase knowledge graphs, dashboards, chat, diffs, and onboarding guides.

Manual install from the Egonex fork, passing Pi as the platform directly:

```bash
curl -fsSL https://raw.githubusercontent.com/Egonex-AI/Understand-Anything/main/install.sh | bash -s pi
```

Do not type `pi` at the interactive numeric prompt; choose Pi's menu number if you use the interactive path.

The installer should clone/link files under your home directory, typically:

```text
~/.understand-anything/repo
~/.understand-anything-plugin
```

Then reload Pi:

```text
/reload
```

Useful commands inside Pi:

```text
/understand
/understand-dashboard
/understand-chat How does authentication work?
/understand-diff
/understand-explain README.md
/understand-onboard
```

For first test, run it in a small throwaway repo before using a large codebase.

If you want to remove it later:

```bash
cd ~/.understand-anything/repo
bash install.sh --uninstall pi
rm -rf ~/.understand-anything ~/.understand-anything-plugin
```

## 9. Notion CLI (`ntn`)

Install the official Notion CLI:

```bash
# macOS/Linux recommended installer
curl -fsSL https://ntn.dev | bash

# Or install with npm. Requires Node.js 22+ and npm 10+.
npm install --global ntn
```

Verify:

```bash
ntn --version
ntn --help
```

Authenticate and configure access:

```bash
# Workspace login for Notion Workers and token commands
ntn login

# API/files commands use an integration token today
export NOTION_API_TOKEN="secret_..."
```

Add `NOTION_API_TOKEN` to your shell profile if you want Pi sessions to use it:

```bash
# ~/.zshrc or ~/.bashrc
export NOTION_API_TOKEN="secret_..."
```

Useful commands:

```bash
ntn api ls
ntn api --help
ntn api <endpoint> --docs
ntn files --help
ntn workers --help
```

Run `/reload` or restart Pi after installing skills or changing environment variables.

## 10. Agent memory (agentmemory)

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

## 11. Verify the setup

Inside Pi:

```text
/reload
/mcp
/mcp tools
```

Then test the workflow:

```text
Use 9router-web-researcher to find current Pi MCP adapter docs.
Create a Mermaid diagram of this repository setup.
Review README.md for clarity and missing setup steps.
```

Test Notion integration:

```bash
ntn --version
ntn api ls
```

Inside Pi, ask:

```text
Use the notion-cli skill to list Notion API endpoints.
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
