# Goal Loop P0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Pi goal loop so lifecycle continuation, budgets, terminal decisions, persistence, and concurrent-session ownership are enforced by runtime state rather than model-authored prose.

**Architecture:** Split pure goal transitions, structured decision parsing, and atomic storage into `state.ts`, `evaluation.ts`, and `storage.ts`; keep `index.ts` as the Pi adapter. `agent_end` records a candidate only, while `agent_settled` performs one authoritative transition and optionally dispatches the next identified run.

**Tech Stack:** TypeScript ESM, Node.js built-ins, Pi extension API `0.80.4+`, Node test runner, JSON state, JSONL audit logs.

## Global Constraints

- Scope is P0 hardening only; do not add richer goal contracts, new commands, scheduling, direct verifier RPC, or self-evolution.
- Require Pi `>=0.80.4`; never fall back to continuation dispatch from `agent_end`.
- Keep `/goal` start, status, pause, resume, clear, edit, and verify behavior available.
- Keep model-created goals disabled by default.
- Keep budget increases, activation, pause, resume, edit, and clear human-owned.
- Use test-first red-green-refactor for every behavior change.
- Use `rtk` for shell commands and `apply_patch` for edits.
- Update README and mention `/reload` or Pi restart.

---

### Task 1: Pure schema, authority, lease, and pending-run state machine

**Files:**
- Create: `pi/extensions/goal-loop/state.ts`
- Create: `pi/extensions/goal-loop/state.test.ts`
- Modify: `pi/extensions/goal-loop/index.ts`

**Interfaces:**
- Produces: `GoalState`, `GoalLease`, `PendingGoalRun`, `GoalRunCandidate`, `GoalEvidence`, `GoalEvaluation`.
- Produces: `createGoal`, `normalizeGoalState`, `recordEvidence`, `acquireGoalLease`, `renewGoalLease`, `releaseGoalLease`, `createPendingRun`, `recordRunCandidate`, `settlePendingRun`, `resumeGoal`, `shouldAutoContinue`, and `editGoalObjective`.
- Consumes: injected `Date` and optional IDs so tests remain deterministic.

- [ ] **Step 1: Write failing schema and human-authority tests**

Add tests that require schema version 2, separate goal/storage revisions, and objective-edit invalidation:

```ts
test("createGoal creates versioned coordinator state", () => {
  const goal = createGoal("/repo/app", "Make tests pass", NOW, "goal-1");
  assert.equal(goal.schemaVersion, 2);
  assert.equal(goal.goalId, "goal-1");
  assert.equal(goal.goalRevision, 1);
  assert.equal(goal.storageRevision, 0);
  assert.equal(goal.pendingRun, undefined);
  assert.equal(goal.lease, undefined);
});

test("editGoalObjective invalidates proof and pending work", () => {
  const goal = {
    ...createGoal("/repo/app", "Old objective", NOW, "goal-1"),
    turns: 4,
    evidence: [{
      at: NOW.toISOString(),
      kind: "verification" as const,
      summary: "passed",
      command: "npm test",
      outcome: "passed" as const,
      goalRevision: 1,
      runId: "run-old",
    }],
    verification: { commands: ["npm test"], lastResult: "passed: passed" },
  };
  const edited = editGoalObjective(goal, "New objective", LATER);
  assert.equal(edited.goalRevision, 2);
  assert.equal(edited.turns, 0);
  assert.deepEqual(edited.evidence, []);
  assert.deepEqual(edited.verification.commands, ["npm test"]);
  assert.equal(edited.verification.lastResult, undefined);
});
```

- [ ] **Step 2: Run the schema tests and verify RED**

Run:

```bash
node --test pi/extensions/goal-loop/state.test.ts
```

Expected: FAIL because `state.ts` and the exported helpers do not exist.

- [ ] **Step 3: Implement schema types, creation, normalization, and objective editing**

Create the module with explicit versioned types and deterministic ID injection:

```ts
import { randomUUID } from "node:crypto";

export const GOAL_SCHEMA_VERSION = 2 as const;
export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS = 3;
export const GOAL_LEASE_MS = 4 * 60 * 60 * 1000;

export function createGoal(
  projectRoot: string,
  objective: string,
  now = new Date(),
  goalId = randomUUID(),
): GoalState {
  const timestamp = now.toISOString();
  return {
    schemaVersion: GOAL_SCHEMA_VERSION,
    goalId,
    goalRevision: 1,
    storageRevision: 0,
    projectRoot,
    objective,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: 0,
    maxTurns: DEFAULT_MAX_TURNS,
    maxFailedVerificationAttempts: DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS,
    consecutiveFailedVerificationAttempts: 0,
    verification: { commands: [] },
    evidence: [],
  };
}

export function editGoalObjective(goal: GoalState, objective: string, now = new Date()): GoalState {
  return {
    ...goal,
    objective,
    goalRevision: goal.goalRevision + 1,
    status: "active",
    turns: 0,
    consecutiveFailedVerificationAttempts: 0,
    lastEvaluation: undefined,
    pendingRun: undefined,
    evidence: [],
    verification: { commands: [...goal.verification.commands] },
    updatedAt: now.toISOString(),
  };
}
```

- [ ] **Step 4: Run schema tests and verify GREEN**

Run `node --test pi/extensions/goal-loop/state.test.ts`.

Expected: schema and edit tests PASS.

- [ ] **Step 5: Write failing lease tests**

Cover acquisition, renewal, conflict, expiry reclamation, and owner-only release:

```ts
test("a fresh lease cannot be stolen by another session", () => {
  const goal = createGoal("/repo", "Ship", NOW, "goal-1");
  const owned = acquireGoalLease(goal, "session-a", NOW);
  assert.equal(owned.ok, true);
  const conflict = acquireGoalLease(owned.goal, "session-b", LATER);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ownerSessionId, "session-a");
});

test("an expired lease can be reclaimed", () => {
  const goal = createGoal("/repo", "Ship", NOW, "goal-1");
  const owned = acquireGoalLease(goal, "session-a", NOW);
  const afterExpiry = new Date(NOW.getTime() + GOAL_LEASE_MS + 1);
  const reclaimed = acquireGoalLease(owned.goal, "session-b", afterExpiry);
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.goal.lease?.sessionId, "session-b");
});
```

- [ ] **Step 6: Run lease tests and verify RED**

Expected: FAIL because lease helpers do not exist.

- [ ] **Step 7: Implement lease transitions**

Use a discriminated result and ISO timestamps:

```ts
export type LeaseResult =
  | { ok: true; goal: GoalState }
  | { ok: false; goal: GoalState; ownerSessionId: string; expiresAt: string };

export function acquireGoalLease(goal: GoalState, sessionId: string, now = new Date()): LeaseResult {
  const existing = goal.lease;
  if (existing && existing.sessionId !== sessionId && Date.parse(existing.expiresAt) > now.getTime()) {
    return { ok: false, goal, ownerSessionId: existing.sessionId, expiresAt: existing.expiresAt };
  }
  const acquiredAt = existing?.sessionId === sessionId ? existing.acquiredAt : now.toISOString();
  return {
    ok: true,
    goal: {
      ...goal,
      lease: {
        sessionId,
        acquiredAt,
        renewedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + GOAL_LEASE_MS).toISOString(),
      },
      updatedAt: now.toISOString(),
    },
  };
}
```

Implement renewal as owner-only acquisition and release as a no-op for non-owners.

- [ ] **Step 8: Run lease tests and verify GREEN**

Run the complete `state.test.ts`; expected PASS.

- [ ] **Step 9: Write failing pending-run and settlement tests**

Require exactly-once candidate application, human-owned budgets, structured failure counting, and terminal policy:

```ts
test("settlement applies a continue candidate once", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" });
  goal = recordRunCandidate(goal, {
    protocol: "valid",
    worker: decision("continue"),
  }, LATER);
  const settled = settlePendingRun(goal, LATER);
  assert.equal(settled.action, "dispatch");
  assert.equal(settled.goal.turns, 1);
  assert.equal(settled.goal.pendingRun, undefined);
  assert.equal(settlePendingRun(settled.goal, LATER).action, "none");
});

test("completion requires high-confidence evaluator and fresh passing evidence", () => {
  const goal = goalWithPendingCompletion({ evaluatorConfidence: "medium", passed: true });
  const settled = settlePendingRun(goal, LATER);
  assert.equal(settled.goal.status, "active");
  assert.equal(settled.action, "dispatch");
});

test("structured failed verification evidence increments failure count", () => {
  const goal = recordEvidence(createGoal("/repo", "Ship", NOW, "goal-1"), {
    kind: "verification",
    summary: "npm test exited 1",
    command: "npm test",
    outcome: "failed",
    goalRevision: 1,
    runId: "run-1",
  }, LATER);
  assert.equal(goal.consecutiveFailedVerificationAttempts, 1);
});
```

- [ ] **Step 10: Run settlement tests and verify RED**

Expected: FAIL because pending-run, evidence, and settlement helpers are absent.

- [ ] **Step 11: Implement minimal pending-run, evidence, and settlement transitions**

Implement `createPendingRun` so only the lease owner can dispatch, `recordRunCandidate` so IDs must match, and `settlePendingRun` with actions:

```ts
export type SettleAction = "none" | "dispatch" | "complete" | "blocked" | "needs_user";

export interface SettleResult {
  goal: GoalState;
  action: SettleAction;
  reason?: string;
}
```

Completion policy must use `goal.pendingRun.candidate.evaluator`, require `confidence === "high"`, and call a helper that checks one fresh passed evidence item per configured command for the current goal revision and run ID.

- [ ] **Step 12: Run state tests and verify GREEN**

Run `node --test pi/extensions/goal-loop/state.test.ts`.

Expected: all state tests PASS with no warnings.

- [ ] **Step 13: Move existing pure state exports out of `index.ts`**

Replace duplicated types/helpers in `index.ts` with imports and re-exports:

```ts
export {
  acquireGoalLease,
  createGoal,
  createPendingRun,
  editGoalObjective,
  normalizeGoalState,
  recordEvidence,
  recordRunCandidate,
  releaseGoalLease,
  resumeGoal,
  settlePendingRun,
  shouldAutoContinue,
} from "./state.ts";
```

Update existing tests to import pure helpers from `state.ts` where direct ownership is clearer.

- [ ] **Step 14: Run all current goal-loop tests**

Run:

```bash
node --test pi/extensions/goal-loop/*.test.ts
```

Expected: existing behavior-preservation tests plus new state tests PASS.

- [ ] **Step 15: Commit Task 1**

```bash
git add pi/extensions/goal-loop/state.ts pi/extensions/goal-loop/state.test.ts pi/extensions/goal-loop/index.ts pi/extensions/goal-loop/index.test.ts
git commit -m "refactor: add goal loop coordinator state"
```

---

### Task 2: Strict current-run decision correlation

**Files:**
- Create: `pi/extensions/goal-loop/evaluation.ts`
- Create: `pi/extensions/goal-loop/evaluation.test.ts`
- Modify: `pi/extensions/goal-loop/index.ts`
- Modify: `pi/extensions/goal-loop/index.test.ts`

**Interfaces:**
- Consumes: `PendingGoalRun` and `GoalDecisionRecord` from `state.ts`.
- Produces: `buildWorkerDecisionLine`, `buildEvaluatorInstructions`, `parseCurrentRunCandidate`.
- Produces: typed protocol results `valid`, `missing`, `malformed`, `stale`, `duplicate`, and `conflict`.

- [ ] **Step 1: Write failing strict-parser tests**

Cover valid JSON, missing records, duplicates, quoted examples, stale IDs, unrelated Agent results, and tool-call correlation:

```ts
test("parses one exact current-run worker decision", () => {
  const result = parseCurrentRunCandidate([
    assistant(`Done\nGOAL_WORKER_DECISION: ${JSON.stringify(workerDecision("continue"))}`),
  ], EXPECTED);
  assert.equal(result.protocol, "valid");
  assert.equal(result.worker?.decision, "continue");
});

test("rejects a stale decision instead of reusing it", () => {
  const stale = { ...workerDecision("complete"), runId: "run-old" };
  const result = parseCurrentRunCandidate([
    assistant(`GOAL_WORKER_DECISION: ${JSON.stringify(stale)}`),
  ], EXPECTED);
  assert.equal(result.protocol, "stale");
});

test("accepts only the evaluator tool result correlated to its Agent call", () => {
  const result = parseCurrentRunCandidate([
    assistantWithAgentCall("call-1", "Evaluate goal status", "eval-1"),
    agentResult("call-1", evaluatorDecision("complete", "high")),
    assistant(`GOAL_WORKER_DECISION: ${JSON.stringify(workerDecision("complete"))}`),
  ], EXPECTED);
  assert.equal(result.protocol, "valid");
  assert.equal(result.evaluator?.decision, "complete");
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run `node --test pi/extensions/goal-loop/evaluation.test.ts`.

Expected: FAIL because the evaluation module is absent.

- [ ] **Step 3: Implement strict line and JSON validation**

Use anchored prefixes and explicit property validation:

```ts
const WORKER_PREFIX = "GOAL_WORKER_DECISION: ";
const EVALUATOR_PREFIX = "GOAL_EVALUATOR_DECISION: ";

function matchingLines(text: string, prefix: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.startsWith(prefix));
}

function matchesExpected(record: GoalDecisionRecord, expected: ExpectedDecisionIds): boolean {
  return record.goalId === expected.goalId
    && record.goalRevision === expected.goalRevision
    && record.runId === expected.runId
    && record.evaluationRequestId === expected.evaluationRequestId;
}
```

Validate decisions and confidence using exact allowlists. Reject arrays, `null`, unknown decision values, non-integer revisions, empty reasons, and extra matching records.

- [ ] **Step 4: Implement Agent call/result correlation**

Scan only the messages supplied for the current low-level run. Find an assistant tool-call part where:

```ts
part.type === "toolCall"
&& part.name === "Agent"
&& part.arguments?.description === "Evaluate goal status"
&& String(part.arguments?.prompt).includes(expected.evaluationRequestId)
```

Then accept only the `toolResult` with the same `toolCallId`. Do not scan earlier turns or accept arbitrary `Agent` output.

- [ ] **Step 5: Run parser tests and verify GREEN**

Run the evaluation tests; expected PASS.

- [ ] **Step 6: Replace legacy marker prompts and parsers**

Update prompts to include the exact current IDs and JSON examples generated by helpers. Remove `parseEvaluationFromText`, `getGoalEvaluationText`, and the unanchored `GOAL_STATUS`/`GOAL_EVAL_STATUS` protocol.

- [ ] **Step 7: Run the full test set**

Run `node --test pi/extensions/goal-loop/*.test.ts`.

Expected: all tests PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add pi/extensions/goal-loop/evaluation.ts pi/extensions/goal-loop/evaluation.test.ts pi/extensions/goal-loop/index.ts pi/extensions/goal-loop/index.test.ts
git commit -m "feat: correlate goal loop decisions to current runs"
```

---

### Task 3: Atomic per-project storage, migration, audit logs, and conflicts

**Files:**
- Create: `pi/extensions/goal-loop/storage.ts`
- Create: `pi/extensions/goal-loop/storage.test.ts`
- Modify: `pi/extensions/goal-loop/index.ts`

**Interfaces:**
- Consumes: `GoalState` and `normalizeGoalState` from `state.ts`.
- Produces: `GoalStorage`, `GoalStorageConflictError`, `GoalStorageCorruptError`, and `createGoalStorage`.
- `GoalStorage` methods: `read(projectRoot)`, `write(goal, expectedStorageRevision, event)`, `clear(projectRoot, expectedStorageRevision, event)`, and `appendAudit(projectRoot, event)`.

- [ ] **Step 1: Write failing atomic-write and optimistic-conflict tests**

Use `mkdtempSync` and injected storage roots:

```ts
test("write atomically replaces one project state and increments storage revision", () => {
  const storage = createTestStorage();
  const goal = createGoal("/repo/app", "Ship", NOW, "goal-1");
  const written = storage.write(goal, 0, { type: "goal_created", at: NOW.toISOString() });
  assert.equal(written.storageRevision, 1);
  assert.equal(storage.read("/repo/app")?.goalId, "goal-1");
  assert.deepEqual(storage.listTemporaryFiles(), []);
});

test("write rejects a stale storage revision", () => {
  const storage = createTestStorage();
  const goal = storage.write(createGoal("/repo", "Ship", NOW, "goal-1"), 0, event("created"));
  assert.throws(
    () => storage.write({ ...goal, objective: "stale" }, 0, event("updated")),
    GoalStorageConflictError,
  );
});
```

- [ ] **Step 2: Run storage tests and verify RED**

Expected: FAIL because `storage.ts` does not exist.

- [ ] **Step 3: Implement per-project paths and atomic writes**

Use `openSync`, `writeFileSync`, `fsyncSync`, `closeSync`, and `renameSync`; create files with mode `0o600`:

```ts
const tempPath = `${statePath}.${randomUUID()}.tmp`;
const fd = openSync(tempPath, "wx", 0o600);
try {
  writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fsyncSync(fd);
} finally {
  closeSync(fd);
}
renameSync(tempPath, statePath);
```

Increment `storageRevision` before serialization and compare the current file revision against `expectedStorageRevision` before writing.

- [ ] **Step 4: Run atomic-write tests and verify GREEN**

Run storage tests; expected PASS for write/conflict cases.

- [ ] **Step 5: Write failing migration, corruption, and audit tests**

```ts
test("read migrates one legacy project without modifying the legacy store", () => {
  const storage = createTestStorageWithLegacyGoal("/repo/app");
  const before = storage.readLegacyText();
  const migrated = storage.read("/repo/app");
  assert.equal(migrated?.schemaVersion, 2);
  assert.equal(migrated?.goalRevision, 1);
  assert.equal(storage.readLegacyText(), before);
  assert.match(storage.readAuditText("/repo/app"), /legacy_migrated/);
});

test("read quarantines corrupt project state", () => {
  const storage = createTestStorageWithCorruptState("/repo/app", "{not-json");
  assert.throws(() => storage.read("/repo/app"), GoalStorageCorruptError);
  assert.equal(storage.stateExists("/repo/app"), false);
  assert.equal(storage.corruptFiles().length, 1);
});
```

- [ ] **Step 6: Run migration/corruption tests and verify RED**

Expected: FAIL because migration, quarantine, and audit behavior are absent.

- [ ] **Step 7: Implement migration, quarantine, and JSONL audit append**

Legacy migration must read the current `state.json` shape by `goalKey(projectRoot)`, normalize it, write schema version 2, append `legacy_migrated`, and leave the legacy file untouched.

On JSON parse or validation failure, rename the state file into `corrupt/<project-key>-<timestamp>.json` and throw `GoalStorageCorruptError` containing the quarantine path.

Audit records must include `at`, `type`, `goalId`, `goalRevision`, `storageRevision`, `sessionId` when known, and a short reason.

- [ ] **Step 8: Run all storage tests and verify GREEN**

Run `node --test pi/extensions/goal-loop/storage.test.ts`; expected PASS.

- [ ] **Step 9: Replace global store helpers in `index.ts`**

Initialize production storage once:

```ts
const storage = createGoalStorage({
  rootDir: join(homedir(), ".pi", "agent", "goal-loop"),
  legacyStatePath: join(homedir(), ".pi", "agent", "goal-loop", "state.json"),
});
```

Route project reads/writes/clear operations through `GoalStorage`. Surface typed conflict/corruption errors through `ctx.ui.notify` and stop dispatch.

- [ ] **Step 10: Run all goal-loop tests**

Run `node --test pi/extensions/goal-loop/*.test.ts`; expected PASS.

- [ ] **Step 11: Commit Task 3**

```bash
git add pi/extensions/goal-loop/storage.ts pi/extensions/goal-loop/storage.test.ts pi/extensions/goal-loop/index.ts
git commit -m "feat: persist goal state atomically"
```

---

### Task 4: Human-owned tool authority and lease-aware commands

**Files:**
- Modify: `pi/extensions/goal-loop/index.ts`
- Modify: `pi/extensions/goal-loop/index.test.ts`

**Interfaces:**
- Consumes: state and storage modules from Tasks 1 and 3.
- Produces: updated `update_goal` schema with `proposedStatus` and without `status`/`maxTurns`.
- Produces: command handlers that acquire/release leases using `ctx.sessionManager.getSessionId()`.

- [ ] **Step 1: Write failing tool-authority tests**

```ts
test("update_goal cannot activate, pause, or change turn budgets", () => {
  const pi = fakePi();
  goalLoopExtension(pi.api);
  const tool = pi.tools.get("update_goal");
  assert.equal(tool.parameters.properties.status, undefined);
  assert.equal(tool.parameters.properties.maxTurns, undefined);
  assert.deepEqual(tool.parameters.properties.proposedStatus.enum, ["complete", "blocked", "needs_user"]);
});

test("proposedStatus records a pending-run proposal without changing goal status", async () => {
  const harness = await activeGoalHarness();
  await harness.updateGoal.execute({ proposedStatus: "complete", reason: "Tests pass" });
  const goal = harness.readGoal();
  assert.equal(goal.status, "active");
  assert.equal(goal.pendingRun?.toolProposal, "complete");
});
```

- [ ] **Step 2: Run authority tests and verify RED**

Expected: FAIL because `status` and `maxTurns` remain model-callable.

- [ ] **Step 3: Restrict the model tool**

Replace tool parameters with:

```ts
parameters: Schema.Object({
  proposedStatus: Schema.Optional(Schema.Enum(["complete", "blocked", "needs_user"] as const)),
  reason: Schema.Optional(Schema.String({ description: "Short reason for the terminal proposal." })),
  evidence: Schema.Optional(Schema.String({ description: "Evidence summary to append." })),
  evidenceKind: Schema.Optional(Schema.Enum(["note", "verification", "tool"] as const)),
  command: Schema.Optional(Schema.String({ description: "Command related to verification evidence." })),
  outcome: Schema.Optional(Schema.Enum(["passed", "failed", "unknown"] as const)),
  verificationCommand: Schema.Optional(Schema.String({ description: "Verification command to remember." })),
})
```

Reject `proposedStatus` when no current pending run belongs to the current session.

- [ ] **Step 4: Run authority tests and verify GREEN**

Run the targeted tests; expected PASS.

- [ ] **Step 5: Write failing lease-aware command tests**

Cover start/resume acquisition, fresh-lease conflict, expired reclaim, pause/clear release, shutdown release, and objective-edit invalidation.

- [ ] **Step 6: Run command tests and verify RED**

Expected: FAIL because commands are not lease-aware.

- [ ] **Step 7: Implement lease-aware human commands**

Use `ctx.sessionManager.getSessionId()`. Start may replace an existing goal only through the human command and acquires a lease. Resume reclaims only an expired or same-session lease. Pause, clear, and shutdown release same-session leases. Edit uses `editGoalObjective`, reacquires the current session lease, and dispatches a fresh run.

Conflict notification format:

```text
Goal is active in session 1234abcd until 2026-07-12T12:00:00.000Z. Pause it there or resume after the lease expires.
```

- [ ] **Step 8: Run command tests and verify GREEN**

Run `node --test pi/extensions/goal-loop/index.test.ts`; expected PASS.

- [ ] **Step 9: Commit Task 4**

```bash
git add pi/extensions/goal-loop/index.ts pi/extensions/goal-loop/index.test.ts
git commit -m "fix: keep goal loop authority human owned"
```

---

### Task 5: Settled lifecycle coordinator and exactly-once continuation

**Files:**
- Modify: `pi/extensions/goal-loop/index.ts`
- Modify: `pi/extensions/goal-loop/index.test.ts`

**Interfaces:**
- Consumes: `parseCurrentRunCandidate`, state settlement helpers, and `GoalStorage`.
- Produces: `agent_end` candidate recording and `agent_settled` authoritative settlement.
- Produces: continuation prompts carrying current goal/revision/run/evaluation IDs.

- [ ] **Step 1: Write failing lifecycle tests**

Use a fake extension API that captures registered handlers and sent messages:

```ts
test("agent_end records but never sends", async () => {
  const harness = await activeGoalHarness();
  await harness.handlers.agent_end({ messages: currentContinueMessages() }, harness.ctx);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.readGoal().pendingRun?.candidate?.worker?.decision, "continue");
});

test("agent_settled dispatches one next run", async () => {
  const harness = await candidateHarness("continue");
  await harness.handlers.agent_settled({}, harness.ctx);
  await harness.handlers.agent_settled({}, harness.ctx);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.readGoal().turns, 1);
});

test("pending user messages suppress autonomous dispatch", async () => {
  const harness = await candidateHarness("continue", { hasPendingMessages: true });
  await harness.handlers.agent_settled({}, harness.ctx);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.readGoal().pendingRun, undefined);
});
```

Also add tests for non-idle settlement, pause/clear between end and settled, storage conflict, abort/error, missing protocol, budget exhaustion, evaluator disagreement, and low-confidence completion.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Expected: FAIL because continuation still dispatches from `agent_end` and no `agent_settled` handler exists.

- [ ] **Step 3: Change `agent_end` to candidate recording only**

The handler must:

```ts
pi.on("agent_end", (event, ctx) => {
  const goal = storage.read(resolveProjectRoot(ctx));
  if (!isOwnedPendingRun(goal, ctx.sessionManager.getSessionId())) return;
  const candidate = parseCurrentRunCandidate(event.messages as unknown[], expectedIds(goal));
  const next = recordRunCandidate(goal, candidate, new Date());
  storage.write(next, goal.storageRevision, audit("run_candidate_recorded", ctx, candidate.protocol));
});
```

Do not call `sendUserMessage`, increment turns, or apply terminal status here.

- [ ] **Step 4: Add authoritative `agent_settled` handling**

The handler must re-read state and return unless:

```ts
ctx.isIdle()
&& !ctx.hasPendingMessages()
&& goal?.status === "active"
&& goal.lease?.sessionId === ctx.sessionManager.getSessionId()
&& goal.pendingRun?.candidate
```

Settle and persist before sending. For `dispatch`, acquire a fresh pending run with new IDs, persist it, then call `sendUserMessage` once. If messages are pending, clear the consumed pending run without dispatching and leave the active goal for the next user-driven turn.

- [ ] **Step 5: Update `before_agent_start` and continuation prompts**

Inject the current IDs and renew the lease only for the owning session. Ensure the final prompt instructs exact JSON output and tells the worker that `update_goal` terminal values are proposals only.

- [ ] **Step 6: Run lifecycle tests and verify GREEN**

Run `node --test pi/extensions/goal-loop/index.test.ts`; expected PASS.

- [ ] **Step 7: Run the complete goal-loop test suite**

Run `node --test pi/extensions/goal-loop/*.test.ts`; expected PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add pi/extensions/goal-loop/index.ts pi/extensions/goal-loop/index.test.ts
git commit -m "fix: continue goal loops only after settlement"
```

---

### Task 6: Operational documentation and compatibility cleanup

**Files:**
- Modify: `pi/extensions/goal-loop/README.md`
- Modify: `README.md`
- Modify: `pi/extensions/goal-loop/package.json`
- Modify: `docs/ai-workflow/2026-07-12-goal-loop-p0-hardening.md`

**Interfaces:**
- Documents the behavior produced by Tasks 1-5.
- Declares Pi compatibility without adding runtime dependencies.

- [ ] **Step 1: Write a failing documentation contract test**

Add a test that reads the extension README and asserts required operational claims:

```ts
test("README documents hardened lifecycle and storage requirements", () => {
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  assert.match(readme, /Pi >=0\.80\.4/);
  assert.match(readme, /agent_settled/);
  assert.match(readme, /human-owned/);
  assert.match(readme, /state\/<project-key>\.json/);
  assert.match(readme, /logs\/<project-key>\.jsonl/);
  assert.match(readme, /\/reload/);
});
```

- [ ] **Step 2: Run the documentation test and verify RED**

Expected: FAIL because README still documents the old marker and global-store behavior.

- [ ] **Step 3: Update extension documentation**

Replace legacy `GOAL_STATUS` examples with structured decision lines. Document human-owned budgets, proposed terminal status, lease conflict behavior, per-project atomic state, audit paths, legacy migration, corruption quarantine, and Pi `>=0.80.4`.

- [ ] **Step 4: Update repository setup documentation**

Keep installation instructions aligned with the local-copy convention. Mention that existing installs must recopy the template and run `/reload` or restart Pi.

- [ ] **Step 5: Add package engine metadata**

Update `package.json` without adding dependencies:

```json
{
  "name": "goal-loop-pi-extension",
  "private": true,
  "type": "module",
  "engines": {
    "pi": ">=0.80.4"
  }
}
```

- [ ] **Step 6: Run documentation and complete tests**

Run:

```bash
node --test pi/extensions/goal-loop/*.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Update workflow artifact**

Record completed tasks, commands/results, remaining risks, and set the first handoff action to the final verification command.

- [ ] **Step 8: Commit Task 6**

```bash
git add README.md pi/extensions/goal-loop/README.md pi/extensions/goal-loop/package.json pi/extensions/goal-loop/index.test.ts docs/ai-workflow/2026-07-12-goal-loop-p0-hardening.md
git commit -m "docs: document hardened goal loop"
```

---

### Task 7: Final regression and review gate

**Files:**
- Modify only if verification reveals a regression.

**Interfaces:**
- Validates every P0 requirement from the approved spec.

- [ ] **Step 1: Run the complete extension suite**

```bash
node --test pi/extensions/goal-loop/*.test.ts
```

Expected: all tests PASS, zero failures, zero warnings.

- [ ] **Step 2: Run syntax and whitespace checks**

```bash
git diff --check origin/main...HEAD
node --check pi/extensions/goal-loop/index.ts
node --check pi/extensions/goal-loop/state.ts
node --check pi/extensions/goal-loop/evaluation.ts
node --check pi/extensions/goal-loop/storage.ts
```

Expected: every command exits 0.

- [ ] **Step 3: Inspect the branch diff**

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- pi/extensions/goal-loop README.md docs/ai-workflow/2026-07-12-goal-loop-p0-hardening.md
```

Confirm that no P1-P3 features, secrets, generated artifacts, real state files, or machine-specific session IDs were added.

- [ ] **Step 4: Check spec coverage**

Verify each requirement in `docs/superpowers/specs/2026-07-12-goal-loop-p0-hardening-design.md` maps to a passing test or an explicit documented operational constraint.

- [ ] **Step 5: Refresh workflow artifact and status**

Set `Current Status` to `Done` only when all verification passes. Record exact test counts, diff check results, remaining prompt-mediated-verifier limitation, and `/reload` instructions.

- [ ] **Step 6: Review commit history and working tree**

```bash
git log --oneline origin/main..HEAD
git status --short --branch
```

Expected: intentional task commits and a clean working tree.
