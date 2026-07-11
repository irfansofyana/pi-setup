# Goal Loop P0 Hardening Design

## Objective

Make the Pi goal-loop extension safe enough for unattended, bounded execution by moving lifecycle authority from model-authored prose into a coordinator-owned state machine.

This branch intentionally excludes richer goal contracts, new history/inspection commands, scheduled execution, direct subagent RPC, and the evolve loop.

## Requirements

- Require Pi `>=0.80.4`, where `agent_settled` is available.
- Record low-level run results at `agent_end`; never dispatch a continuation there.
- Decide terminal transitions or dispatch exactly once at `agent_settled`.
- Never dispatch while Pi is non-idle or `ctx.hasPendingMessages()` is true.
- Keep turn-budget increases, activation, pause, and resume human-owned.
- Treat model terminal updates as proposals rather than authoritative state changes.
- Accept evaluator output only for the current goal revision, run, and evaluation request.
- Require high-confidence evaluator approval for completion.
- When explicit verification commands exist, require fresh passed verification evidence before completion.
- Persist each project independently with atomic replacement and an append-only audit log.
- Prevent concurrent sessions from driving the same goal with a renewable session lease.
- Migrate existing `state.json` goal entries without deleting or rewriting the legacy file.
- Fail safe on missing, malformed, stale, duplicate, or contradictory decision output.
- Preserve the existing `/goal` start, status, pause, resume, clear, edit, and verify commands.
- Preserve the existing default of disabling model-created goals.

## Architecture

The extension is split into four units:

- `state.ts`: goal types, normalization, pure state transitions, budget authority, lease rules, pending-run rules, and settled decisions.
- `evaluation.ts`: strict structured decision schema and extraction from the current run's messages.
- `storage.ts`: per-project atomic state files, legacy migration, corruption quarantine, and JSONL audit records.
- `index.ts`: Pi commands, tools, prompt construction, status display, and lifecycle adapter.

`index.ts` remains the extension entry point. It delegates decisions to pure helpers so lifecycle behavior can be tested without starting Pi.

## Goal State

The persisted state adds coordinator metadata while retaining existing user-visible fields:

```ts
interface GoalState {
  schemaVersion: 2;
  goalId: string;
  goalRevision: number;
  storageRevision: number;
  projectRoot: string;
  objective: string;
  status: "active" | "paused" | "complete" | "blocked" | "needs_user";
  createdAt: string;
  updatedAt: string;
  turns: number;
  maxTurns: number;
  maxFailedVerificationAttempts: number;
  consecutiveFailedVerificationAttempts: number;
  verification: {
    commands: string[];
    lastResult?: string;
  };
  evidence: GoalEvidence[];
  lastEvaluation?: GoalEvaluation;
  lease?: GoalLease;
  pendingRun?: PendingGoalRun;
}
```

Coordinator fields:

```ts
interface GoalLease {
  sessionId: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

interface PendingGoalRun {
  runId: string;
  evaluationRequestId: string;
  goalRevision: number;
  sessionId: string;
  dispatchedAt: string;
  toolProposal?: "complete" | "blocked" | "needs_user";
  candidate?: GoalRunCandidate;
}
```

Goal creation generates a random `goalId`. Objective edits increment `goalRevision`, clear pending-run and evaluator state, reset evidence/failure counters/turns, and retain human-configured verification commands. `storageRevision` increments on every persisted mutation and exists only for optimistic concurrency. This prevents old proof from completing a materially changed objective without conflating goal identity with storage writes.

## Structured Decisions

Worker and evaluator responses use exact, single-line JSON records:

```text
GOAL_WORKER_DECISION: {"goalId":"...","goalRevision":1,"runId":"...","evaluationRequestId":"...","decision":"continue","reason":"..."}
GOAL_EVALUATOR_DECISION: {"goalId":"...","goalRevision":1,"runId":"...","evaluationRequestId":"...","decision":"continue","reason":"...","confidence":"high"}
```

The parser:

- anchors the prefix at the start of a line;
- requires exactly one worker record;
- permits at most one matching evaluator record;
- rejects invalid JSON or unknown fields/types;
- rejects mismatched goal, revision, run, or evaluation-request IDs;
- ignores evaluator records from unrelated `Agent` calls;
- never searches earlier turns for a usable decision;
- returns a protocol error instead of defaulting to `continue`.

Evaluator selection matches a current-run `Agent` tool call to its `toolResult` by tool-call ID. The call must use the evaluator description and contain the current `evaluationRequestId`. The worker's final assistant message remains the source of the worker decision.

## Authority Rules

Human commands may:

- create, replace, edit, pause, resume, or clear a goal;
- add verification commands;
- extend the budget through resume behavior.

Model tools may:

- read goal state;
- append evidence;
- add a verification command;
- propose `complete`, `blocked`, or `needs_user`.

Model tools may not:

- set `active` or `paused`;
- increase or replace `maxTurns`;
- persist a terminal status directly;
- acquire or transfer a session lease.

`update_goal` therefore replaces authoritative `status` with optional `proposedStatus` limited to `complete`, `blocked`, and `needs_user`. A proposal is stored only on the matching current `pendingRun`; it never changes `GoalState.status`. The final structured worker decision must agree with a stored tool proposal when one exists, or settlement fails safe to `needs_user`. Backward compatibility is intentionally not retained for model-authored `status`, because retaining it would preserve the completion bypass.

## Lifecycle

### Start and Resume

1. Resolve the current project and session IDs.
2. Refuse to dispatch when another unexpired session lease owns the goal.
3. Acquire or renew the lease.
4. Create one `pendingRun` with fresh run and evaluation-request IDs.
5. Atomically persist state and append an audit event.
6. Send the continuation prompt.

### Before Agent Start

If the current session owns an active goal, renew its lease and inject the current goal/revision/run IDs. A run without a matching pending-run record receives goal context but cannot produce an accepted autonomous continuation decision.

### Agent End

1. Read the active goal and matching pending run.
2. Ignore the event if the lease or session does not match.
3. Parse only current-run messages.
4. Store the candidate result on `pendingRun`.
5. Append an audit event.
6. Do not increment turns, change terminal status, or send a message.

### Agent Settled

1. Re-read state to avoid acting on stale in-memory data.
2. Require idle state, no pending user/follow-up messages, matching lease, and a matching candidate.
3. Apply the candidate once and clear the pending run.
4. For `continue`, increment the turn count once and either dispatch a new identified run or stop at the budget.
5. For terminal proposals, require the matching evaluator decision.
6. Persist the transition atomically before sending any continuation.

If user messages are pending, the extension does not enqueue behind them. It clears the completed pending run without dispatching; the next user-driven turn receives the active goal prompt and becomes the next opportunity to progress.

## Terminal Decision Policy

- `continue`: accepted without an evaluator when the worker record is valid.
- `complete`: requires a matching evaluator `complete`, `confidence: "high"`, and a fresh passing evidence entry for every configured verification command.
- `blocked`: requires a matching evaluator `blocked`; absent or invalid evaluator output becomes `needs_user`.
- `needs_user`: stops safely. A matching evaluator is preferred, but absence does not continue autonomously.
- evaluator `continue`: overrides a worker terminal proposal and becomes the reason for the next turn.
- evaluator disagreement between terminal states: becomes `needs_user`.
- missing/malformed protocol: becomes `needs_user`; it never spends another autonomous turn.
- aborted or errored assistant run: becomes `blocked` and does not retry automatically.

Evidence is fresh when it was recorded for the current goal revision and current run. Verification evidence stores `goalRevision` and `runId`; migrated legacy evidence is retained for display but is not completion-authorizing proof.

## Failure Counting

Repeated verification failures derive from structured evidence, not reason text. A failed verification record increments the counter. A passed verification record resets it. Notes and tool observations do not change it.

When the configured threshold is reached, the settled coordinator stops with `blocked`. It does not enqueue another run.

## Persistence

Paths:

```text
~/.pi/agent/goal-loop/state/<project-key>.json
~/.pi/agent/goal-loop/logs/<project-key>.jsonl
~/.pi/agent/goal-loop/corrupt/
```

State writes:

1. Validate and normalize the next state.
2. Write a same-directory temporary file with mode `0600`.
3. Flush and close it.
4. Rename it over the destination atomically.
5. Append a compact audit record after the state transition.

`storageRevision` increments on every persisted mutation. A write supplies the storage revision it read; storage rejects a conflicting revision instead of overwriting newer state.

On malformed state, move the file into `corrupt/` with a timestamp and return a typed corruption error. Never silently convert corruption into an empty store.

Legacy migration reads `~/.pi/agent/goal-loop/state.json` only when the per-project file does not exist. It normalizes that goal into schema version 2, writes the new file, records a migration event, and leaves the legacy file unchanged.

## Lease Policy

The lease uses `ctx.sessionManager.getSessionId()` and a four-hour expiry. The owning session renews it at lifecycle boundaries. Another session may inspect status but cannot dispatch or mutate autonomous lifecycle state while the lease is fresh.

`session_shutdown` releases a lease owned by that session. `/goal resume` may reclaim an expired lease. It does not steal a fresh lease; the user is shown the owning session ID prefix and expiry.

## Error Handling

- State conflict: reload and stop the current transition; never blindly retry a send.
- State corruption: notify the user with the quarantined file location and stop the goal loop.
- Append-log failure after a successful atomic state write: notify the user, keep the state, and do not roll back the already-committed transition.
- Send failure after a persisted pending run: retain the pending run and notify the user; resume may retry with a new run ID.
- Missing Pi `agent_settled`: document Pi `>=0.80.4` and do not fall back to unsafe `agent_end` dispatch.
- Lease conflict: read-only status remains available; mutation/dispatch is refused.

## Testing

Pure tests cover:

- authority rules;
- lease acquire, renew, conflict, expiry, and release;
- pending-run creation and exactly-once settlement;
- structured decision parsing and ID correlation;
- terminal evaluator policy;
- verification freshness and structured failure counting;
- objective revision invalidation;
- legacy normalization.

Storage tests use temporary directories and cover:

- atomic per-project writes;
- optimistic revision conflicts;
- legacy migration;
- corruption quarantine;
- audit-log append behavior.

Extension integration tests use a fake Pi API and cover:

- `agent_end` never dispatching;
- `agent_settled` dispatching once;
- queued user messages suppressing dispatch;
- pause/clear before settlement;
- stale evaluator output;
- direct model completion attempts;
- model budget/activation attempts;
- lease conflicts across sessions;
- abort/error stopping behavior.

Run:

```bash
node --test pi/extensions/goal-loop/*.test.ts
```

## Documentation

Update the extension README to describe:

- Pi `>=0.80.4`;
- coordinator-owned terminal transitions;
- structured decision records;
- human-owned budgets and activation;
- per-project state, audit logs, migration, and session leases;
- `/reload` or Pi restart after installation/configuration changes.

## Explicit Non-Goals

- Acceptance-criteria or constraints arrays.
- New `/goal history`, `/goal inspect`, `/goal approve`, or `/goal retry` commands.
- Scheduled or event-triggered goals.
- Direct verifier RPC spawning.
- Multiple executor lanes or worktrees.
- Token, cost, or wall-clock budgets.
- Automatic loop self-modification.
