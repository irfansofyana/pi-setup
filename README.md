# My Pi Setup

Personal notes for setting up [Pi](https://pi.dev) as a coding-agent environment with MCP tools, subagents, and reusable skills.

## What this setup includes

- Pi coding agent installed globally
- MCP adapter for Tavily, Exa, Brave Search, and optional OAuth/bearer-token servers
- Subagent support for delegated workflows
- Intercom coordination between parent and child agents
- Permission approval gates for tools, bash, MCP, skills, and external paths
- Context-mode workflows and context tooling with `context-mode`
- Local Headroom Labs adapter for managed context compression and token-savings visibility
- Local real-Hindsight memory adapter/template
- Local hashline-inspired read/edit extension template for safer line-anchored edits
- User-question and Markdown preview helpers
- Todo tracking and task management with `rpiv-todo`
- Local `/goal` command template for Codex/Claude-style goal loops in Pi
- A curated set of agent skills for research, reviews, diagrams, frontend work, decision sparring, and Notion workflows
- Notion CLI (`ntn`) plus Notion agent skills from `makenotion/skills`
- Optional Understand-Anything plugin/skills for Pi codebase graphs

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
> # Example: copy just the local headroom extension template
> cp -r pi/extensions/headroom ~/.pi/agent/extensions/
>
> # Example: copy just the local hindsight memory extension template
> cp -r pi/extensions/hindsight ~/.pi/agent/extensions/
>
> # Example: copy just the local hashline edit extension template
> cp -r pi/extensions/hashline ~/.pi/agent/extensions/
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

# Caveman: caveman extension
pi install git:github.com/jonjonrankin/pi-caveman
```

Install Headroom CLI and the local Headroom adapter template:

```bash
# Headroom CLI comes from the Python package; npm headroom-ai is SDK-only.
pipx install "headroom-ai[proxy]"

mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/headroom ~/.pi/agent/extensions/
```

Install local Hindsight Memory adapter template:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/hindsight ~/.pi/agent/extensions/
```

Install local Hashline edit adapter template:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/hashline ~/.pi/agent/extensions/
```

Reload or restart Pi after installing extensions.

Useful extension commands inside Pi:

```text
/mcp                 # Open MCP status/configuration UI
/mcp setup           # Guided MCP setup
/mcp tools           # List available MCP tools
/permission-system   # Open pi-permission-system settings
/reload                 # Reload extensions, skills, prompts, and config
```

### Local Headroom adapter

This repo includes a local Pi extension template at `pi/extensions/headroom/` that integrates [Headroom Labs Headroom](https://github.com/headroomlabs-ai/headroom) without using a third-party Pi extension package.

It starts/stops a managed local `headroom proxy`, compresses large final Pi tool results through `POST /v1/compress`, stores originals in a local Pi CCR store, and exposes native Pi tools for retrieval/stats. It does **not** expose Headroom MCP.

Install Headroom CLI:

```bash
pipx install "headroom-ai[proxy]"
# or
uv tool install "headroom-ai[proxy]"
```

Install the Pi adapter globally:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/headroom ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
```

Commands:

```text
/headroom start                 # start managed proxy or adopt existing external proxy
/headroom stop                  # stop managed proxy only; disable compression
/headroom restart               # stop managed proxy, then start again
/headroom enable                # enable compression for current Pi session
/headroom disable               # disable compression for current Pi session
/headroom status                # show current status
/headroom stats                 # show Pi-session compression stats
/headroom doctor                # check CLI/proxy and print install commands
/headroom logs                  # show proxy log tail
/headroom logs clear            # clear proxy log
/headroom cleanup               # clean expired local CCR store entries
/headroom config show           # print effective runtime config
/headroom config save           # persist current runtime config
/headroom config reset          # reset runtime config to defaults
```

Native tools exposed by the extension:

```text
headroom_retrieve  # retrieve original compressed output by local hr_... hash, optional query
headroom_stats     # inspect Pi-session savings and adapter state
```

Optional config lives at:

```text
~/.pi/agent/headroom/config.json
```

Default config highlights:

```json
{
  "enabled": true,
  "startup": "manual",
  "proxyUrl": "http://127.0.0.1:8787",
  "allowRemote": false,
  "minChars": 500,
  "startupHealthTimeoutMs": 30000,
  "storeTtlHours": 24,
  "notifyFailures": "once"
}
```

`/headroom start` waits up to `startupHealthTimeoutMs` for slow local proxy readiness. Remote Headroom proxies are blocked unless `allowRemote` is set to `true`; only enable that for a proxy you trust with tool output content.

Run `/reload` after changing config or copying a new extension version.

### Local Hashline edit adapter

This repo includes a local Pi extension template at `pi/extensions/hashline/` that adds hashline-inspired read/edit tools for stock Pi.

Install globally:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/hashline ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
```

Tools:

```text
hashline_read   # read a file with [path#TAG] header and numbered lines
hashline_edit   # apply a tagged SWAP/DEL/INS patch
```

Command:

```text
/hashline status
/hashline clear
```

Workflow:

```text
1. Use hashline_read before editing a file.
2. Copy the exact [path#TAG] header from the read output.
3. Use hashline_edit with SWAP/DEL/INS operations and + payload rows.
4. If the tool reports a stale tag or unseen line, re-read the file/range first.
```

Supported patch operations:

```text
SWAP N.=M:       replace inclusive line range with + payload rows
DEL N           delete one line
DEL N.=M        delete inclusive line range
INS.PRE N:      insert + payload rows before line N
INS.POST N:     insert + payload rows after line N
INS.HEAD:       insert at start of file
INS.TAIL:       insert at end of file
SWAP.BLK N:     replace the brace/indent block starting at line N
DEL.BLK N       delete the brace/indent block starting at line N
INS.BLK.POST N: insert after the brace/indent block starting at line N
```

Current scope: this is a hardened local extension inspired by Oh My Pi's hashline design. It implements whole-file tags, session snapshots, seen-line validation, safe stale-tag recovery for line shifts, simple brace/indent block operations, project-root path confinement, duplicate-target rejection, all-or-nothing multi-section preflight, BOM/line-ending preservation, and best-effort post-write diagnostics from Pi LSP context hooks when available. Full tree-sitter block resolution is still a future upgrade.

### Local Hindsight Memory adapter

This repo includes a Pi extension template at `pi/extensions/hindsight/` that uses real Hindsight via a local daemon.

Set up local Hindsight first:

```bash
uvx hindsight-embed@latest configure
uvx hindsight-embed daemon status
```

For a named profile such as `pi-litellm`, register it and point Pi clients at the profile port through extension config:

```bash
hindsight-embed profile create pi-litellm --port 9478 --merge
hindsight-embed profile set-active pi-litellm
hindsight-embed -p pi-litellm daemon status

mkdir -p ~/.pi/agent/hindsight
cat > ~/.pi/agent/hindsight/config.json <<'JSON'
{
  "apiUrl": "http://127.0.0.1:9478",
  "bankId": "coding-agent",
  "scoping": "per-project-tagged"
}
JSON
```

`HINDSIGHT_EMBED_PROFILE` selects the `hindsight-embed` profile; `~/.pi/agent/hindsight/config.json` is what the Pi extension reads when the Pi process does not inherit shell env. Env vars still override config values.

Defaults: `HINDSIGHT_API_URL`/`apiUrl=http://127.0.0.1:8888`, `HINDSIGHT_BANK_ID`/`bankId=coding-agent`, `HINDSIGHT_SCOPING`/`scoping=per-project-tagged`.

- Real Hindsight retain/recall/reflect over the local daemon; local rulebook/TTSR portable subset stays in Pi.
- Footer/status: Pi shows `hindsight on · <bank> · working` when the extension can reach the daemon.
- Commands: `/hindsight view|stats|diagnose|clear|recall <query>|memory enable|disable|config show|config set <key> <value>|config save|config reset`; `/rules list|reload|show <name>`.
- Tools: `hindsight_retain`, `hindsight_recall`, `hindsight_reflect`, `hindsight_rule`.
- Memory: Hindsight daemon/API; rules: `~/.pi/agent/rules/*.{md,mdc}` plus project rules.
- Limits: true oh-my-pi mid-token TTSR abort/rewind is fork-only; stock Pi approximates via `tool_result`, `tool_call`, and `input` hooks.

Install globally:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/hindsight ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
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
      "git*": "allow",
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
      "brave_search_*": "allow",
    },
    "skill": {
      "*": "allow",
    },
    "external_directory": "ask",
  },
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

| File                     | Scope                           | Notes                                        |
| ------------------------ | ------------------------------- | -------------------------------------------- |
| `~/.config/mcp/mcp.json` | Global shared MCP config        | Works across MCP-compatible tools            |
| `.mcp.json`              | Project-local shared MCP config | Preferred for project-specific servers       |
| `~/.pi/agent/mcp.json`   | Pi global override              | Pi-specific settings/imports                 |
| `pi/mcp.json`            | Pi project-local example        | Copy what you need to `~/.pi/agent/mcp.json` |

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

## 10. Verify the setup

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

## Troubleshooting

| Problem                                       | Fix                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi cannot find a command installed by npm     | Check `npm bin -g` / global npm path and restart the shell                                                                                                                                                                                                                             |
| MCP server does not start                     | Run `/mcp`, inspect the server error, and verify API keys are exported                                                                                                                                                                                                                 |
| OAuth server is unauthorized                  | Run `/mcp-auth <server-name>` again                                                                                                                                                                                                                                                    |
| Direct MCP tools do not appear                | Run `/mcp reconnect <server-name>` then `/reload`                                                                                                                                                                                                                                      |
| Too many MCP tools in context                 | Remove `directTools: true` or set `directTools` to a small list of tool names                                                                                                                                                                                                          |
| Skills do not trigger                         | Restart Pi or run `/reload`, then confirm the skill appears in the startup header                                                                                                                                                                                                      |

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
