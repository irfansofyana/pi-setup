# Isolated native subagent manual test

## Launch

From the repository root:

```bash
node pi/extensions/subagents/preview.mjs --prepare-only --persist --schedules --workflows --integration --theme-ui
# Reuse the private path printed above:
node pi/extensions/subagents/preview.mjs --profile=/tmp/pi-subagents-preview-EXAMPLE --model=provider/model-id
```

Use an exact available model assignment. Without `--profile`, a command creates a private, retained temporary profile and copies the four package templates there. Reuse accepts only an existing private marked profile, preserves its role/model pins and never copies your global credentials. Existing FFF and `mermaid`, `teach`, `code-review` skills are discovered; nothing is installed. Override initial paths with `--fff=/absolute/src/index.ts` or `--pi=/absolute/pi`. Missing resources fail closed. Use environment credentials or `/login` **inside this profile**. Research web calls need `TAVILY_API_KEY`; Exa is optional. Provider requests can incur charges.

Interactive launch requires at least 2 GiB host memory headroom and a systemd user manager: `MemoryMax=1G`, `MemorySwapMax=0`, `CPUQuota=50%`, `TasksMax=64`, `RuntimeMaxSec=3600`. No unbounded fallback. One child runs at a time. The limit can terminate this process; containment does not guarantee against every host problem. Parent Pi tools retain their normal permissions: this is not an OS sandbox.

Only explicit reviewed entrypoints load: native subagents, plus Goal/Prompt Loop when `--integration` is chosen. Global settings/packages, installed roles and selected themes stay untouched; Tintinweb remains installed outside this profile. No `/reload` is needed for a separate process.

`--theme-ui` adds only the canonical `pi-irfan-devs` theme/editor/Signature and palette to this process, for coexistence testing. It does not select a theme on your existing device. Pi may ask for project trust; an untrusted/session-only choice still allows these explicit reviewed entrypoints and avoids enabling ambient project resources.

## First manual task

Ask the preview Pi:

> Use Agent with subagent_type code-mapper, max_turns 3, run_in_background true. Map the subagent extension entrypoints without changing files. Then call get_subagent_result with wait true.

First run `/agents-demo`: it streams synthetic text/tool detail with no SDK model calls or file tools. Then open `/agents fleet` during a real worker. The inspector buffers at most 64 KiB per thread; tool details are separately bounded and marked when truncated. Arrows/j/k scroll, `f` follows, Escape/q closes only the viewer. Native dialogs offer message, steer, follow-up, resume, interrupt, consume and close. RPC clients use native dialogs, not terminal components. `subagent_control` uses version 1 and exact thread/run IDs. Receipts do not prove model consumption; `completed` means settlement, not task verification.

Without `--persist`, results/outbox are memory-only and lost on restart. With it, bounded outcomes, notifications and optional job/workflow journals are private and revisioned under `subagents-state/`; child conversations/transcripts still do not persist. Restart never replays tasks or restores a conversation. `/agents results` reviews/consumes recovered outcomes; `/agents notifications` shows the outbox without triggering a parent model turn. Close finished threads and consume outcomes to release capacity. Caps: four open threads, eight live reserved results, 32 retained outcomes; unconsumed outcomes are never automatically evicted.

## Optional schedules and workflows

These features are off unless explicitly enabled. They use the same native admission/budgets, not additional worker pools.

- `/agents jobs`: create from JSON, inspect, pause future fires, resume, or stop active execution. Timers exist only while Pi runs. Restarted jobs are paused; intervals skip missed ticks and active overlap. Failed admission/lease pauses the job. A failed admitted run does not automatically pause recurrence; explicitly pause if further provider calls are unwanted. Cron is a bounded five-field UTC grammar; other timezones/DST are rejected.
- `/agents workflows`: start a version 1 graph, inspect, pause/resume, retry failed steps, skip, cancel, or provide human verification evidence. No executable scripts, shell/test authority or nested specialist delegation. At most 16 steps, three ready tasks, three attempts per step, and 128 reserved turns across the graph. Retries use new runs and spend the same budget. Structured output uses a finite local JSON-schema subset, not arbitrary validators.
- `/agents storage`: after an unclean exit, inspect/reconcile an exact stale lock only if its PID is dead. Original lock evidence is retained. A live or drifted lease refuses recovery; no automatic stealing.

Example workflow input:

```json
{"version":1,"steps":[{"id":"map","role":"code-mapper","prompt":"Map entrypoints without changes","maxTurns":2},{"id":"review","role":"reviewer","prompt":"Review the mapped design without changes","maxTurns":2,"dependsOn":["map"]},{"id":"manual","kind":"verification","prompt":"User checks the result","dependsOn":["review"]}]}
```

Model-facing tools: `Agent`, `get_subagent_result`, `steer_subagent`, `subagent_control`, `subagent_wait`, `subagent_start`, `subagent_job`, `subagent_workflow`. Same-process protocol v2 supports native Goal/Prompt Loop; Explore is a fresh read-only evaluator with a hard two-turn ceiling. `subagent_start` optionally takes a bounded identified snapshot; researcher rejects local inheritance, and true fork explicitly rejects. Full upstream schema parity is not claimed.

## Builder

Supply explicit `files`, e.g. `["pi/extensions/example/index.ts"]` or a narrowly reviewed directory ending in `/`. Builder starts from committed HEAD, not the parent's dirty files, and writes only those scopes in an owned `pi-subagent/*` worktree. No shell/test tools. SDK mutation receives the validated absolute path; symlink ancestors and ambiguous Unicode whitespace reject. These guards are not an OS sandbox or protection against concurrent hostile filesystem changes.

Worktrees/ownership records remain under the printed profile's `worktrees/`, including after failure/shutdown. Exact run results carry artifact references. `/agents artifacts` validates retained ownership, inspects status/diff, and can start a **fresh** builder task on an existing lease after live builder threads are closed; original scopes/branch remain pinned, not a recovered conversation. Four newly owned artifacts are allowed per process. There is no auto-commit, merge, push or deletion. Human-only discard requires exact branch confirmation and unchanged reviewed status/content fingerprints; dirty/untracked/ignored files are permanently discarded, while the branch/record remain. Reviews exceeding 512 changed paths or 32 MiB of file contents reject cleanup; preserve/review them manually. Do not delete a profile while its worktrees or login state are needed.

## Manual acceptance pending

- Your exact model/auth and installed Pi compatibility.
- Actual FFF search and researcher web calls.
- Live inspector, controls during streaming, stopping and shutdown.
- Builder edits scoped to its worktree; parent checkout unchanged.
- Resume/follow-up with distinct runs and per-run usage; Goal/Prompt Loop correlation.
- Pause/restart schedules and workflow verification gates; retained results/outbox.
- Your terminal's resize, Unicode/paste/focus and existing theme/editor coexistence.

Start with one short read-only task. Do not run broad tests on the shared VM. Automated checks use fake providers and resource-capped processes, not paid calls.

Explicitly unsupported/gated: routed Headroom CLI activation (only a narrow Pi 1.1.0 backend experiment is proven), true native fork, persisted child conversation resume, seamless live-worker reload, broader coordinator roles, arbitrary workflow code, and live companion migration. Reload/session replacement drains instead of reattaching. Tintinweb remains required by repository policy pending an explicit cutover decision; no installed package or global configuration has been changed.
