# hindsight

Real Hindsight-backed memory + Pi rulebook/TTSR helpers for Pi.

Memory uses a local Hindsight daemon (`hindsight-embed` or full Hindsight API). Rules remain local Pi-compatible helpers.

## Setup

Recommended local daemon:

```bash
uvx hindsight-embed@latest configure
uvx hindsight-embed daemon status
```

Or run full Hindsight locally:

```bash
docker run -it --pull always --name hindsight --restart unless-stopped \
  -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```

Default API URL: `http://127.0.0.1:8888`.

## Config

Config file:

```text
~/.pi/agent/hindsight/config.json
```

Example:

```json
{
  "apiUrl": "http://127.0.0.1:9478",
  "bankId": "coding-agent",
  "scoping": "per-project-tagged"
}
```

Environment variables override config file values:

- `HINDSIGHT_CONFIG_PATH` — optional alternate config file path.
- `HINDSIGHT_API_URL` / `apiUrl` — Hindsight API URL, default `http://127.0.0.1:8888`.
- `HINDSIGHT_API_TOKEN` / `HINDSIGHT_API_KEY` — bearer token, optional for local daemon; env-only, do not put secrets in config files.
- `HINDSIGHT_BANK_ID` / `bankId` — base bank, default `coding-agent`.
- `HINDSIGHT_SCOPING` / `scoping` — `global`, `per-project`, or `per-project-tagged`; default `per-project-tagged`.
- `HINDSIGHT_AUTO_RECALL` / `autoRecall` — `false` disables first-turn recall.
- `HINDSIGHT_AUTO_RETAIN` / `autoRetain` — `false` disables shutdown transcript retain.
- `HINDSIGHT_MEMORY_BACKEND` / `memoryBackend` — `false` disables memory hooks.
- `HINDSIGHT_RETAIN_MODE` / `retainMode` — `full-session` or `last-turn`; controls shutdown auto-retain transcript scope.
- `HINDSIGHT_RECALL_BUDGET` / `recallBudget` — `low`, `mid`, or `high`; default `mid`.
- `HINDSIGHT_RECALL_MAX_TOKENS` / `recallMaxTokens` — default `1024`.
- `HINDSIGHT_REQUEST_TIMEOUT_MS` / `requestTimeoutMs` — HTTP timeout for daemon calls, default `30000`; set `0` to disable.
- `HINDSIGHT_AUTO_START_DAEMON` / `autoStartDaemon` — `true` lets failed local HTTP calls try `uvx hindsight-embed daemon start` once.

## Scoping

Default is oh-my-pi-style `per-project-tagged`:

- bank: `coding-agent`
- project retain tag: `project:<basename>-<8-char sha1 cwd>`
- `project` query scope: that exact project tag (`tags_match: exact`), preventing memories tagged for other projects from leaking in
- `global` query scope: exactly untagged memories (`tags: []`, `tags_match: exact`)
- `all` query scope: current-project-tagged plus untagged global memories (`tags_match: any`); memories tagged for other projects remain excluded

Explicit retains default to `project`; shutdown transcript retention is always project-scoped. Explicit `global` retains are untagged and must be reserved for durable cross-project facts, user preferences, and reusable procedures—not project-specific code, repository details, or full transcripts. Explicit recall and reflect default to `all`.

`per-project` keeps its separate bank per cwd for project/all operations; explicit global memories use the untagged base bank. `global` preserves its single untagged bank behavior. Exact untagged queries require a Hindsight version containing upstream exact-empty-tag support (vectorize-io/hindsight#2364).

## Commands

- Footer/status — Pi shows compact memory state such as `mem ok`, `mem checking`, `mem offline`, or `mem:<bank> ok` for non-default banks.
- `/hindsight view` — show runtime config.
- `/hindsight config show` — show config file plus effective runtime config.
- `/hindsight config set <key> <value>` — update runtime config and persist it to `~/.pi/agent/hindsight/config.json`.
- `/hindsight config save` — persist current runtime config.
- `/hindsight config reset` — clear the config file and reload defaults/env.
- `/hindsight stats` — show Hindsight URL, bank scope, daemon health, and rule counts.
- `/hindsight diagnose` — show paths/config/rules and `hindsight-embed daemon status`.
- `/hindsight recall <query>` — recall from real Hindsight.
- `/hindsight clear` — clears memories in the scoped bank only when not using shared `per-project-tagged`; otherwise tells you to curate tagged memories in Hindsight UI.
- `/hindsight memory enable|disable` — toggle memory hooks for current Pi session.

Config keys accepted by `/hindsight config set`: `apiUrl`, `bankId`, `scoping`, `autoRecall`, `autoRetain`, `autoStartDaemon`, `memoryBackend`, `retainMode`, `recallBudget`, `recallMaxTokens`, `requestTimeoutMs`. Environment variables still override matching file values until Pi restarts without those variables.
- `/rules list|reload|show <name>` — inspect or reload local rule cache.

## Tools

- `hindsight_retain` — synchronously retains rich content and accepts `scope: project|global` (default `project`).
- `hindsight_recall` — calls `/v1/default/banks/{bank}/memories/recall` and accepts `scope: project|global|all` (default `all`).
- `hindsight_reflect` — calls `/v1/default/banks/{bank}/reflect` and accepts `scope: project|global|all` (default `all`).
- `hindsight_rule` — looks up local rule cache by name or `rule://name`.

Retain full context. Hindsight extracts facts, entities, temporal/causal relationships, and embeddings server-side.

## Memory behavior guidance

This extension follows the upstream `hindsight-local` skill shape:

- Recall first before non-trivial tasks, implementation decisions, tool/library suggestions, or unfamiliar project areas.
- Retain project conventions, code, bugs/fixes, architecture, and dependencies with project scope.
- Use global scope only for durable cross-project user preferences, facts, or reusable procedures; never store project-specific code or full session transcripts globally.
- Pass rich context to retain: include what happened, why, exact commands/errors/outcomes, and relevant conversation excerpts. Do not over-summarize; Hindsight extracts facts server-side.
- Use categories as context labels such as `preferences`, `procedures`, `learnings`, `decisions`, `bugs`, or `workarounds`.
- Never retain secrets, credentials, API keys, tokens, or sensitive values.

## Rules

Rules are still local:

- `~/.pi/agent/rules/*.{md,mdc}` — native rules, priority 100.
- `<cwd>/.cursor/rules/*.{md,mdc}` — priority 50.
- `<cwd>/.windsurf/rules/*.{md,mdc}` — priority 50.
- `<cwd>/.cline/rules/*.{md,mdc}` — priority 40.
- `<cwd>/AGENTS.md` — synthesized always-apply rule, priority 70.
- `<cwd>/RULES.md` — synthesized always-apply rule, priority 100.
- builtin defaults — secret redaction safety and stale-memory guidance.

Buckets: TTSR first (`condition`/`astCondition`), then `alwaysApply`, then rulebook (`description`).

## Upstream Pi limitations

Upstream Pi, unlike an oh-my-pi fork, cannot do true fork-only mid-token abort/rewind. This extension approximates TTSR with `tool_result`, `tool_call`, and `input` hooks.

## Verify

```bash
npx -y tsx --test index.test.ts
```
