# My Pi Setup

Personal Pi coding-agent setup: theme, extensions, MCP, memory, context compression, subagents, skills, and operational guardrails.

## Features included

| Area | Included |
| --- | --- |
| Core agent | Pi coding agent with LLM provider login via `/login` |
| Theme/UI | `irfan-gruvbox` theme and `pi-signature.ts` header/footer extension |
| MCP | MCP adapter, Tavily, Exa, Brave Search, OAuth/bearer examples |
| Subagents | `@tintinweb/pi-subagents` delegated-agent workflows |
| Permissions | `@gotgenes/pi-permission-system` approval gates |
| Context tooling | `context-mode` plus context-mode tools/skills |
| Headroom | Local Headroom adapter template for tool-output compression/retrieval |
| Hindsight | Local Hindsight memory adapter template backed by `hindsight-embed` daemon |
| Managed skills | Local generated reusable skills template with Hindsight-backed `learn` |
| Goal loop | Local `/goal` command template for persisted goal loops |
| BTW | Local `/btw` side-question extension template |
| Ask user | Structured `ask_user_question` UI helper |
| Preview | Markdown preview/export helper |
| Todo | `rpiv-todo` task tracking extension |
| 9router | `pi-9router-ext` model/search routing tools |
| Stats | `pi-stats-ext` usage statistics |
| Caveman | Local `/caveman` terse-response extension template |
| Skills | Research, review, diagrams, frontend, sparring, docs, Notion/n8n workflows |
| Optional graphing | Understand-Anything Pi commands and skills |
| Notion | Official `ntn` CLI and Notion skills |

## Repository layout

```text
pi/
  themes/
    irfan-gruvbox.json       # main theme
    gruvbox-dark.json        # alternate/base theme
  extensions/
    pi-signature.ts          # signature header + compact footer
    headroom/                # local Headroom adapter template
    hindsight/               # local Hindsight adapter template
    managed-skills/          # local managed generated skills template
    goal-loop/               # local /goal extension template
    btw/                     # local /btw side-question extension template
    caveman/                 # local /caveman extension template
```

Do **not** copy entire `pi/` folder into `~/.pi/`. Copy only files/templates you need.

## Quickstart

```bash
# 1) Install Pi
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g @earendil-works/pi-coding-agent

# 2) Install required Pi extensions
pi install npm:pi-mcp-adapter
pi install npm:@tintinweb/pi-subagents
pi install npm:@gotgenes/pi-permission-system
pi install npm:context-mode
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:pi-markdown-preview
pi install npm:@juicesharp/rpiv-todo
pi install npm:pi-9router-ext
pi install npm:pi-stats-ext

# 3) Install local templates from this repo
mkdir -p ~/.pi/agent/themes ~/.pi/agent/extensions
cp pi/themes/irfan-gruvbox.json ~/.pi/agent/themes/
cp pi/extensions/pi-signature.ts ~/.pi/agent/extensions/
cp -r pi/extensions/headroom ~/.pi/agent/extensions/
cp -r pi/extensions/hindsight ~/.pi/agent/extensions/
cp -r pi/extensions/managed-skills ~/.pi/agent/extensions/
cp -r pi/extensions/goal-loop ~/.pi/agent/extensions/
rm -rf ~/.pi/agent/extensions/btw
cp -r pi/extensions/btw ~/.pi/agent/extensions/
rm -rf ~/.pi/agent/extensions/caveman
cp -r pi/extensions/caveman ~/.pi/agent/extensions/

# 4) Install Headroom CLI
pipx install "headroom-ai[proxy]"
# or
uv tool install "headroom-ai[proxy]"

# 5) Start Pi
pi
```

Inside Pi:

```text
/login
/reload
/mcp setup
/settings
```

Set theme to `irfan-gruvbox` in `/settings`, or in Pi settings:

```json
{
  "theme": "irfan-gruvbox"
}
```

## Prerequisites

- Node.js/npm on `PATH`
- `pipx` or `uv` for Headroom/Hindsight helper tools
- LLM provider configured by `/login` or env vars
- API keys only for providers you use
- Shell profile: `~/.zshrc` or `~/.bashrc`

## Install details

### Pi

```bash
pi --version
pi
```

### Required extensions

| Extension | Install command | Purpose |
| --- | --- | --- |
| MCP adapter | `pi install npm:pi-mcp-adapter` | Standard MCP config/tools in Pi |
| Subagents | `pi install npm:@tintinweb/pi-subagents` | Delegated agent workflows |
| Permissions | `pi install npm:@gotgenes/pi-permission-system` | Approval gates |
| Context mode | `pi install npm:context-mode` | Context-saving tools/workflows |
| Ask user | `pi install npm:@juicesharp/rpiv-ask-user-question` | Structured questions |
| Markdown preview | `pi install npm:pi-markdown-preview` | Render/export Markdown |
| Todo | `pi install npm:@juicesharp/rpiv-todo` | Task tracking |
| 9router | `pi install npm:pi-9router-ext` | Model/search routing |
| Stats | `pi install npm:pi-stats-ext` | Usage stats |

Run `/reload` after install.

### Local templates

| Template | Copy command | Notes |
| --- | --- | --- |
| Theme | `cp pi/themes/irfan-gruvbox.json ~/.pi/agent/themes/` | Main Gruvbox/OMP-style theme |
| Signature UI | `cp pi/extensions/pi-signature.ts ~/.pi/agent/extensions/` | Header, spinner, compact footer |
| Headroom | `cp -r pi/extensions/headroom ~/.pi/agent/extensions/` | Needs Headroom CLI |
| Hindsight | `cp -r pi/extensions/hindsight ~/.pi/agent/extensions/` | Needs local daemon |
| Managed skills | `cp -r pi/extensions/managed-skills ~/.pi/agent/extensions/` | Adds `manage_skill`, `learn`, `/managed-skills` |
| Goal loop | `cp -r pi/extensions/goal-loop ~/.pi/agent/extensions/` | Adds `/goal` |
| BTW | `rm -rf ~/.pi/agent/extensions/btw && cp -r pi/extensions/btw ~/.pi/agent/extensions/` | Adds local `/btw` |
| Caveman | `rm -rf ~/.pi/agent/extensions/caveman && cp -r pi/extensions/caveman ~/.pi/agent/extensions/` | Adds local `/caveman` |

## Configuration paths

| Path | Scope | Use |
| --- | --- | --- |
| `~/.pi/agent/themes/` | Global Pi | Themes |
| `~/.pi/agent/extensions/` | Global Pi | Extensions |
| `~/.pi/agent/extensions/pi-permission-system/config.json` | Global Pi | Permission policy |
| `~/.pi/agent/headroom/config.json` | Global Pi | Headroom adapter config |
| `~/.pi/agent/hindsight/config.json` | Global Pi | Hindsight daemon config |
| `~/.pi/agent/managed-skills/config.json` | Global Pi | Managed skills config |
| `~/.pi/agent/managed-skills/` | Global Pi | Generated managed skill files |
| `~/.pi/agent/caveman/config.json` | Global Pi | Caveman extension config |
| `~/.pi/agent/btw/config.json` | Global Pi | BTW side-question config |
| `~/.pi/agent/goal-loop/config.json` | Global Pi | Goal-loop config |
| `~/.pi/agent/goal-loop/state/<root-key>.json` | Global Pi | Per-working-root active goal state |
| `~/.pi/agent/goal-loop/archive/<root-key>/<goal-id>.json` | Global Pi | Completed goal snapshots |
| `~/.pi/agent/goal-loop/logs/<root-key>.jsonl` | Global Pi | Append-only goal-loop audit log |
| `~/.config/mcp/mcp.json` | Global shared | Preferred MCP config |
| `.mcp.json` | Project-local | Project MCP servers |
| `~/.pi/agent/mcp.json` | Pi global | Pi-specific MCP override |
| `pi/mcp.json` | Repo example | Copy only needed parts |

## Secrets and auth

Prefer `/login` or environment variables. Never commit secrets.

```bash
# LLM provider example
export ANTHROPIC_API_KEY="sk-ant-..."

# Search providers
export TAVILY_API_KEY="tvly-..."
export EXA_API_KEY="exa-..."
export BRAVE_API_KEY="BSA..."

# Work MCP examples
export WORK_CUSTOM_HEADER="..."
export WORK_MCP_TOKEN="..."
```

Reload shell:

```bash
source ~/.zshrc
# or
source ~/.bashrc
```

Inside Pi:

```text
/login
/model
```

## MCP setup

Preferred global file:

```bash
mkdir -p ~/.config/mcp
$EDITOR ~/.config/mcp/mcp.json
```

Search MCP example:

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

OAuth MCP example:

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

Bearer MCP example:

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

Useful Pi commands:

```text
/mcp
/mcp setup
/mcp tools
/mcp-auth work-api
/mcp reconnect <server-name>
/reload
```

MCP tool-call shape:

```text
mcp({ search: "web search" })
mcp({ describe: "tool_name" })
mcp({ tool: "tool_name", args: '{"query":"example"}' })
```

`args` must be JSON string.

## Permission policy

Create global policy:

```bash
mkdir -p ~/.pi/agent/extensions/pi-permission-system
$EDITOR ~/.pi/agent/extensions/pi-permission-system/config.json
```

Recommended policy:

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
    "manage_skill": "ask",
    "learn": "ask",
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

Remove or migrate legacy `~/.pi/agent/pi-permissions.jsonc` if warnings appear.

## Theme and signature UI

Included:

- `irfan-gruvbox`: Gruvbox Dark with OMP-inspired neutral tool cards, readable code output, softer greens.
- `pi-signature.ts`: gradient `π` header, current-user detection, `crafted from Irfan's Pi setup` credit, `π` spinner, compact footer statuses.

Install:

```bash
mkdir -p ~/.pi/agent/themes ~/.pi/agent/extensions
cp pi/themes/irfan-gruvbox.json ~/.pi/agent/themes/
cp pi/extensions/pi-signature.ts ~/.pi/agent/extensions/
```

Optional overrides:

```bash
export PI_SIGNATURE_NAME="Your Name"
export PI_SIGNATURE_COMPACT_FOOTER=0
```

Run `/reload` after changes.

## Headroom adapter

Purpose: compress large Pi tool results through local Headroom proxy, store originals locally, retrieve with native tools.

Install:

```bash
pipx install "headroom-ai[proxy]"
# or
uv tool install "headroom-ai[proxy]"

mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/headroom ~/.pi/agent/extensions/
```

Commands:

```text
/headroom start
/headroom stop
/headroom restart
/headroom enable
/headroom disable
/headroom status
/headroom stats
/headroom doctor
/headroom logs
/headroom logs clear
/headroom cleanup
/headroom config show
/headroom config save
/headroom config reset
```

Tools:

```text
headroom_retrieve
headroom_stats
```

Default config path:

```text
~/.pi/agent/headroom/config.json
```

Example config:

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

Footer examples: `hr off`, `hr m 55k ↓10%`, `hr x 55k ↓10%`.

## Hindsight memory adapter

Purpose: real memory retain/recall/reflect via local Hindsight daemon, plus local rules.

Setup daemon with a named profile:

```bash
# Uses OpenAI Codex OAuth from ~/.codex/auth.json.
# First authenticate if needed: codex auth login
hindsight-embed profile create pi-codex --port 9478 --merge \
  --env HINDSIGHT_API_LLM_PROVIDER=openai-codex \
  --env HINDSIGHT_API_EMBEDDINGS_PROVIDER=local \
  --env HINDSIGHT_API_RERANKER_PROVIDER=local
hindsight-embed profile set-active pi-codex
hindsight-embed -p pi-codex daemon start
hindsight-embed -p pi-codex daemon status

mkdir -p ~/.pi/agent/hindsight
cat > ~/.pi/agent/hindsight/config.json <<'JSON'
{
  "apiUrl": "http://127.0.0.1:9478",
  "bankId": "coding-agent",
  "scoping": "per-project-tagged",
  "autoStartDaemon": true
}
JSON
```

Profile naming convention: use `pi-codex` for OpenAI Codex OAuth. Reserve `pi-litellm` for a real LiteLLM server profile.

For API-key OpenAI instead, set `HINDSIGHT_API_LLM_PROVIDER=openai` and pass `HINDSIGHT_API_LLM_API_KEY` via environment/profile config, not this repo.

Install adapter:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/hindsight ~/.pi/agent/extensions/
```

Commands:

```text
/hindsight view
/hindsight stats
/hindsight diagnose
/hindsight clear
/hindsight recall <query>
/hindsight memory enable
/hindsight memory disable
/hindsight config show
/hindsight config set <key> <value>
/hindsight config save
/hindsight config reset
/rules list
/rules reload
/rules show <name>
```

Tools:

```text
hindsight_retain
hindsight_recall
hindsight_reflect
hindsight_rule
```

Footer examples: `mem ok`, `mem checking`, `mem offline`, `mem:<bank> ok`.

## Managed skills extension

Purpose: OMP-inspired generated reusable skills for Pi. Provides `manage_skill`, `learn`, and `/managed-skills`, writing only isolated generated skills under:

Requires Pi `>=0.80.4`; `autoContinue` uses `agent_settled` so hidden capture waits for retries, compaction, and queued follow-ups to finish.

```text
~/.pi/agent/managed-skills/<skill-name>/SKILL.md
```

Install:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/managed-skills ~/.pi/agent/extensions/
```

Commands:

```text
/managed-skills status
/managed-skills list
/managed-skills enable
/managed-skills disable
/managed-skills learn on|off
/managed-skills auto on|off
/managed-skills autocontinue on|off
/managed-skills view <name>
/managed-skills delete <name>
/managed-skills config
/managed-skills reload
```

Tools:

```text
manage_skill  # create/update/delete/list/view isolated managed SKILL.md files
learn         # retain durable lessons in Hindsight, optionally with a managed skill
```

Default config:

```json
{
  "enabled": true,
  "learnEnabled": true,
  "autoCapture": false,
  "autoContinue": false,
  "minToolCalls": 5,
  "maxSkillBytes": 64000,
  "maxMemoryChars": 12000
}
```

Safety:

- generated skills stay under `~/.pi/agent/managed-skills`
- skill names use strict kebab-case: lowercase letters/digits with single hyphens between segments, max 64 chars
- discovery contributes only explicit, bounded `SKILL.md` files, never the parent root
- managed root, skill directories, and `SKILL.md` files must not be symlinks
- reads reject hard-linked files and use `O_NOFOLLOW`
- config and skill updates use same-directory atomic replacement
- malformed existing config fails closed and reports a diagnostic in `/managed-skills status`
- `learn` redacts common secret patterns before retaining to Hindsight
- keep `autoCapture` and `autoContinue` off until manual capture feels safe

Run `/reload` after creating, updating, deleting, or copying managed skills.

## Caveman extension

Purpose: local terse-response style extension, replacing old external `pi-caveman` Git package.

Install:

```bash
mkdir -p ~/.pi/agent/extensions
rm -rf ~/.pi/agent/extensions/caveman
cp -r pi/extensions/caveman ~/.pi/agent/extensions/
```

Commands:

```text
/caveman
/caveman lite|full|ultra|micro
/caveman off|normal
/caveman status
/caveman config
/caveman default full
/caveman status-bar off
/caveman auto-trigger on
/caveman trigger-level full
```

Trigger phrases include `caveman mode`, `talk like caveman`, `less tokens`, `be brief`, `normal mode`, and `stop caveman`.

Config path:

```text
~/.pi/agent/caveman/config.json
```

If old upstream config exists at `~/.pi/agent/caveman.json`, local extension reads it when new config is absent. Do not keep both old Git package and local template active: both register `/caveman`.

## BTW extension

Purpose: local `/btw` side-question channel for asking quick questions while the main Pi agent keeps working.

Install:

```bash
mkdir -p ~/.pi/agent/extensions
rm -rf ~/.pi/agent/extensions/btw
cp -r pi/extensions/btw ~/.pi/agent/extensions/
```

Commands:

```text
/btw <side question>
/btw status
/btw clear
```

Optional config:

```text
~/.pi/agent/btw/config.json
```

Example:

```json
{
  "model": "openrouter/openai/gpt-5-mini",
  "thinkingLevel": "low",
  "maxContextChars": 40000,
  "maxHistoryTurns": 8
}
```

Design notes:

- uses the current Pi model by default, or `provider/model-id` from config
- inherits current thinking level unless config overrides it
- copies compaction-aware main-session context and hidden `/btw` history into a separate model call
- uses Pi model runtime when available, preserving extension provider transports and configured auth
- passes `thinkingLevel: "off"` explicitly instead of omitting reasoning
- does not call `pi.sendUserMessage()` and does not append side answers to the main session
- first version has no tools and no bottom overlay; use it for quick context-aware chat, not parallel editing

## Goal loop

Purpose: Pi-working-root-scoped `/goal` command with persisted state, completion receipts, usage limits, verification evidence, and auto-continue loops.

Requires Pi `>=0.80.4` and `@tintinweb/pi-subagents`. The extension records run output at `agent_end`, calls a separate evaluator, and makes one continuation decision at `agent_settled`.

Install:

```bash
pi install npm:@tintinweb/pi-subagents
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/goal-loop ~/.pi/agent/extensions/
```

Commands:

```text
/goal                       # objective, duration, evaluated runs, usage, and latest reason
/goal status                # explicit status alias
/goal <objective>           # starts immediately; maximum 4,000 characters
/goal list                  # active goals across stored working roots
/goal pause
/goal resume
/goal clear
/goal edit <objective>
/goal verify <command>
/goal budget <tokens|off>   # opt-in cumulative assistant-token budget
```

Clear aliases: `/goal stop`, `/goal off`, `/goal reset`, `/goal none`, and `/goal cancel`.

Tools:

```text
get_goal
update_goal
```

Optional config:

```text
~/.pi/agent/goal-loop/config.json
```

Default:

```json
{
  "allowModelCreateGoal": false
}
```

Keep `allowModelCreateGoal: false` unless you want model-callable goal creation.

The human owns goal creation, pause/resume, objective edits, turn budgets, and optional token budgets. Models can record evidence and propose outcomes, but a coordinator-owned read-only `Explore` evaluator decides every settled autonomous run through `subagents:rpc:spawn`. Missing, malformed, failed, or stale evaluator results fail closed at `needs_user`; completion also requires fresh passed verification evidence.

Evaluator input is bounded to 50 verification commands, 500 characters per command, and 2,000 characters per evidence summary. Command-specific verification evidence must reference a configured command. Stale writer locks are recovered only when their process identity proves the owner is gone; malformed locks and orphaned recovery claims fail closed with an actionable cleanup path.

A normal user follow-up during an active run is saved as durable steering. It increments the goal revision, invalidates proof from the interrupted run, and resumes automatically with the new direction after the user turn settles.

Identity is the normalized Pi working root (`ctx.cwd`), not a discovered Git worktree root or filesystem realpath. Parallel safety therefore requires launching each Pi session from a distinct Git worktree root. Launching from different subdirectories or symlink spellings creates distinct keys and is not detected as same-worktree concurrency. Each exact root key has one active goal and one session-owned execution lease.

Completion writes an idempotent snapshot under `~/.pi/agent/goal-loop/archive/` before clearing the active slot, so bare `/goal` can show the latest achievement.

Only finalized assistant usage from accepted autonomous runs is accumulated (`input`, `output`, cache fields, `totalTokens`, and `cost.total`). Reasoning is already included in output and is not added twice; ordinary user turns do not count. Reaching an opt-in token budget produces `token_budget_limited`. A correlated terminal HTTP 429 produces `usage_limited`, while a successful retry remains transient.

Existing installations should recopy the template, then run `/reload` or restart Pi.

The extension does not bypass Pi permissions. It does not schedule work after Pi exits or execute verification commands independently, and same-worktree detection still requires launching concurrent sessions from distinct Git worktree roots.

## Skills

Install skills with `npx skills` / `npx skills@latest`. Do not manually copy skill files unless intentionally developing skills.

### Core personal skills

```bash
npx skills add irfansofyana/ai-marketplace --global --skill mermaid
npx skills add irfansofyana/ai-marketplace --global --skill 9router-web-researcher
npx skills add irfansofyana/ai-marketplace --global --skill code-review
npx skills add irfansofyana/ai-marketplace --global --skill decision-sparring
npx skills add irfansofyana/ai-marketplace --global --skill idea-refinery
```

### General skills

```bash
npx skills@latest add mattpocock/skills --global --skill grill-me
npx skills@latest add mattpocock/skills --global --skill caveman
npx skills@latest add mattpocock/skills --global --skill teach
npx skills add https://github.com/anthropics/skills --skill frontend-design --global
npx skills add https://github.com/anthropics/skills --skill skill-creator --global
npx skills add hardikpandya/stop-slop --global --skill stop-slop
```

### Notion skills

```bash
npx skills add makenotion/skills --global
# or only CLI skill
npx skills add makenotion/skills --global --skill notion-cli
```

Run `/reload` after skill changes.

## Optional: Understand-Anything

Adds Pi commands for codebase graphs, dashboard, chat, diffs, explanations, onboarding.

Install from Egonex fork:

```bash
curl -fsSL https://raw.githubusercontent.com/Egonex-AI/Understand-Anything/main/install.sh | bash -s pi
```

Useful commands:

```text
/understand
/understand-dashboard
/understand-chat How does authentication work?
/understand-diff
/understand-explain README.md
/understand-onboard
```

Uninstall:

```bash
cd ~/.understand-anything/repo
bash install.sh --uninstall pi
rm -rf ~/.understand-anything ~/.understand-anything-plugin
```

## Optional: Notion CLI (`ntn`)

Install:

```bash
curl -fsSL https://ntn.dev | bash
# or Node.js 22+ / npm 10+
npm install --global ntn
```

Verify/auth:

```bash
ntn --version
ntn --help
ntn login
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

## Daily commands

| Task | Command |
| --- | --- |
| Reload config/extensions/skills | `/reload` |
| Configure providers | `/login` |
| Switch model | `/model` |
| MCP status | `/mcp` |
| MCP setup | `/mcp setup` |
| MCP tools | `/mcp tools` |
| Permissions UI | `/permission-system` |
| Headroom status | `/headroom status` |
| Hindsight diagnose | `/hindsight diagnose` |
| Caveman status | `/caveman status` |
| BTW status | `/btw status` |
| Goal status | `/goal` (or `/goal status`) |
| Update Pi | `pi update` |
| Update extensions | `pi update --extensions` |
| List packages | `pi list` |

## Verify setup

Inside Pi:

```text
/reload
/mcp
/mcp tools
```

Smoke-test prompts:

```text
Use 9router-web-researcher to find current Pi MCP adapter docs.
Create a Mermaid diagram of this repository setup.
Review README.md for clarity and missing setup steps.
```

Notion smoke test:

```bash
ntn --version
ntn api ls
```

Inside Pi:

```text
Use the notion-cli skill to list Notion API endpoints.
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Pi cannot find npm command | Check `npm bin -g`, `PATH`, restart shell |
| MCP server does not start | Run `/mcp`, inspect error, verify env keys |
| OAuth server unauthorized | Run `/mcp-auth <server-name>` |
| Direct MCP tools missing | Run `/mcp reconnect <server-name>`, then `/reload` |
| Too many MCP tools in context | Remove `directTools: true` or list selected tools only |
| Skills do not trigger | Restart Pi or `/reload`; confirm skill in startup header |
| Headroom offline | Run `/headroom doctor`, then `/headroom start` |
| Hindsight offline | Run `/hindsight diagnose`, check daemon port/config |
| Duplicate `/caveman` | Remove old external package or local duplicate; keep only repo template |
| Theme not applied | Confirm `irfan-gruvbox.json` copied and selected in `/settings` |

## Maintenance

```bash
pi update
pi update --extensions
pi list
```

After changing extensions, themes, MCP config, permission policy, skills, or env vars: run `/reload` or restart Pi.
