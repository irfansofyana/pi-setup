# Pi Goal Loop Native-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pi `/goal` behave like the native Codex and Claude goal experience: start immediately, accept steering while running, evaluate every settled turn independently, expose useful status, and stop only on verified completion, a limit, or a genuine need for the user.

**Architecture:** Preserve the existing coordinator-owned state machine, atomic storage, leases, evidence ledger, usage accounting, and `agent_end`/`agent_settled` split. Add native-parity behavior in three focused seams: command validation/status in `index.ts`, durable steering transitions in `state.ts`, and coordinator-owned evaluator RPC in a new `evaluator.ts`. The Pi host remains responsible for execution and permissions; the evaluator observes evidence and returns a structured decision but never mutates goal state.

**Tech Stack:** TypeScript ESM, Node.js built-ins, Pi extension API `>=0.80.4`, `@tintinweb/pi-subagents` cross-extension RPC protocol v2, Node.js test runner, JSON state, JSONL audit logs.

## Global Constraints

- Preserve `/goal`, `/goal status`, `/goal list`, `/goal pause`, `/goal resume`, `/goal clear`, `/goal edit`, `/goal verify`, and `/goal budget`.
- Keep one durable active goal per canonical Pi working root; cross-client MCP work is outside this plan.
- Keep activation, replacement, pause/resume, objective edits, and budget changes human-owned by default.
- Preserve the four-hour session lease, optimistic storage revision, atomic archive, append-only audit log, corruption quarantine, provider-limit handling, and exactly-once settlement.
- `agent_end` may record run output and usage but must never dispatch another turn.
- `agent_settled` remains the only normal continuation/terminal settlement point.
- A user follow-up is durable steering context. It revokes authority from the interrupted run, increments the goal revision, invalidates old proof, and resumes only after the combined Pi run settles.
- Invoke a read-only evaluator after every valid worker run, matching Claude's separate-evaluator behavior. Evaluator unavailability or malformed output fails closed to `needs_user`.
- Completion still requires high-confidence evaluator approval and fresh passed verification evidence for the current goal revision and run.
- The evaluator must use the installed `Explore` subagent type, `inheritContext: false`, `isBackground: true`, `maxTurns: 2`, and the current working root as `cwd`.
- Do not execute verification commands directly from the extension; that would bypass Pi's normal tool permission surface.
- Use test-first red-green-refactor for every behavior change.
- Use `rtk` for shell commands and `apply_patch` for edits.
- Update both `pi/extensions/goal-loop/README.md` and the root `README.md`; tell users to copy the extension and run `/reload` or restart Pi.

---

## File map

- `pi/extensions/goal-loop/state.ts`: objective validation constants, durable steering state, normalization, steering transitions, evaluator-authoritative settlement.
- `pi/extensions/goal-loop/evaluation.ts`: worker marker parsing and reusable evaluator-record parsing.
- `pi/extensions/goal-loop/evaluator.ts`: Pi event-bus RPC client, evaluator prompt, timeout/failure handling.
- `pi/extensions/goal-loop/index.ts`: command aliases/status, lifecycle integration, evaluator orchestration, steering dispatch.
- `pi/extensions/goal-loop/state.test.ts`: steering and settlement policy tests.
- `pi/extensions/goal-loop/evaluation.test.ts`: exported evaluator-record parser tests.
- `pi/extensions/goal-loop/evaluator.test.ts`: fake event-bus RPC tests.
- `pi/extensions/goal-loop/index.test.ts`: command, steering, lifecycle, and direct-evaluator integration tests.
- `pi/extensions/goal-loop/README.md`: extension behavior and smoke test.
- `README.md`: setup source of truth.

---

### Task 1: Native command contract and status parity

**Files:**
- Modify: `pi/extensions/goal-loop/state.ts:1-165`
- Modify: `pi/extensions/goal-loop/index.ts:63-135, 319-353, 565-850`
- Test: `pi/extensions/goal-loop/state.test.ts`
- Test: `pi/extensions/goal-loop/index.test.ts`

**Interfaces:**
- Produces: `MAX_GOAL_OBJECTIVE_CHARS`, `validateGoalObjective(objective: unknown): GoalObjectiveValidation`.
- Produces: clear aliases `stop`, `off`, `reset`, `none`, and `cancel` through `parseGoalArgs`.
- Produces: additive `GoalState.evaluatedRuns`; `turns` remains the continuation-budget counter.
- Consumes: existing `GoalState.createdAt`, `GoalState.updatedAt`, `GoalState.turns`, and `GoalUsage`.

- [ ] **Step 1: Write failing objective and alias tests**

Add to `state.test.ts`:

```ts
test("goal objective validation accepts 1..4000 trimmed characters", () => {
  assert.deepEqual(validateGoalObjective(" ship "), { ok: true, objective: "ship" });
  assert.deepEqual(validateGoalObjective("x".repeat(4000)), { ok: true, objective: "x".repeat(4000) });
  assert.deepEqual(validateGoalObjective("   "), { ok: false, reason: "Goal objective must not be empty." });
  assert.deepEqual(validateGoalObjective("x".repeat(4001)), {
    ok: false,
    reason: "Goal objective must be 4,000 characters or fewer.",
  });
});

test("new and legacy goals expose an evaluated-run counter", () => {
  assert.equal(createGoal("/repo", "Ship", NOW, "goal-1").evaluatedRuns, 0);
  assert.equal(normalizeGoalState({
    ...createGoal("/repo", "Ship", NOW, "goal-1"),
    evaluatedRuns: undefined,
    turns: 3,
  }).evaluatedRuns, 3);
});
```

Add to `index.test.ts`:

```ts
test("parseGoalArgs supports native clear aliases", () => {
  for (const alias of ["stop", "off", "reset", "none", "cancel"]) {
    assert.deepEqual(parseGoalArgs(alias), { command: "clear", value: "" });
  }
});

test("start and edit reject objectives over 4000 characters", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("x".repeat(4001), harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd), undefined);
  assert.match(harness.notifications.at(-1)?.message ?? "", /4,000 characters or fewer/);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await harness.commands.get("goal").handler(`edit ${"x".repeat(4001)}`, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.objective, "Ship safely");
  harness.cleanup();
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test pi/extensions/goal-loop/state.test.ts pi/extensions/goal-loop/index.test.ts
```

Expected: FAIL because `validateGoalObjective` and the alias mapping do not exist.

- [ ] **Step 3: Add one objective validator and alias normalization**

Add to `state.ts`:

```ts
export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export type GoalObjectiveValidation =
  | { ok: true; objective: string }
  | { ok: false; reason: string };

export function validateGoalObjective(objective: unknown): GoalObjectiveValidation {
  const normalized = typeof objective === "string" ? objective.trim() : "";
  if (!normalized) return { ok: false, reason: "Goal objective must not be empty." };
  if (normalized.length > MAX_GOAL_OBJECTIVE_CHARS) {
    return { ok: false, reason: "Goal objective must be 4,000 characters or fewer." };
  }
  return { ok: true, objective: normalized };
}
```

Update `index.ts` parsing before the command set lookup:

```ts
const CLEAR_ALIASES = new Set(["stop", "off", "reset", "none", "cancel"]);

export function parseGoalArgs(args: string): ParsedGoalArgs {
  const trimmed = args.trim();
  if (!trimmed) return { command: "status", value: "" };
  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (CLEAR_ALIASES.has(first) && rest.length === 0) return { command: "clear", value: "" };
  return COMMANDS.has(first as GoalCommand)
    ? { command: first as GoalCommand, value: rest.join(" ").trim() }
    : { command: "start", value: trimmed };
}
```

Call `validateGoalObjective` from `/goal` start, `/goal edit`, and optional `create_goal`. Set the model tool schema to `maxLength: MAX_GOAL_OBJECTIVE_CHARS`. Return or notify the validator's exact `reason` on failure.

Add `evaluatedRuns: number` to `GoalState`, initialize it to `0`, and normalize old version-2 states with `evaluatedRuns: goal.evaluatedRuns ?? goal.turns`. Keep `turns` unchanged because it enforces the continuation budget.

- [ ] **Step 4: Add status-duration tests and implementation**

Add an exported helper and test it directly:

```ts
test("formatGoalDuration uses compact stable units", () => {
  assert.equal(formatGoalDuration("2026-07-18T00:00:00.000Z", new Date("2026-07-18T00:02:05.000Z")), "2m 5s");
  assert.equal(formatGoalDuration("2026-07-18T00:00:00.000Z", new Date("2026-07-18T01:02:00.000Z")), "1h 2m");
});
```

Implement in `index.ts`:

```ts
export function formatGoalDuration(startedAt: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
```

Change `formatStatus` to accept `timestamp: Date` and include:

```ts
`Duration: ${formatGoalDuration(goal.createdAt, timestamp)}`,
`Evaluated runs: ${goal.evaluatedRuns}`,
```

Pass `now()` from command and tool handlers so tests remain deterministic.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --test pi/extensions/goal-loop/state.test.ts pi/extensions/goal-loop/index.test.ts
git diff --check
```

Expected: all focused tests PASS and `git diff --check` prints nothing.

Commit:

```bash
git add pi/extensions/goal-loop/state.ts pi/extensions/goal-loop/state.test.ts pi/extensions/goal-loop/index.ts pi/extensions/goal-loop/index.test.ts
git commit -m "feat(goal-loop): align command and status behavior"
```

---

### Task 2: Durable follow-up steering

**Files:**
- Modify: `pi/extensions/goal-loop/state.ts:63-150, 266-470, 986-1004`
- Modify: `pi/extensions/goal-loop/storage.ts:174-249`
- Modify: `pi/extensions/goal-loop/index.ts:239-317, 521-547, 871-1067`
- Test: `pi/extensions/goal-loop/state.test.ts`
- Test: `pi/extensions/goal-loop/storage.test.ts`
- Test: `pi/extensions/goal-loop/index.test.ts`

**Interfaces:**
- Produces: `GoalSteer`, `PendingGoalSteer`, `recordGoalSteer`, `consumeGoalSteer`.
- Consumes: `contentText`, `prepareDispatch`, current lease owner, state normalization, optimistic storage writes.
- Invariant: steering increments `goalRevision`, clears the interrupted pending run and stale proof, retains verification commands and lease ownership, and cannot itself mark a goal complete.

- [ ] **Step 1: Write failing pure steering tests**

Add to `state.test.ts`:

```ts
test("recordGoalSteer revisions the goal and invalidates interrupted proof", () => {
  const active = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW);
  assert.equal(active.ok, true);
  const pending = createPendingRun(active.goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" });
  assert.equal(pending.ok, true);
  const configured = {
    ...pending.goal,
    verification: { ...pending.goal.verification, commands: ["npm test"] },
  };
  const evidenced = recordEvidence(configured, {
    kind: "verification",
    summary: "old pass",
    command: "npm test",
    outcome: "passed",
    runId: "run-1",
  }, NOW);

  const steered = recordGoalSteer(evidenced, "session-a", "Keep the public API unchanged", LATER);
  assert.equal(steered.goalRevision, 2);
  assert.equal(steered.pendingRun, undefined);
  assert.deepEqual(steered.evidence, []);
  assert.deepEqual(steered.verification.proofs, []);
  assert.deepEqual(steered.verification.commands, ["npm test"]);
  assert.equal(steered.pendingSteer?.sessionId, "session-a");
  assert.equal(steered.steering.at(-1)?.text, "Keep the public API unchanged");
});

test("consumeGoalSteer clears only the owning session marker", () => {
  const goal = recordGoalSteer(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", "Use pnpm", LATER);
  assert.equal(consumeGoalSteer(goal, "session-b", LATER).pendingSteer?.sessionId, "session-a");
  assert.equal(consumeGoalSteer(goal, "session-a", LATER).pendingSteer, undefined);
});
```

- [ ] **Step 2: Run state tests and verify RED**

Run `node --test pi/extensions/goal-loop/state.test.ts`.

Expected: FAIL because steering types and transitions do not exist.

- [ ] **Step 3: Implement additive schema and transitions**

Add to `state.ts`:

```ts
export interface GoalSteer {
  at: string;
  text: string;
  goalRevision: number;
}

export interface PendingGoalSteer {
  sessionId: string;
  requestedAt: string;
}
```

Add `steering: GoalSteer[]` and `pendingSteer?: PendingGoalSteer` to `GoalState`; initialize `steering: []` in `createGoal`. Normalize absent legacy values to `[]`, accept at most the newest 20 valid entries, and validate `pendingSteer.sessionId`/`requestedAt` as non-empty strings.

Implement:

```ts
export function recordGoalSteer(goal: GoalState, sessionId: string, text: string, now = new Date()): GoalState {
  const normalized = text.trim();
  if (!normalized) return goal;
  const goalRevision = goal.goalRevision + 1;
  return {
    ...goal,
    goalRevision,
    status: "active",
    steering: [...goal.steering, { at: nowIso(now), text: normalized, goalRevision }].slice(-20),
    pendingSteer: { sessionId, requestedAt: nowIso(now) },
    pendingRun: undefined,
    lastEvaluation: undefined,
    limitDetail: undefined,
    consecutiveFailedVerificationAttempts: 0,
    evidence: [],
    verification: { commands: [...goal.verification.commands], proofs: [] },
    updatedAt: nowIso(now),
  };
}

export function consumeGoalSteer(goal: GoalState, sessionId: string, now = new Date()): GoalState {
  if (goal.pendingSteer?.sessionId !== sessionId) return goal;
  return { ...goal, pendingSteer: undefined, updatedAt: nowIso(now) };
}
```

Update strict storage validation to accept the two additive fields after normalization. No schema-version bump is needed because both fields are optional on disk and normalized for old version-2 states.

- [ ] **Step 4: Inject steering context into continuation prompts**

Add to both `buildContinuationPrompt` and `buildGoalSystemPrompt`:

```ts
const steering = goal.steering.length
  ? goal.steering.slice(-5).map((entry) => `- r${entry.goalRevision}: ${entry.text}`).join("\n")
  : "- No follow-up steering.";
```

Include a `Follow-up steering:` section after the objective. Do not concatenate steering into `objective`; the original completion condition remains inspectable.

- [ ] **Step 5: Write failing lifecycle steering test**

Add to `index.test.ts`:

```ts
test("queued user follow-up steers and resumes instead of stopping needs_user", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;

  await harness.handlers.get("before_agent_start")({
    prompt: harness.sent[0],
    systemPrompt: "base",
    systemPromptOptions: { cwd: harness.ctx.cwd },
  }, harness.ctx);
  await harness.handlers.get("message_start")({
    message: { role: "user", content: "Keep the public API unchanged" },
  }, harness.ctx);

  const steered = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(steered.goalRevision, initial.goalRevision + 1);
  assert.equal(steered.pendingRun, undefined);
  assert.equal(steered.pendingSteer?.sessionId, "session-a");

  await harness.handlers.get("agent_end")({ messages: [] }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const resumed = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(resumed.status, "active");
  assert.equal(resumed.pendingSteer, undefined);
  assert.ok(resumed.pendingRun);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1], /Keep the public API unchanged/);
  harness.cleanup();
});
```

- [ ] **Step 6: Replace interruption-to-needs-user with steering-to-resume**

In `message_start`, keep `clearContinuationAuthority()` and provider-limit clearing, then persist `recordGoalSteer` using `contentText(record.content)`. Remove the `autonomousInterruption` malformed-candidate path.

At the start of `agent_settled`, after reading/expiry checks and before `ownsFreshPendingRun`, handle an owned steer:

```ts
if (goal.status === "active" && goal.pendingSteer?.sessionId === owner) {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    notify(ctx, "Goal steering was saved; resume when Pi is idle.", "warning");
    return;
  }
  const consumed = consumeGoalSteer(goal, owner, timestamp);
  const prepared = prepareDispatch(consumed, owner, timestamp, randomId);
  if (!prepared.goal) {
    notify(ctx, `Goal steering could not resume: ${prepared.reason}`, "warning");
    return;
  }
  const persisted = persistGoal(storage, prepared.goal, auditEvent("goal_steered", "User steered the active goal.", ctx, timestamp), ctx);
  if (persisted) {
    status.sync(ctx);
    sendPrepared(pi, ctx, persisted);
  }
  return;
}
```

The interrupted run's later `agent_end` sees no `pendingRun` and therefore cannot settle stale authority.

- [ ] **Step 7: Run steering and storage tests, then commit**

Run:

```bash
node --test pi/extensions/goal-loop/state.test.ts pi/extensions/goal-loop/storage.test.ts pi/extensions/goal-loop/index.test.ts
git diff --check
```

Expected: all tests PASS; legacy version-2 fixtures normalize with `steering: []` and no `pendingSteer`.

Commit:

```bash
git add pi/extensions/goal-loop/state.ts pi/extensions/goal-loop/state.test.ts pi/extensions/goal-loop/storage.ts pi/extensions/goal-loop/storage.test.ts pi/extensions/goal-loop/index.ts pi/extensions/goal-loop/index.test.ts
git commit -m "feat(goal-loop): resume after durable user steering"
```

---

### Task 3: Coordinator-owned evaluator RPC

**Files:**
- Create: `pi/extensions/goal-loop/evaluator.ts`
- Create: `pi/extensions/goal-loop/evaluator.test.ts`
- Modify: `pi/extensions/goal-loop/evaluation.ts:18-162`
- Modify: `pi/extensions/goal-loop/evaluation.test.ts`

**Interfaces:**
- Produces: `parseEvaluatorDecision(text, expected)` in `evaluation.ts`.
- Produces: `GoalEvaluator`, `GoalEvaluatorInput`, `GoalEvaluatorResult`, `createSubagentGoalEvaluator(pi, options)` in `evaluator.ts`.
- Consumes: Pi `events.on/emit`, `subagents:ready`, `subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:completed`, and `subagents:failed`.

- [ ] **Step 1: Export and test standalone evaluator parsing**

Add to `evaluation.test.ts`:

```ts
test("parseEvaluatorDecision accepts one correlated exact record", () => {
  const text = `GOAL_EVALUATOR_DECISION: ${JSON.stringify({
    ...EXPECTED,
    decision: "continue",
    reason: "Tests have not run yet.",
    confidence: "high",
  })}`;
  assert.equal(parseEvaluatorDecision(text, EXPECTED).decision, "continue");
});

test("parseEvaluatorDecision rejects stale and duplicate records", () => {
  const record = `GOAL_EVALUATOR_DECISION: ${JSON.stringify({
    ...EXPECTED,
    runId: "old-run",
    decision: "continue",
    reason: "stale",
    confidence: "high",
  })}`;
  assert.throws(() => parseEvaluatorDecision(record, EXPECTED), /active goal run/);
  assert.throws(() => parseEvaluatorDecision(`${record}\n${record}`, EXPECTED), /exactly one/);
});
```

Export:

```ts
export function parseEvaluatorDecision(text: string, expected: CurrentRunIds): GoalDecisionRecord {
  const markers = markerPayloads(text, EVALUATOR_PREFIX);
  if (markers.malformed || markers.payloads.length !== 1) {
    throw new TypeError("Evaluator output must contain exactly one well-formed decision record.");
  }
  const record = parseRecord(markers.payloads[0], "evaluator");
  if (!record) throw new TypeError("Evaluator decision JSON does not match the required schema.");
  if (!matchesCurrentRun(record, expected)) throw new TypeError("Evaluator decision does not match the active goal run.");
  return record;
}
```

Reuse this helper from `parseCurrentRunCandidate` so there is one evaluator schema implementation.

- [ ] **Step 2: Write fake-event-bus evaluator tests**

Create `evaluator.test.ts` with this minimal bus and fixtures:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentGoalEvaluator, type GoalEvaluatorInput } from "./evaluator.ts";

const EXPECTED = {
  goalId: "goal-1",
  goalRevision: 1,
  runId: "run-1",
  evaluationRequestId: "eval-1",
};

function createFakeEventBus() {
  const listeners = new Map<string, Set<(value: any) => void>>();
  return {
    on(event: string, handler: (value: any) => void) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    },
    emit(event: string, value: any) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(value);
    },
  };
}

function evaluatorRecord(ids: typeof EXPECTED, decision: "complete" | "continue" | "blocked" | "needs_user", reason: string) {
  return `GOAL_EVALUATOR_DECISION: ${JSON.stringify({ ...ids, decision, reason, confidence: "high" })}`;
}

function evaluatorInput(ids: typeof EXPECTED): GoalEvaluatorInput {
  return {
    ...ids,
    objective: "Ship safely",
    steering: [],
    verificationCommands: ["npm test"],
    evidence: [],
    transcriptExcerpt: "[assistant] Work is still in progress.",
    worker: { ...ids, decision: "continue", reason: "working", confidence: "medium" },
    cwd: "/repo/app",
  };
}

test("subagent evaluator resolves a correlated completed result", async () => {
  const bus = createFakeEventBus();
  const evaluator = createSubagentGoalEvaluator({ events: bus } as any, { timeoutMs: 100 });
  bus.on("subagents:rpc:ping", ({ requestId }: any) => {
    bus.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });
  bus.on("subagents:rpc:spawn", ({ requestId }: any) => {
    bus.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: "agent-1" } });
    queueMicrotask(() => bus.emit("subagents:completed", {
      id: "agent-1",
      result: evaluatorRecord(EXPECTED, "continue", "More work remains."),
    }));
  });
  const result = await evaluator.evaluate(evaluatorInput(EXPECTED));
  assert.equal(result.ok, true);
  assert.equal(result.record.decision, "continue");
});

test("subagent evaluator fails closed when RPC is unavailable", async () => {
  const evaluator = createSubagentGoalEvaluator({ events: createFakeEventBus() } as any, { timeoutMs: 5 });
  assert.deepEqual(await evaluator.evaluate(evaluatorInput(EXPECTED)), {
    ok: false,
    reason: "Goal evaluator RPC did not respond.",
  });
});

test("subagent evaluator ignores completion from another agent", async () => {
  const bus = createFakeEventBus();
  const evaluator = createSubagentGoalEvaluator({ events: bus } as any, { timeoutMs: 5 });
  bus.on("subagents:rpc:ping", ({ requestId }: any) => {
    bus.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });
  bus.on("subagents:rpc:spawn", ({ requestId }: any) => {
    bus.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: "agent-1" } });
    queueMicrotask(() => bus.emit("subagents:completed", {
      id: "agent-2",
      result: evaluatorRecord(EXPECTED, "continue", "wrong agent"),
    }));
  });
  assert.deepEqual(await evaluator.evaluate(evaluatorInput(EXPECTED)), {
    ok: false,
    reason: "Goal evaluator timed out.",
  });
});
```

- [ ] **Step 3: Implement the evaluator RPC client**

Create `evaluator.ts` with these public types:

```ts
export interface GoalEvaluatorInput extends CurrentRunIds {
  objective: string;
  steering: string[];
  verificationCommands: string[];
  evidence: GoalEvidence[];
  transcriptExcerpt: string;
  worker: GoalDecisionRecord;
  cwd: string;
}

export type GoalEvaluatorResult =
  | { ok: true; record: GoalDecisionRecord }
  | { ok: false; reason: string };

export interface GoalEvaluator {
  evaluate(input: GoalEvaluatorInput): Promise<GoalEvaluatorResult>;
}
```

Implement a private `rpc(events, channel, payload, timeoutMs)` that registers the reply listener before `emit`, clears its timer/listener exactly once, and resolves the standardized `{ success, data?, error? }` envelope.

Build the evaluator prompt entirely from `GoalEvaluatorInput` and end it with:

```ts
`Return exactly one line: GOAL_EVALUATOR_DECISION: ${JSON.stringify({
  goalId: input.goalId,
  goalRevision: input.goalRevision,
  runId: input.runId,
  evaluationRequestId: input.evaluationRequestId,
  decision: "continue",
  reason: "one short sentence",
  confidence: "high",
})}`
```

The `evaluate` flow must:

1. Ping and require protocol version `>=2`.
2. Register `subagents:completed` and `subagents:failed` listeners before spawning.
3. Spawn with:

```ts
{
  type: "Explore",
  prompt,
  options: {
    description: "Evaluate goal status",
    isBackground: true,
    inheritContext: false,
    maxTurns: 2,
    cwd: input.cwd,
  },
}
```

4. Correlate completion by returned agent ID.
5. Parse `event.result` through `parseEvaluatorDecision`.
6. Return the exact fail-closed reasons used in tests for timeout, RPC failure, subagent failure, or malformed output.
7. Remove every reply/lifecycle listener and timer on every terminal path.

- [ ] **Step 4: Run evaluator unit tests and commit**

Run:

```bash
node --test pi/extensions/goal-loop/evaluation.test.ts pi/extensions/goal-loop/evaluator.test.ts
git diff --check
```

Expected: all evaluator tests PASS with no open timer handles.

Commit:

```bash
git add pi/extensions/goal-loop/evaluation.ts pi/extensions/goal-loop/evaluation.test.ts pi/extensions/goal-loop/evaluator.ts pi/extensions/goal-loop/evaluator.test.ts
git commit -m "feat(goal-loop): add coordinator-owned evaluator RPC"
```

---

### Task 4: Evaluate every settled run and make evaluator decisions authoritative

**Files:**
- Modify: `pi/extensions/goal-loop/state.ts:63-110, 332-411, 549-620, 643-980`
- Modify: `pi/extensions/goal-loop/storage.ts:174-249`
- Modify: `pi/extensions/goal-loop/index.ts:63-72, 194-229, 521-547, 944-1067`
- Test: `pi/extensions/goal-loop/state.test.ts`
- Test: `pi/extensions/goal-loop/storage.test.ts`
- Test: `pi/extensions/goal-loop/index.test.ts`

**Interfaces:**
- Consumes: `GoalEvaluator.evaluate`, `parseCurrentRunCandidate`, `recordRunCandidate`, `settlePendingRun`.
- Produces: `GoalLoopExtensionOptions.evaluator?: GoalEvaluator`, `recordRunEvaluationContext`, and `buildRunEvaluationContext`.
- Invariant: a valid worker record is necessary for correlation, but the separate evaluator decides `continue`, `complete`, `blocked`, or `needs_user`.

- [ ] **Step 1: Write failing evaluator-authority state tests**

Add to `state.test.ts`:

```ts
test("evaluator continue overrides a worker completion proposal", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordRunCandidate(goal, {
    protocol: "valid",
    worker: decision("complete"),
    evaluator: { ...decision("continue"), reason: "More work remains." },
  }, LATER);
  const settled = settlePendingRun(goal, LATER);
  assert.equal(settled.action, "dispatch");
  assert.equal(settled.goal.lastEvaluation?.reason, "More work remains.");
  assert.equal(settled.goal.evaluatedRuns, 1);
});

test("evaluator complete may finish a worker continue when fresh proof exists", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordEvidence(goal, {
    kind: "verification",
    summary: "npm test passed",
    command: "npm test",
    outcome: "passed",
    runId: "run-1",
  }, LATER);
  goal = recordRunCandidate(goal, {
    protocol: "valid",
    worker: decision("continue"),
    evaluator: { ...decision("complete"), reason: "All acceptance criteria hold." },
  }, LATER);
  const settled = settlePendingRun(goal, LATER);
  assert.equal(settled.action, "complete");
  assert.equal(settled.goal.evaluatedRuns, 1);
});
```

- [ ] **Step 2: Remove conflict settlement and make evaluator authoritative**

Change the three candidate helpers in `state.ts`:

```ts
function candidateDecision(candidate: GoalRunCandidate | undefined): GoalDecision | undefined {
  return candidate?.protocol === "valid" ? candidate.evaluator?.decision : undefined;
}

function candidateReason(candidate: GoalRunCandidate | undefined): string {
  if (!candidate) return "No candidate recorded.";
  if (candidate.protocol !== "valid") return candidate.reason;
  return candidate.evaluator?.reason ?? "Independent evaluator result is missing.";
}

function candidateConfidence(candidate: GoalRunCandidate | undefined): "low" | "medium" | "high" | undefined {
  return candidate?.protocol === "valid" ? candidate.evaluator?.confidence : undefined;
}
```

Delete the worker/evaluator conflict branch. Immediately after protocol validation, fail closed when `candidate.evaluator` is absent:

```ts
if (!candidate.evaluator) {
  return stopForNeedsUser(goal, "Independent evaluator result is missing.", now);
}
```

After that guard, create `const evaluatedGoal = { ...goal, evaluatedRuns: goal.evaluatedRuns + 1 }` and use `evaluatedGoal` as the base for every evaluator-decided `continue`, `complete`, `blocked`, and `needs_user` result. Incrementing inside settlement preserves exactly-once counting because every successful settlement clears `pendingRun`; provider errors and malformed/missing evaluator output do not count as evaluated runs.

Extract the repeated `needs_user` state shape into a private `stopForNeedsUser` helper in `state.ts`; preserve lease release, pending-run clearing, timestamp, and low-confidence receipt.

- [ ] **Step 3: Stop asking the worker to spawn its evaluator**

Remove `buildEvaluatorInstructions` from worker prompts. Replace it with:

```ts
"A separate coordinator-owned evaluator will inspect this run after it settles. Report progress honestly and emit only the worker decision record."
```

Keep the worker record because it carries correlated progress and lets the coordinator distinguish malformed/stale output from evaluator failure.

- [ ] **Step 4: Persist a bounded evaluator view of the settled run**

Add `evaluationContext?: string` to `PendingGoalRun`. Normalize it only when it is a string, retaining at most the last 32,000 characters. Add:

```ts
export function recordRunEvaluationContext(goal: GoalState, context: string, now = new Date()): GoalState {
  if (!goal.pendingRun) return goal;
  return {
    ...goal,
    pendingRun: { ...goal.pendingRun, evaluationContext: context.slice(-32_000) },
    updatedAt: nowIso(now),
  };
}
```

Update strict storage validation to accept the normalized optional field. In `index.ts`, add:

```ts
export function buildRunEvaluationContext(messages: unknown[]): string {
  return messages.flatMap((item) => {
    const record = messageRecord(item);
    if (record?.role !== "assistant" && record?.role !== "toolResult") return [];
    const text = contentText(record.content).trim();
    return text ? [`[${String(record.role)}] ${text}`] : [];
  }).join("\n\n").slice(-32_000);
}
```

In `agent_end`, call `recordRunEvaluationContext(updated, buildRunEvaluationContext(messages), timestamp)` before `recordRunCandidate`. This gives the evaluator the same surfaced run evidence that Claude's transcript-based evaluator receives without granting it lifecycle authority.

- [ ] **Step 5: Write failing lifecycle evaluator tests**

Change the harness signature from `function createHarness(session = "session-a")` to:

```ts
function createHarness(session = "session-a", evaluator?: GoalEvaluator) {
```

Replace the existing `createGoalLoopExtension` call inside that function with:

```ts
createGoalLoopExtension({
  storage,
  config: { allowModelCreateGoal: false },
  now: () => currentNow,
  randomId: () => `id-${++id}`,
  evaluator,
})(api as any);
```

Add this correlated test helper:

```ts
function evaluatorDecision(
  input: GoalEvaluatorInput,
  decision: "complete" | "continue" | "blocked" | "needs_user",
  reason: string,
) {
  return {
    goalId: input.goalId,
    goalRevision: input.goalRevision,
    runId: input.runId,
    evaluationRequestId: input.evaluationRequestId,
    decision,
    reason,
    confidence: "high" as const,
  };
}
```

Add these lifecycle tests:

```ts
test("agent_settled invokes evaluator for a worker continue and dispatches", async () => {
  const evaluatorCalls: GoalEvaluatorInput[] = [];
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      evaluatorCalls.push(input);
      return { ok: true, record: evaluatorDecision(input, "continue", "More work remains.") };
    },
  };
  const harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("before_agent_start")({
    prompt: harness.sent[0],
    systemPrompt: "base",
    systemPromptOptions: { cwd: harness.ctx.cwd },
  }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(evaluatorCalls.length, 1);
  assert.equal(evaluatorCalls[0].runId, initial.pendingRun!.runId);
  assert.match(evaluatorCalls[0].transcriptExcerpt, /GOAL_WORKER_DECISION/);
  assert.equal(harness.sent.length, 2);
  harness.cleanup();
});

test("evaluator failure stops needs_user without dispatch", async () => {
  const evaluator: GoalEvaluator = {
    async evaluate() {
      return { ok: false, reason: "Goal evaluator RPC did not respond." };
    },
  };
  const harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("before_agent_start")({
    prompt: harness.sent[0],
    systemPrompt: "base",
    systemPromptOptions: { cwd: harness.ctx.cwd },
  }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "needs_user");
  assert.equal(harness.sent.length, 1);
  harness.cleanup();
});
```

- [ ] **Step 6: Integrate evaluation into `agent_settled`**

Add `evaluator?: GoalEvaluator` to `GoalLoopExtensionOptions`. Construct the production default once in `registerGoalLoop`:

```ts
const evaluator = options.evaluator ?? createSubagentGoalEvaluator(pi, { timeoutMs: 120_000 });
```

After ownership checks and before `settlePendingRun`, require a valid worker candidate. Always call the coordinator-owned evaluator, replacing any legacy prompt-mediated evaluator record that the worker transcript happened to contain. Call:

```ts
const evaluation = await evaluator.evaluate({
  goalId: goal.goalId,
  goalRevision: goal.pendingRun.goalRevision,
  runId: goal.pendingRun.runId,
  evaluationRequestId: goal.pendingRun.evaluationRequestId,
  objective: goal.objective,
  steering: goal.steering.map((entry) => entry.text),
  verificationCommands: [...goal.verification.commands],
  evidence: [...goal.evidence],
  transcriptExcerpt: goal.pendingRun.evaluationContext ?? "",
  worker: goal.pendingRun.candidate.worker,
  cwd: projectRoot,
});
```

If evaluation fails, replace the candidate with `{ protocol: "malformed", reason: evaluation.reason }`. If it succeeds, attach `evaluator: evaluation.record` to the existing valid candidate. Persist an `evaluator_recorded` audit event, re-read the state, re-check goal/revision/run/lease correlation, then call `settlePendingRun`. This re-read prevents a user edit or pause during evaluator latency from settling stale work.

- [ ] **Step 7: Run lifecycle tests and commit**

Run:

```bash
node --test pi/extensions/goal-loop/state.test.ts pi/extensions/goal-loop/storage.test.ts pi/extensions/goal-loop/evaluation.test.ts pi/extensions/goal-loop/evaluator.test.ts pi/extensions/goal-loop/index.test.ts
git diff --check
```

Expected: evaluator runs once per settled autonomous run; stale evaluator completion cannot settle an edited, paused, cleared, or replaced goal.

Commit:

```bash
git add pi/extensions/goal-loop/state.ts pi/extensions/goal-loop/state.test.ts pi/extensions/goal-loop/storage.ts pi/extensions/goal-loop/storage.test.ts pi/extensions/goal-loop/index.ts pi/extensions/goal-loop/index.test.ts
git commit -m "feat(goal-loop): evaluate every settled run independently"
```

---

### Task 5: Documentation, compatibility regression, and live smoke checklist

**Files:**
- Modify: `pi/extensions/goal-loop/README.md`
- Modify: `README.md:623-681`
- Modify: `pi/extensions/goal-loop/index.test.ts`

**Interfaces:**
- Consumes: all user-visible commands and lifecycle behavior from Tasks 1-4.
- Produces: copyable setup instructions and a credential-backed manual verification checklist.

- [ ] **Step 1: Update README contract assertions first**

Extend the existing README test to require these exact concepts:

```ts
assert.match(readme, /4,000 characters/);
assert.match(readme, /stop.*off.*reset.*none.*cancel/);
assert.match(readme, /follow-up.*steer/i);
assert.match(readme, /evaluates every settled autonomous run/i);
assert.match(readme, /subagents:rpc:spawn/);
assert.match(readme, /fails closed.*needs_user/i);
```

Run `node --test pi/extensions/goal-loop/index.test.ts` and verify RED because the documentation is not updated.

- [ ] **Step 2: Update extension documentation**

Document:

- `/goal <objective>` starts immediately and accepts at most 4,000 characters;
- bare `/goal` reports objective, duration, evaluated runs, tokens, and evaluator reason;
- clear aliases are `stop`, `off`, `reset`, `none`, and `cancel`;
- a normal follow-up becomes durable steering, invalidates old proof, and resumes after the user turn settles;
- every autonomous run is evaluated through `subagents:rpc:spawn` using a read-only evaluator;
- missing/malformed/failed evaluator results stop at `needs_user`;
- completion still requires fresh verification evidence;
- Pi permissions remain authoritative;
- users must install `@tintinweb/pi-subagents`, recopy the template, and run `/reload`.

Use this smoke sequence:

```text
/goal Update README.md until node --test pi/extensions/goal-loop/*.test.ts passes.
Keep the existing headings unchanged.
/goal
/goal pause
/goal resume
/goal stop
```

- [ ] **Step 3: Update the root README source of truth**

Mirror the command table, evaluator requirement, steering semantics, limitations, copy command, and `/reload` instruction under the root goal-loop section. Keep the local-copy installation convention; do not replace it with `pi install`.

- [ ] **Step 4: Run full automated verification**

Run:

```bash
node --test --test-reporter=tap pi/extensions/goal-loop/*.test.ts
git diff --check
git status --short
```

Expected:

- every goal-loop test passes;
- `git diff --check` prints nothing;
- status lists only intentional goal-loop code, tests, documentation, and the previously created comparison/plan artifacts.

- [ ] **Step 5: Perform credential-backed Pi smoke verification**

Copy and reload:

```bash
cp -r pi/extensions/goal-loop ~/.pi/agent/extensions/
```

Run `/reload`, execute the smoke sequence above, and confirm:

1. the first continuation starts immediately;
2. the plain follow-up appears under steering and does not leave the goal at `needs_user`;
3. the evaluator appears as an `Explore` background agent after every autonomous run;
4. `/goal` shows duration, evaluated runs, token spend, and the latest evaluator reason;
5. evaluator unavailability stops safely without another continuation;
6. `/goal stop` clears the active goal.

If credentials or a live Pi session are unavailable, record this step as `environment-blocked`; do not represent the automated harness as a provider-backed smoke test.

- [ ] **Step 6: Commit documentation and verification updates**

```bash
git add README.md pi/extensions/goal-loop/README.md pi/extensions/goal-loop/index.test.ts docs/ai-workflow/2026-07-18-cross-client-goal-driver.md docs/superpowers/plans/2026-07-18-goal-loop-native-parity.md
git commit -m "docs(goal-loop): document native parity behavior"
```

---

## Explicitly deferred gaps

These are useful but are not required to make Pi `/goal` feel like Codex or Claude:

- canonical Git-worktree/realpath identity migration;
- an MCP service shared by Pi, Codex, and Claude;
- replacing or shadowing native Codex/Claude `/goal` commands;
- scheduled execution after Pi exits;
- extension-owned shell verification;
- an evolve loop that rewrites its own contract or policy.

Address workspace identity before cross-client adapters. Address MCP and scheduling only after the native Pi lifecycle has real run history and the direct evaluator proves stable.

## Completion criteria

The native-parity plan is complete only when:

- `/goal` start/status/edit/pause/resume/clear behavior remains backward compatible;
- clear aliases and the 4,000-character objective boundary work through command and model-tool entrypoints;
- ordinary follow-ups steer and automatically resume instead of terminating the loop;
- every settled autonomous run receives one independent coordinator-invoked evaluation;
- evaluator decisions guide continuation while fresh proof still gates completion;
- evaluator failures stop safely at `needs_user`;
- old persisted schema-version-2 state still loads;
- the full test suite, diff check, and live Pi smoke checklist are accounted for;
- README installation instructions remain copy-pasteable and include `/reload`.
