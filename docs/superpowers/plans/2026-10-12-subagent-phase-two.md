# Subagent Phase Two Implementation Plan

**Goal:** Preserve reading state, expose truthful message delivery and simplify task presentation in the native Pi terminal UI.

**Approved scope:** Phase 2 in chat. Implement inline on the current branch; retain Phase 1 and unrelated edits.

## Design

- Add a receipt-preserving human control interface beside legacy `steer`. Capture task lifetime, thread and run when composing; reject stale targets instead of silently resuming another run.
- Browse actions choose steering or follow-up. Composer keys remain editor-owned. Unknown delivery retains the draft and requires an explicit retry acknowledgement; no automatic retry.
- Keep scroll anchors, follow mode and delivery choice per task lifetime. Observe only bounded text fingerprints for unread indicators; never persist transcripts or consume execution results.
- Use short presentation names with full identity in details. Move usage metrics to the inspector and distinguish a finished run from a retained session.

## Steps

- [x] Write control and active-follow-up integration cases; implement receipt-preserving controls and exact-run validation.
- [x] Write reading-state/unread cases; implement bounded lifecycle-owned observation and cleanup.
- [x] Write panel cases for modes, delivery outcomes, stale targets, per-agent scroll and explicit uncertain-delivery retry; wire UI.
- [x] Simplify dock labels/activity, expose unread badges and retained-session status.
- [x] Update documentation and bounded CI matrix; review diff and run permitted static validation.
- [ ] Run focused tests, compatibility matrix and interactive terminal acceptance on a bounded runner.

## Validation constraint

Host memory pressure remains high. Docker is stopped and Podman has no VM. Per repository instructions, SDK tests/install/typecheck execution is deferred until hard memory/no-swap/CPU/time limits are available. Author tests before code, but do not claim observed red/green results. Static checks and CI configuration are not runtime acceptance.

## Static verification

- `node --check`: all 20 changed/new subagent TypeScript files parse without loading imports or running tests.
- `git diff --check`: clean.
- All 13 local links in the touched Phase 2 topic/component documents resolve.
- The compatibility job's embedded shell passes `sh -n`; its SDK matrix remains unexecuted.
- All 11 UI runtime import names appear in both the development and locally installed Pi TUI public declarations. This is not runtime loading or SDK acceptance.

User wording adjustment: the collapsed completion summary now uses “1 sub-agent completed” / “N sub-agents completed.” Mixed active/completed fleets retain unread counts for folded rows.
