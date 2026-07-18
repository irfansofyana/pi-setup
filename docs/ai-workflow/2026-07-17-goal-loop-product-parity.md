# Goal Loop Product-Parity Migration

## Goal

Close four user-facing gaps in the Pi goal-loop extension in one coordinated, backward-compatible migration:

1. bare `/goal` shows status;
2. completed goals auto-archive and remain inspectable as the latest achievement;
3. multiple goals are supported, while safe concurrent execution requires distinct Git worktrees with Pi launched from each worktree root;
4. `usage_limited` and `token_budget_limited` lifecycle states are explicit.

## Mode

Large/Risky

## Current Status

Done — implementation, two adjustment rounds, final independent review, full tests, strict typecheck, and diff validation all passed on `feat/goal-loop-p0-hardening`.

## Local Instructions

- `README.md` remains the setup source of truth.
- Keep the extension copyable to `~/.pi/agent/extensions/goal-loop`.
- Preserve Pi `>=0.80.4` lifecycle behavior and exactly-once settlement.
- Keep normalized Pi working-root scope as the default and model-created goals disabled by default.
- After extension changes, tell the user to run `/reload` or restart Pi.
- Never store secrets or provider credentials.

## Decisions

- Deliver all four gaps in one migration.
- Keep durable normalized-Pi-working-root scope; do not replace it with session-only state.
- Each normalized Pi working-root key keeps one active goal. Parallel safety requires distinct Git worktrees with Pi launched from each worktree root; `/goal list` exposes goals across stored root keys.
- A completed goal is copied idempotently to a per-root-key archive and removed from the active slot. With no active goal, bare `/goal` shows the latest archived achievement.
- Per-goal token budgets are opt-in through `/goal budget <tokens|off>`. Existing `maxTurns` remains the universal default bound.
- Assistant usage from the current autonomous run is accumulated from finalized run messages. A configured token budget produces `token_budget_limited` when another continuation would be required.
- A provider HTTP 429 that ultimately ends the current autonomous run produces `usage_limited`; any later observed non-429 response clears the limit flag for that attempt.
- A retained `complete` active receipt is immutable after archive/clear partial failure. Status, list, explicit clear, and replacement after confirmed idempotent archival are the only allowed actions.
- A queued non-marker user message revokes `update_goal` authority at `message_start`. The combined Pi run settles `needs_user`, excludes later follow-up usage, releases ownership, and never auto-dispatches.
- Evaluator correlation, high-confidence completion, fresh verification evidence, human budget authority, leases, atomic persistence, and exactly-once settlement remain mandatory.

Rejected approaches:

- Session-only goals: loses durable repository outcome and verification history.
- Concurrent goals in one working tree: creates edit, verification, and settlement races.
- Auto-delete on completion: removes the completion receipt and auditability.
- Mandatory token cap: provider accounting differs and would be a breaking behavior change.

## Research

- Pi extension API exposes assistant `message.usage`, `after_provider_response` HTTP status/headers, `message_start`, session IDs, `ctx.cwd`, and settled lifecycle events.
- Installed Pi `agent-loop.js` drains follow-up messages inside the same low-level run and emits one combined `agent_end`; user `message_start` occurs before the follow-up model response.
- Installed Pi automatic retries may emit markerless low-level runs before one final `agent_settled`.
- Official Codex and Claude `/goal` implementations use bare `/goal` for status and expose richer completion/usage behavior.
- Implementation impact: token totals can be accumulated from finalized assistant messages; usage is sliced before the first non-marker user follow-up; HTTP response ordering controls the current 429 flag; concurrency is keyed by the normalized Pi working root rather than only session ID.

## Plan

- [x] Specify the backward-compatible state/storage contract.
- [x] Add state/storage tests for usage fields, limit transitions, archive behavior, and working-root listing.
- [x] Implement additive state fields/statuses and idempotent archive storage without replacing the existing active-state schema.
- [x] Add command/lifecycle tests for bare status, auto-archive/latest receipt, `/goal list`, token budgets, usage accounting, and provider 429 handling.
- [x] Implement command/lifecycle behavior and status formatting.
- [x] Harden retained-completion immutability after archive and clear failures.
- [x] Match Pi's combined queued-follow-up lifecycle and revoke tool authority at `message_start`.
- [x] Make every provider response authoritative for the current 429 flag.
- [x] Update extension and root documentation.
- [x] Run targeted tests, the full suite, strict temporary-copy typecheck including tests, and diff validation.
- [x] Obtain final independent reviewer approval (`REVIEWER_AGREEMENT: NO_ADJUSTMENTS_REQUIRED`).

## Key Areas

- `pi/extensions/goal-loop/state.ts`
- `pi/extensions/goal-loop/storage.ts`
- `pi/extensions/goal-loop/evaluation.ts`
- `pi/extensions/goal-loop/index.ts`
- `pi/extensions/goal-loop/*.test.ts`
- `pi/extensions/goal-loop/README.md`
- `README.md`

## Verification

- `node --test pi/extensions/goal-loop/index.test.ts`: 39 passed, 0 failed during implementation.
- `node --test --test-reporter=tap pi/extensions/goal-loop/*.test.ts`: 91 passed, 0 failed in final coordinator verification.
- Strict temporary-copy TypeScript 5.9.3 check against Pi 0.80.10, including every source and test file: passed with `strict`, `noEmit`, NodeNext resolution, and installed Pi API types (`skipLibCheck` only for installed dependency declarations).
- `git diff --check`: passed with no output.
- Final independent reviewer: `REVIEWER_AGREEMENT: NO_ADJUSTMENTS_REQUIRED`.

The suite explicitly covers migration, archive idempotency/conflicts, immutable retained receipts after archive/clear failures, start refusal when archival cannot be confirmed, lease ownership/recovery, duplicate settlement, markerless retry, realistic combined queued follow-up interruption, autonomous-only usage slicing, provider sequences `429→500`, `429→401`, terminal `429`, `429→2xx`, token budgets, and normalized-root concurrency.

## Open Questions And Risks

- Full provider-backed and interactive queue smoke tests still require credentials and a live Pi session; the regression harness mirrors the installed `message_start`/combined-`agent_end` source lifecycle.
- Interruption identity is process-local until `agent_end` records the durable fail-safe candidate. A process crash in that window falls back to the existing lease-expiry `needs_user` recovery.
- Providers may omit usage or report provider-specific token categories; missing usage must not falsely exhaust a budget.
- The active-state schema remains version 2 with additive optional fields; strict storage validation and normalization accept old files.
- Existing path normalization is not Git-root discovery or filesystem realpath resolution. Subdirectory launches and symlink spellings become distinct keys, so parallel safety still requires distinct Git worktree roots.
- Prompt-mediated independent evaluator availability remains a limitation; direct evaluator RPC is outside this migration.
- Explicit `/goal clear` intentionally removes a retained completion receipt. Starting a replacement instead requires successful, content-matching idempotent archival first.

## Handoff

Implementation is complete and independently approved. Next action: inspect and commit the uncommitted diff if desired, then copy `pi/extensions/goal-loop` into the real Pi extension location and run `/reload` or restart Pi before credential-backed/manual smoke testing.
