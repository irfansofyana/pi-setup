# Isolated subagent-manager manual test

## Launch

From the repository root:

```bash
node pi/extensions/subagents/preview.mjs --prepare-only --headroom
# Reuse the private path printed above:
node pi/extensions/subagents/preview.mjs --profile=/tmp/pi-subagents-preview-EXAMPLE --model=provider/model-id
```

The checkout needs its reviewed package dependencies (including the three inherited
viewer libraries). If missing/stale, install workspace dependencies separately,
with at least 2 GiB host memory available; this does not install a global Pi package:

```bash
systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 -p CPUQuota=50% -p TasksMax=64 -p RuntimeMaxSec=180 npm ci --ignore-scripts --no-audit --no-fund
```

Do not run this alongside tests or other installs. If limits cannot be enforced,
defer the install; never rerun unbounded. Existing checkout dependencies were not
replaced during implementation; SDK checks used a disposable Pi 1.1.0 fixture.
Keep your actual Pi CLI compatible (at least 1.0.0).

New profiles prefer Headroom. `--headroom` loads the parent adapter in this private
profile, with its own `headroom/config.json`, logs and PID state. It can adopt an
existing healthy proxy; it never stops an externally owned proxy. The Python CLI
remains separately installed. Missing/disabled/unready or incompatible Headroom
causes direct upstream routing with a warning before the request; a submitted
failure is not retried: child agent/provider automatic retries are disabled, without
changing parent retry settings. An explicit continuation is a new request.
`--native-routing` explicitly selects direct-only mode.
Existing profiles preserve routing unless changed by one of these flags. OAuth
`/login` happens in this profile, never copied from your live device.

Use an exact available model assignment. Without `--profile`, a command creates a private, retained temporary profile. The runtime loads its four bundled types directly; no manual template copy is needed. Reuse accepts only an existing private marked profile, preserves its custom definitions/model overrides and never copies your global credentials. Existing FFF and `mermaid`, `teach`, `code-review` skills are discovered; nothing is installed. Override initial paths with `--fff=/absolute/src/index.ts` or `--pi=/absolute/pi`. Missing resources fail closed. Use environment credentials or `/login` **inside this profile**. Research web calls need `TAVILY_API_KEY`; Exa is optional. Provider requests can incur charges.

Interactive launch requires at least 2 GiB host memory headroom and a systemd user manager: `MemoryMax=1G`, `MemorySwapMax=0`, `CPUQuota=50%`, `TasksMax=64`, `RuntimeMaxSec=3600`. No unbounded fallback. One child runs at a time. The limit can terminate this process; containment does not guarantee against every host problem. Parent Pi tools retain their normal permissions: this is not an OS sandbox.

Only explicit reviewed entrypoints load: subagents, Headroom with `--headroom`, plus Goal/Prompt Loop with `--integration`. Global settings/packages, installed roles and selected themes stay untouched; Tintinweb remains installed outside this profile. No `/reload` is needed for a separate process. Optional `--persist --schedules --workflows --integration --theme-ui` flags can be added after the first short read-only task.

`--theme-ui` adds only the canonical `pi-irfan-devs` theme/editor/Signature and palette to this process, for coexistence testing. It does not select a theme on your existing device. Pi may ask for project trust; an untrusted/session-only choice still allows these explicit reviewed entrypoints and avoids enabling ambient project resources.

## First manual task

Ask the preview Pi:

> Call agent_types. Use agent_spawn with path map-entrypoints, type scout, maxTurns 3 and wait false. Map the subagent extension entrypoints without changing files. Then call agent_wait for map-entrypoints.

`/agents` opens settings. `/agents tree` opens upstream's live tree; Enter inspects a selected
thread, Escape closes the viewer without stopping it, and its input uses steering.
Steering a settled thread resumes the same in-memory session and lifetime budget.
`agent_stop` retains that session; consume/close in `/agents fleet` releases capacity.
The old `Agent`, result and exact-run control tools remain compatible.

## UI and customization checks

- `/agents settings`: try Full/Minimal widgets, icon/loader preferences, costs and mode guidance. Deployment ceilings validate before saving; unsupported broad tool filtering rejects explicitly.
- `/agents types`: browse the four defaults, edit model preferences or create a bounded custom type. User definitions save in this private profile's `subagent-manager/agents/`; project save is offered only with project trust. Canonical tool expansion rejects before writing.
- `/agents reload`: refresh settings and definitions for new admissions; already retained threads keep their original definition/model/context.
- `/agents import`: checkbox-select legacy definitions in this private profile or an explicitly trusted project. Cancellation starts no model turn. Selection asks the current model to convert them; originals stay unchanged. Preview discovery uses the private home and ignores inherited extra-directory environment paths; explicit scan directories in this profile/trusted project remain user-owned. This can incur a parent provider call.
- `/agents reap`: preview and confirm forgetting eligible completed sessions. They cannot be resumed afterwards; unconsumed outcome evidence is retained separately.
- Ctrl+Shift+A opens the browser; Ctrl+Shift+C collapses/expands the widget without taking over the theme editor. Test these with `--theme-ui`, resizing and an unsent draft.
- Off hides model tools/widgets/costs and suppresses parent notifications/wakes. Opportunistic delegates selectively; Orchestration adds upstream coordinator guidance. These are model instructions, not an OS permission gate.
- Event-style costs publish the upstream footer event, with a status-key fallback if no external `/footer` consumer exists. They never replace Signature's existing footer.
- A detached completion wakes an idle parent once for coalesced events. Final Recap starts one summary after all outstanding detached agents finish. Notifications remain hidden so a child's message does not displace the main response.
- Child `agent_update` reports progress. `agent_pause` checkpoints for a parent decision without another model request; `agent_steer` continues the same context, with cumulative budget unchanged.
- `/agents fleet` → Extend turn budget grants an explicit additional allowance to the exact current run after confirmation. At most two grants per lifetime, each no larger than the initial soft allowance. Elapsed deadline, tokens and cost never reset; hard-exhausted sessions cannot be revived. Model controls use `subagent_control` with `operation: "extend_budget"`, `expectedRunId` and `additionalTurns`. Hard-two evaluators and schedule/workflow-reserved tasks cannot extend their caller-owned budgets.

First run `/agents-demo`: it streams synthetic text/tool detail with no SDK model calls or file tools. Then open `/agents fleet` during a real worker. The inspector buffers at most 64 KiB per thread; tool details are separately bounded and marked when truncated. Arrows/j/k scroll, `f` follows, Escape/q closes only the viewer. Native dialogs offer message, steer, follow-up, resume, interrupt, consume and close. RPC clients use `/agents fleet` for native dialogs; the default upstream tree is terminal-only. `subagent_control` uses version 1 and exact thread/run IDs. Receipts do not prove model consumption; `completed` means settlement, not task verification.

For a custom coordinator, use `/agents types` to create a type and explicitly
select `agent_types`, `agent_spawn`, `agent_wait`, `agent_status`, `agent_steer`,
`agent_output` and `agent_stop` as needed. They are descendant-scoped; no sibling
or ancestor access is granted. Ask it to spawn one small read-only worker, wait
and summarize. Test this only after closing/consuming earlier tasks so the four
thread/result caps have room. Built-in specialists deliberately cannot delegate.
To test an independent root, ask the main agent to spawn an absolute `/side-task`
with a self-contained task; it receives no lexical-parent context.

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

Model-facing tools: upstream `agent_types`, `agent_spawn`, `agent_wait`, `agent_steer`, `agent_status`, `agent_stop`, `agent_output`, plus compatibility `Agent`, `get_subagent_result`, `steer_subagent`, `subagent_control`, `subagent_wait`, `subagent_start`, `subagent_job`, `subagent_workflow`. Same-process protocol v2 supports Goal/Prompt Loop; Explore remains a fresh read-only hard-two evaluator. `subagent_start` optionally takes a bounded identified snapshot; researcher rejects local inheritance, and true fork rejects. Children additionally get progress/pause controls; custom types may explicitly opt into reviewed scoped delegation verbs. All starts share admission/result retention, and blocking descendant waits yield the sole execution slot. Four levels including the main agent is the maximum, within the same four-thread preview cap.

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

Explicit setup differences are listed in the [feature audit](parity.md): true native fork, automatic conversation inheritance, persisted child conversation resume, seamless live-worker reload, ambient shell/MCP tools, delegation inside schedule/workflow-reserved tasks, and arbitrary workflow code are unsupported. Custom coordinators are supported with explicit reviewed delegation tools. Root branch/session navigation drains before changing context and attaches a fresh generation; it never replays saved tasks. Real OAuth/provider and Headroom proxy transport remain manual acceptance gates. Tintinweb remains required by repository policy pending an explicit cutover decision; no installed package or global configuration has been changed.
