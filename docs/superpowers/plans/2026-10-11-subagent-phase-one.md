# Subagent Phase One Implementation Plan

> Execute inline using the executing-plans skill. Phase 1 was approved in chat.

**Goal:** Make the native Pi task panel quiet after completion, stable during navigation and resilient to UI failures; present reporting deadlines as informational reminders.

**Architecture:** Filter only the idle dock, leaving retained workers and the expanded navigation roster intact. Contain failures at panel and dock entry points. Format timeout notifications from observed status without changing execution policy.

**Tech Stack:** TypeScript, public Pi TUI components, Node test runner.

**Spec:** Phase 1 approved in chat; [research and proposed experience](../../setup/subagent-badlogic-research.md).

## Constraints and review focus

- No config changes, backend replacement, automatic reaping or result consumption.
- Five-second completion indication; expanded navigation and open details stay stable.
- Keep root prompt routing, identity checks, drafts, key release/repeat and paste guards.
- Account for completion during selection, stale mouse rows, tiny terminals, late callbacks and stacked overlays.
- Run SDK validation only with hard memory/no-swap/CPU/time limits. Local host is under pressure and has no running container engine; author tests first but defer execution to bounded CI.

## Tasks

1. Completion presentation (`fleet-view.ts`, `inline-navigation.ts`, `manager-presentation.ts`).
   - [x] Add regression tests for idle collapse, grace expiry, mixed states, selection, mouse expansion and follow-up visibility (execution deferred).
   - [x] Filter only idle rendering; retain all identities while browsing and stop the clock after grace expiry.
2. Failure containment (`task-panel.ts`, `manager-presentation.ts`).
   - [x] Add failure injection tests for render/input/observer callbacks, cleanup and root focus (execution deferred).
   - [x] Close only the owned overlay; preserve drafts and report a bounded diagnostic without throwing from recovery.
3. Reporting reminders (`task-reminder.ts`, `runtime.ts`).
   - [x] Add tests for queue state, elapsed interval, observed activity, terminal suppression and sanitized text (execution deferred).
   - [x] Replace warning-level reporting timeout with informational state; keep execution deadlines unchanged.
4. Compatibility and documentation.
   - [x] Add resource-bounded public-export/real-render regression checks for supported Pi versions in CI (not yet run).
   - [x] Update owning subagent docs and perform static diff/link checks.
   - [x] Record runtime and interactive validation gaps; leave unrelated edits untouched.
   - [ ] Run the focused CI matrix and manual terminal acceptance before declaring runtime verification complete.

## Execution record

- User authorized implementation directly; no additional design approval is needed.
- Repository validation constraints take precedence over local red/green execution. Tests will be written before implementation; no unexecuted test will be reported as passing.
- Static review found a send-preparation UI failure could strand the pending slot; preparation now shares the delivery cleanup path, with an unsent-draft/reopen regression case.
- Static public-export inspection found all 11 task-UI imports on locally available Pi TUI 1.0.4 and 1.1.0. Local document targets resolve; `git diff --check` passes. No SDK tests, typecheck, installs or interactive acceptance ran.
