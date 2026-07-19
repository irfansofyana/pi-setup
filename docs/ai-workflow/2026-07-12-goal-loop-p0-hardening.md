# Goal Loop P0 Hardening

## Goal

Implement the approved P0 safety hardening for `pi/extensions/goal-loop` without expanding into richer goal contracts, new UX commands, scheduling, or self-evolution.

## Mode

Large/Risky

## Current Status

Implemented on `feat/goal-loop-p0-hardening`; ready for final review and integration decision.

## Local Instructions

- Consulted repository `AGENTS.md` and `/Users/irfanputra/.codex/RTK.md`.
- Prefix shell commands with `rtk`.
- Use `apply_patch` for file edits.
- Keep README operational and copy-pasteable.
- Update the real extension template and README together for persistent behavior changes.
- Mention `/reload` or restart after extension/config changes.
- Do not hardcode credentials or machine-specific session data.

## Decisions

- Scope is P0 trustworthiness only.
- Use a coordinator state machine split into `state.ts`, `evaluation.ts`, and `storage.ts`; retain `index.ts` as the Pi adapter.
- Record at `agent_end` and decide/dispatch at `agent_settled`.
- Budgets and activation are human-owned.
- Terminal model updates are proposals requiring coordinator policy.
- Use correlated structured decision records rather than unscoped markers.
- Use per-project atomic state, optimistic revisions, audit logs, and session leases.
- Work in the existing checkout on branch `feat/goal-loop-p0-hardening`, matching the user's request to check out a new branch.
- Rejected a minimal monolith patch because it preserves coupling and weak lifecycle testability.
- Deferred direct subagent RPC because it adds dependency/API scope beyond P0.

## Research

- Installed Pi is `0.80.6`.
- Installed Pi docs define `agent_end` as a low-level run boundary and `agent_settled` as the point where no automatic retry, compaction retry, or queued continuation remains.
- `ExtensionContext` exposes `ctx.hasPendingMessages()` and `ctx.sessionManager.getSessionId()`.
- Official Codex goal guidance emphasizes explicit stopping conditions, verification artifacts, checkpoints, and progress logs: <https://learn.chatgpt.com/codex/use-cases/follow-goals>.
- Official Claude `/goal` uses a separate evaluator after each turn through a session-scoped Stop hook: <https://code.claude.com/docs/en/goal>.
- Implementation impact: coordinator decisions must be lifecycle-safe, correlated to the current run, and backed by inspectable evidence rather than worker claims.

## Plan

- [x] Review implementation from runtime, product, and external-pattern perspectives.
- [x] Agree on P0-only scope.
- [x] Approve coordinator architecture.
- [x] Approve data, error, and testing semantics.
- [x] Create feature branch.
- [x] Write and self-review design spec.
- [x] Obtain user approval of the written spec.
- [x] Write and self-review implementation plan.
- [x] Implement coordinator state, strict decision parsing, and per-project storage with red-green-refactor tests.
- [x] Update README and extension compatibility metadata.
- [x] Run targeted and complete extension tests.
- [x] Refresh verification and handoff.

## Key Areas

- `pi/extensions/goal-loop/index.ts`
- `pi/extensions/goal-loop/index.test.ts`
- `pi/extensions/goal-loop/README.md`
- `docs/superpowers/specs/2026-07-12-goal-loop-p0-hardening-design.md`
- Installed Pi lifecycle documentation under `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

## Verification

- Baseline before changes: `node --test pi/extensions/goal-loop/index.test.ts` passed 18/18.
- Branch creation: `feat/goal-loop-p0-hardening` created from clean `advisor-model` state aligned with `origin/main` at review time.
- Design/spec self-review separated `goalRevision` from optimistic-concurrency `storageRevision` and clarified how model terminal proposals are stored without changing authoritative status.
- Implementation-plan self-review confirmed coverage for authority, leases, structured decisions, storage migration/corruption, settled lifecycle, documentation, and final verification. No placeholder steps remain.
- Final extension suite: `node --test pi/extensions/goal-loop/*.test.ts` passed after adding state, parser, storage, and adapter coverage.

## Open Questions And Risks

- Exact Pi tool-call message shapes must be represented faithfully in lifecycle tests.
- Audit logging can fail after atomic state commit; design intentionally keeps committed state and surfaces the log failure.
- Prompt-mediated evaluator availability remains a limitation; direct RPC is explicitly deferred.
- The four-hour lease expiry is a safety/recovery tradeoff and must be tested deterministically with injected time.

## Handoff

Review the final diff, then either commit the branch or open a draft PR. Recopy `pi/extensions/goal-loop` into `~/.pi/agent/extensions/` and run `/reload` before manual Pi smoke testing.
