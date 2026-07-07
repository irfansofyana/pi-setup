# hindsight

OMP-faithful memory + rulebook system for stock Pi. Mirrors OpenMemoryPlan (OMP) concepts: per-project memory store, rule discovery, ttsr/alwaysApply/rulebook buckets.

## Status: P4 (polish/docs + builtin defaults)

P1 retain/recall, P2 portable rules/TTSR, and P3 autonomous memory remain live. P4 adds builtin-default rules, `/hindsight diagnose`, `/hindsight enqueue`, and setup docs. Memory backend defaults off; enable with `/hindsight memory enable`.

## Storage + discovery

- `~/.pi/agent/hindsight/<project-key>/memories.jsonl` — one JSON object per line (`MemoryEntry`), source corpus for P3 rebuild.
- `~/.pi/agent/hindsight/<project-key>/MEMORY.md` — curated long-term memory.
- `~/.pi/agent/hindsight/<project-key>/memory_summary.md` — compact Memory Guidance injected at prompt build.
- `~/.pi/agent/hindsight/<project-key>/skills/` — reserved for generated skills.

`<project-key>` is `<basename>-<8-char sha1 of resolved cwd>` to avoid cross-project bleed between same-named repos.
- `~/.pi/agent/rules/*.{md,mdc}` — native rules, priority 100, provider `native`.
- `<cwd>/.cursor/rules/*.{md,mdc}` — priority 50, provider `cursor`.
- `<cwd>/.windsurf/rules/*.{md,mdc}` — priority 50, provider `windsurf`.
- `<cwd>/.cline/rules/*.{md,mdc}` — priority 40, provider `cline`.
- `<cwd>/AGENTS.md` — synthesized always-apply rule `AGENTS`, priority 70, provider `agents`.
- `<cwd>/RULES.md` — synthesized always-apply rule `RULES`, priority 100, provider `rules`.
- `builtin-defaults` — small safe defaults, priority 1: secret redaction safety and stale-memory guidance.

Rules sort by descending priority. Bucket split follows OMP: TTSR first (`condition`/`astCondition`), then `alwaysApply`, then rulebook (`description`), with first-wins name dedup.

## Commands

- `/hindsight view` — show config
- `/hindsight stats` — memory count + rule bucket counts
- `/hindsight diagnose` — show paths, artifact presence, config, and rule bucket counts
- `/hindsight clear` — delete current project's `memories.jsonl`, `MEMORY.md`, and `memory_summary.md`
- `/hindsight rebuild` — rebuild autonomous memory and re-discover rules for `ctx.cwd`
- `/hindsight enqueue` — queue autonomous memory rebuild in the background
- `/hindsight recall <query>` — search current project's memories
- `/hindsight memory enable|disable` — flip the session-only memory backend flag
- `/rules list` — rule names with provider + bucket
- `/rules reload` — re-discover rules for `ctx.cwd`
- `/rules show <name>` — print rule body

## Tools

- `hindsight_retain` — queues a redacted memory; flushes at 16 items / 5s / shutdown.
- `hindsight_recall` — searches `memories.jsonl` and returns an OMP-style "Relevant memories" block.
- `hindsight_memory` — browse `memory://root`, `memory://root/MEMORY.md`, `memory://root/memory_summary.md`, and `memory://root/skills`.
- `hindsight_rule` — looks up rule cache by name or `rule://name`.

## Rule frontmatter

`---` fenced YAML-ish: `description`, `alwaysApply`, `globs`, `condition` (or legacy `ttsr_trigger`), `astCondition`, `scope`, `interruptMode`, `repeat`, `repeatGap`. `repeat` supports `always`, `once`, `gap`; default is `once`.

## Autonomous memory

- Default off and session-only. Run `/hindsight memory enable` for the current Pi session, then `/hindsight rebuild` (or `/hindsight enqueue`) to create/update artifacts. Do not restart/reload between enable and rebuild unless you re-enable it.
- Rebuild uses `memories.jsonl` only; raw session scanning is deferred.
- LLM rebuild uses current Pi model when credentials are available. If model/auth/import fails, deterministic fallback writes latest deduped retained facts.
- Writes are redacted before `MEMORY.md` and `memory_summary.md` hit disk.
- Injected Memory Guidance is heuristic context. Current repo state and user instruction win on conflict.

## Memory URLs

- `memory://root` — list artifacts.
- `memory://root/MEMORY.md` — read long-term memory.
- `memory://root/memory_summary.md` — read injected summary.

## Portable TTSR limits

Stock Pi cannot do OMP fork-only mid-token abort. P2 approximates:

- `tool_result`: matching TTSR prepends hidden-ish reminder to first text result block.
- `input`: matching prose queues a steer message when `sendMessage`/`sendUserMessage` exists; otherwise no-op.
- `tool_call`: matching tool args blocks coarse tool execution for `tool-only`/`always` rules.

## Roadmap

- **P5**: generated skills or deeper UI surfacing if stock Pi gains better hooks.

## Verify

```bash
npx -y tsx --test index.test.ts
```
