# Local Extensions

Copy repo-owned templates from `pi/extensions/` into `~/.pi/agent/extensions/`. Install required npm dependencies from [README package manifest](../../README.md#required-npm-package-manifest); this guide does not duplicate canonical package commands.

## Command Deck chat editor

Purpose: reproduce `irfan-pi` custom chat input without patching Pi or `@earendil-works/pi-tui`.

Features:

- `ASK` labeled input frame with `Ask, build, or investigate…` placeholder
- Ready, thinking, tools, error, and bash state labels
- Spinner, scroll indicators, and responsive narrow-terminal fallback
- `@` file, `/` command, and newline hints

Requires Pi `>=0.80.10`. Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`; no extra runtime package is required.

Install with private backup-and-replace procedure in [Installation](installation.md#install-local-templates). The source template is [`pi/extensions/command-deck`](../../pi/extensions/command-deck).

Run `/reload` after installation. If another extension replaces the editor, load order determines which editor is active.

Smoke test from repository root:

```bash
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent" \
  node pi/extensions/command-deck/smoke-test.mjs
```

Set `PI_ROOT` explicitly when Pi is installed elsewhere. Optional `PI_THEME` points at theme file used by test.

## Headroom adapter

Purpose: compress large Pi tool results through local Headroom proxy, store originals locally, and retrieve with native tools.

The adapter starts Headroom automatically for each Pi session, or adopts an already healthy proxy. Concurrent startup losers recheck and adopt the healthy winner. If an adopted proxy later stops, an auto-start session makes one replacement attempt on the next compression-path health check; failed recovery disables compression to avoid retry storms. Manual/off modes never recover automatically, and there is no background polling. If the CLI is missing, log/PID setup fails, startup times out, spawning fails, or the managed proxy exits unexpectedly, Pi always shows a warning and safely bypasses compression. `notifyFailures` only controls repetitive compression-path warnings.

Install CLI and adapter:

```bash
pipx install "headroom-ai[proxy]"
# or
uv tool install "headroom-ai[proxy]"
```

Deploy adapter with private backup-and-replace procedure in [Installation](installation.md#install-local-templates).

npm `headroom-ai` is SDK-only.

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
  "startup": "auto",
  "proxyUrl": "http://127.0.0.1:8787",
  "allowRemote": false,
  "minChars": 500,
  "startupHealthTimeoutMs": 30000,
  "storeTtlHours": 24,
  "notifyFailures": "once"
}
```

Set `startup` to `manual` to require `/headroom start`, or `off` to prevent startup and compression. Run `/headroom doctor` and `/headroom logs` when automatic startup reports a failure.

Footer examples: `hr off`, `hr m 55k ↓10%`, `hr x 55k ↓10%`.

## Hindsight memory adapter

Purpose: real memory retain/recall/reflect through local Hindsight daemon, plus local rules. oh-my-pi is reference shape for this adapter; Headroom is separate and unrelated.

Setup daemon with named profile:

```bash
# Uses OpenAI Codex OAuth from ~/.codex/auth.json.
# First authenticate if needed: codex auth login
uvx hindsight-embed@latest profile create pi-codex --port 9478 --merge \
  --env HINDSIGHT_API_LLM_PROVIDER=openai-codex \
  --env HINDSIGHT_API_EMBEDDINGS_PROVIDER=local \
  --env HINDSIGHT_API_RERANKER_PROVIDER=local
uvx hindsight-embed@latest profile set-active pi-codex
uvx hindsight-embed@latest -p pi-codex daemon start
uvx hindsight-embed@latest -p pi-codex daemon status


```

Back up `~/.pi/agent/hindsight/config.json`, then merge these keys without deleting unknown keys:

```json
{
  "apiUrl": "http://127.0.0.1:9478",
  "bankId": "coding-agent",
  "scoping": "per-project-tagged",
  "autoStartDaemon": true
}
```

Keep backup private with `umask 077` or equivalent. Profile naming convention: use `pi-codex` for OpenAI Codex OAuth. Reserve `pi-litellm` for real LiteLLM server profile.

For API-key OpenAI, set `HINDSIGHT_API_LLM_PROVIDER=openai` and pass `HINDSIGHT_API_LLM_API_KEY` through environment/profile config, not this repo.

Install adapter with private backup-and-replace procedure in [Installation](installation.md#install-local-templates).

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

```text
~/.pi/agent/managed-skills/<skill-name>/SKILL.md
```

Requires Pi `>=0.80.4`; `autoContinue` uses `agent_settled` so hidden capture waits for retries, compaction, and queued follow-ups to finish.

Install with private backup-and-replace procedure in [Installation](installation.md#install-local-templates).

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

- Generated skills stay under `~/.pi/agent/managed-skills`.
- Skill names use strict kebab-case: lowercase letters/digits with single hyphens between segments, max 64 characters.
- Discovery contributes only explicit, bounded `SKILL.md` files, never parent root.
- Managed root, skill directories, and `SKILL.md` files must not be symlinks.
- Reads reject hard-linked files and use `O_NOFOLLOW`.
- Config and skill updates use same-directory atomic replacement.
- Malformed existing config fails closed and reports diagnostic in `/managed-skills status`.
- `learn` redacts common secret patterns before retaining to Hindsight.
- Keep `autoCapture` and `autoContinue` off until manual capture feels safe.

Run `/reload` after creating, updating, deleting, or copying managed skills.

## BTW extension

Purpose: local `/btw` side-question channel for quick context-aware questions while the main Pi agent keeps working.

Install with private backup-and-replace procedure in [Installation](installation.md#install-local-templates).

Commands:

```text
/btw <side question>
/btw status
/btw clear
```

Optional config path:

```text
~/.pi/agent/btw/config.json
```

Merge config keys into existing file without deleting unknown keys:

```json
{
  "model": "openrouter/openai/gpt-5-mini",
  "thinkingLevel": "low",
  "maxContextChars": 40000,
  "maxHistoryTurns": 8
}
```

- `model` uses `provider/model-id`; omit it to use current Pi model.
- `thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; omit it to inherit current Pi thinking level.
- `maxContextChars` bounds copied main-session text.
- `maxHistoryTurns` bounds hidden side-thread follow-up history.

Behavior and limits:

- Uses Pi model runtime and configured auth/provider transport when available.
- Copies compaction-aware main-session context plus hidden `/btw` history into separate model call.
- Omits `reasoning` when thinking is `off` and skips `bashExecution.excludeFromContext` entries.
- Shows answer through Pi UI notifications without appending it to main conversation.
- Provides no tools or bottom overlay; use it for side chat, not parallel editing.

Run `/reload` after install or config changes. See [extension README](../../pi/extensions/btw/README.md) for implementation notes.

## Caveman extension

Purpose: local terse-response style extension, replacing old external `pi-caveman` Git package.

Install with private backup-and-replace procedure in [Installation](installation.md#install-local-templates).

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

## Goal loop

Purpose: Pi-working-root-scoped `/goal` command with persisted state, completion receipts, usage limits, verification evidence, and auto-continue loops.

Requires Pi `>=0.80.4` and subagent package from [README manifest](../../README.md#required-npm-package-manifest). Extension records run output at `agent_end`, calls separate evaluator, and makes one continuation decision at `agent_settled`.

Install with private backup-and-replace procedure in [Installation](installation.md#install-local-templates).

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

Keep `allowModelCreateGoal: false` unless model-callable goal creation is wanted.

Human owns goal creation, pause/resume, objective edits, turn budgets, and optional token budgets. Models can record evidence and propose outcomes, but coordinator-owned read-only `Explore` evaluator decides every settled autonomous run through `subagents:rpc:spawn`. Missing, malformed, failed, or stale evaluator results fail closed at `needs_user`; completion also requires fresh passed verification evidence.

Evaluator input is bounded to 50 verification commands, 500 characters per command, and 2,000 characters per evidence summary. Command-specific verification evidence must reference configured command. Stale writer locks recover only when process identity proves owner is gone; malformed locks and orphaned recovery claims fail closed with actionable cleanup path.

Normal user follow-up during active run is saved as durable steering. It increments goal revision, invalidates proof from interrupted run, and resumes automatically with new direction after user turn settles.

Identity is normalized Pi working root (`ctx.cwd`), not discovered Git worktree root or filesystem realpath. Parallel safety requires launching each Pi session from distinct Git worktree root. Launching from different subdirectories or symlink spellings creates distinct keys and is not detected as same-worktree concurrency. Each exact root key has one active goal and one session-owned execution lease.

Completion writes idempotent snapshot under `~/.pi/agent/goal-loop/archive/` before clearing active slot, so bare `/goal` can show latest achievement.

Only finalized assistant usage from accepted autonomous runs accumulates (`input`, `output`, cache fields, `totalTokens`, and `cost.total`). Reasoning is already included in output and is not added twice; ordinary user turns do not count. Reaching opt-in token budget produces `token_budget_limited`. Correlated terminal HTTP 429 produces `usage_limited`, while successful retry remains transient.

Existing installations should recopy template, then run `/reload` or restart Pi.

Extension does not bypass Pi permissions. It does not schedule work after Pi exits or execute verification commands independently. Same-worktree detection still requires launching concurrent sessions from distinct Git worktree roots.

## Prompt loop

Purpose: repo-owned Cursor-style `/loop` for repeated local prompts. It runs once immediately, then continues on fixed intervals or agent-selected time/safe-event wakes until agent declares completion, user stops it, or Pi exits.

Requires Pi `>=0.80.4`, repo-owned Goal Loop template, and `@tintinweb/pi-subagents` RPC protocol version 2 from [README package manifest](../../README.md#required-npm-package-manifest).

Use private backup-and-replace procedure in [Installation](installation.md#install-local-templates). Copy both `pi/extensions/goal-loop/` and `pi/extensions/loop/`, then run `/reload` or restart Pi.

Commands:

```text
/loop                         # current status or latest receipt
/loop <prompt>                # dynamic time/event pacing
/loop <N><unit> <prompt>      # compact fixed interval
/loop every 5 minutes <prompt> # natural leading interval
/loop <prompt> every 5 minutes # natural trailing interval
/loop stop                    # case-insensitive cancellation command
```

Examples:

```text
/loop 5m check whether the deployment finished
/loop check whether the deployment finished every 5 minutes
/loop work on this feature until tests pass
```

Behavior:

- First iteration runs immediately.
- Fixed schedules use absolute one-shot timers and coalesce busy ticks.
- Dynamic iterations continue only after `schedule_loop_wakeup` proposes a delay, correlated background subagent, project file change, or allowlisted shared event.
- Allowlisted events are `monitor:done`, `monitor:error`, `tasks:completed`, `tasks:failed`, and `loop:wake`; every wake requires matching correlation ID.
- Agent owns completion: `complete_loop` stops fixed or dynamic mode when iteration settles; omitting dynamic wake also stops.
- Goal Loop coordinates working-root ownership but does not evaluate every Loop iteration.
- `/goal` and `/loop` are mutually exclusive for same working root inside one Pi process; persisted active `/goal` state also blocks new Loop claim.
- Loop claims are process-local. Run concurrent Pi processes only from distinct Git worktree roots; one process cannot reserve its Loop root against `/goal` started in another process.
- Missing Goal coordinator or queued user interruption stops safely.
- State is process-local. `/reload`, session replacement, shutdown, and Pi exit stop loop; no offline daemon exists.
- Pi permissions remain authoritative. Extension does not bypass tool approvals.

Smoke test:

```text
/loop 5m check whether the deployment finished
/loop
/loop stop
/loop work on this feature until tests pass
```

Run focused tests:

```bash
node --test pi/extensions/loop/*.test.ts
node --test pi/extensions/goal-loop/*.test.ts
```

See [extension README](../../pi/extensions/loop/README.md) for internal wake correlation, safety limits, and implementation notes.
