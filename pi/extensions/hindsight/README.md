# hindsight

Real Hindsight-backed memory + Pi rulebook/TTSR helpers for stock Pi.

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

Environment variables:

- `HINDSIGHT_API_URL` — Hindsight API URL, default `http://127.0.0.1:8888`.
- `HINDSIGHT_API_TOKEN` / `HINDSIGHT_API_KEY` — bearer token, optional for local daemon.
- `HINDSIGHT_BANK_ID` — base bank, default `pi`.
- `HINDSIGHT_SCOPING` — `global`, `per-project`, or `per-project-tagged`; default `per-project-tagged`.
- `HINDSIGHT_AUTO_RECALL` — `false` disables first-turn recall.
- `HINDSIGHT_AUTO_RETAIN` — `false` disables shutdown transcript retain.
- `HINDSIGHT_MEMORY_BACKEND` — `false` disables memory hooks.
- `HINDSIGHT_RETAIN_MODE` — `full-session` or `last-turn`; controls shutdown auto-retain transcript scope.
- `HINDSIGHT_RECALL_BUDGET` — `low`, `mid`, or `high`; default `mid`.
- `HINDSIGHT_RECALL_MAX_TOKENS` — default `1024`.
- `HINDSIGHT_REQUEST_TIMEOUT_MS` — HTTP timeout for daemon calls, default `30000`; set `0` to disable.
- `HINDSIGHT_AUTO_START_DAEMON` — `true` lets failed local HTTP calls try `uvx hindsight-embed daemon start` once.

## Scoping

Default is oh-my-pi-style `per-project-tagged`:

- bank: `pi`
- retain tags: `project:<basename>-<8-char sha1 cwd>`
- recall/reflect use `tags_match: any`, so project memories and untagged global memories can surface.

`per-project` uses a separate bank per cwd. `global` uses one untagged bank.

## Commands

- `/hindsight view` — show config.
- `/hindsight stats` — show Hindsight URL, bank scope, daemon health, and rule counts.
- `/hindsight diagnose` — show paths/config/rules and `hindsight-embed daemon status`.
- `/hindsight recall <query>` — recall from real Hindsight.
- `/hindsight clear` — clears memories in the scoped bank only when not using shared `per-project-tagged`; otherwise tells you to curate tagged memories in Hindsight UI.
- `/hindsight memory enable|disable` — toggle memory hooks for current Pi session.
- `/rules list|reload|show <name>` — inspect or reload local rule cache.

## Tools

- `hindsight_retain` — synchronously retains rich content in real Hindsight and reports failures.
- `hindsight_recall` — calls `/v1/default/banks/{bank}/memories/recall`.
- `hindsight_reflect` — calls `/v1/default/banks/{bank}/reflect`.
- `hindsight_rule` — looks up local rule cache by name or `rule://name`.

Retain full context. Hindsight extracts facts, entities, temporal/causal relationships, and embeddings server-side.

## Memory behavior guidance

This extension follows the upstream `hindsight-local` skill shape:

- Recall first before non-trivial tasks, implementation decisions, tool/library suggestions, or unfamiliar project areas.
- Retain immediately after learning durable user preferences, project conventions, procedure outcomes, bugs and fixes, workarounds, architecture decisions, or dependency/version requirements.
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

## Stock Pi limits

Stock Pi means normal upstream Pi, not an oh-my-pi fork. This extension can use tools/commands/hooks, but cannot do true fork-only mid-token abort/rewind. TTSR is approximated with `tool_result`, `tool_call`, and `input` hooks.

## Verify

```bash
npx -y tsx --test index.test.ts
```
