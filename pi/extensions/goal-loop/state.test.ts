import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireGoalLease,
  createGoal,
  createPendingRun,
  consumeGoalSteer,
  editGoalObjective,
  normalizeGoalState,
  markUsageLimited,
  recordEvidence,
  recordGoalSteer,
  recordRunCandidate,
  recordRunEvaluationContext,
  recordRunUsage,
  releaseGoalLease,
  resumeGoal,
  settlePendingRun,
  shouldAutoContinue,
  tokenBudgetAllowsResume,
  validateGoalObjective,
} from "./state.ts";

const NOW = new Date("2026-07-12T00:00:00.000Z");
const LATER = new Date("2026-07-12T00:05:00.000Z");
const MUCH_LATER = new Date(NOW.getTime() + 4 * 60 * 60 * 1000 + 1);
const USAGE = { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, totalTokens: 37, cost: { total: 0.037 } };

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

function decision(decision: "complete" | "continue" | "blocked" | "needs_user") {
  return {
    goalId: "goal-1",
    goalRevision: 1,
    runId: "run-1",
    evaluationRequestId: "eval-1",
    decision,
    reason: `${decision} reason`,
    confidence: "high" as const,
  };
}

test("createGoal creates versioned coordinator state", () => {
  const goal = createGoal("/repo/app", "Make tests pass", NOW, "goal-1");

  assert.equal(goal.schemaVersion, 2);
  assert.equal(goal.goalId, "goal-1");
  assert.equal(goal.goalRevision, 1);
  assert.equal(goal.storageRevision, 0);
  assert.equal(goal.pendingRun, undefined);
  assert.equal(goal.lease, undefined);
});

test("normalizeGoalState fills coordinator fields from legacy state", () => {
  const goal = normalizeGoalState({
    projectRoot: "/repo/app",
    objective: "Make tests pass",
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    turns: 2,
    maxTurns: 10,
    maxFailedVerificationAttempts: 3,
    consecutiveFailedVerificationAttempts: 0,
    verification: { commands: ["npm test"] },
  });

  assert.equal(goal.schemaVersion, 2);
  assert.equal(goal.goalRevision, 1);
  assert.equal(goal.storageRevision, 0);
  assert.equal(goal.pendingRun, undefined);
  assert.equal(goal.lease, undefined);
  assert.deepEqual(goal.verification.commands, ["npm test"]);
});

test("editGoalObjective invalidates proof and pending work", () => {
  const goal = {
    ...createGoal("/repo/app", "Old objective", NOW, "goal-1"),
    turns: 4,
    pendingRun: {
      runId: "run-1",
      evaluationRequestId: "eval-1",
      goalRevision: 1,
      sessionId: "session-a",
      dispatchedAt: NOW.toISOString(),
      toolProposal: "complete" as const,
    },
    evidence: [
      {
        at: NOW.toISOString(),
        kind: "verification" as const,
        summary: "passed",
        command: "npm test",
        outcome: "passed" as const,
        goalRevision: 1,
        runId: "run-1",
      },
    ],
    verification: { commands: ["npm test"], lastResult: "passed: passed", proofs: [] },
  };

  const edited = editGoalObjective(goal, "New objective", LATER);

  assert.equal(edited.goalRevision, 2);
  assert.equal(edited.turns, 0);
  assert.equal(edited.pendingRun, undefined);
  assert.deepEqual(edited.evidence, []);
  assert.deepEqual(edited.verification.commands, ["npm test"]);
  assert.equal(edited.verification.lastResult, undefined);
});

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

test("lease helpers enforce ownership and expiry", () => {
  const goal = createGoal("/repo", "Ship", NOW, "goal-1");
  const owned = acquireGoalLease(goal, "session-a", NOW);
  assert.equal(owned.ok, true);
  assert.equal(owned.goal.lease?.sessionId, "session-a");

  const conflict = acquireGoalLease(owned.goal, "session-b", LATER);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ownerSessionId, "session-a");
  assert.equal(conflict.expiresAt, owned.goal.lease?.expiresAt);

  const renewed = acquireGoalLease(owned.goal, "session-a", LATER);
  assert.equal(renewed.ok, true);
  assert.equal(renewed.goal.lease?.sessionId, "session-a");

  const released = releaseGoalLease(renewed.goal, "session-b", LATER);
  assert.equal(released.lease?.sessionId, "session-a");

  const cleared = releaseGoalLease(renewed.goal, "session-a", LATER);
  assert.equal(cleared.lease, undefined);

  const reclaimed = acquireGoalLease(owned.goal, "session-b", MUCH_LATER);
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.goal.lease?.sessionId, "session-b");
});

test("pending runs are recorded and settled exactly once", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  const pending = createPendingRun(goal, "session-a", NOW, {
    runId: "run-1",
    evaluationRequestId: "eval-1",
  });
  assert.equal(pending.ok, true);

  goal = pending.goal;
  goal = recordRunCandidate(goal, {
    protocol: "valid",
    worker: decision("continue"),
    evaluator: decision("continue"),
  }, LATER);

  const settled = settlePendingRun(goal, LATER);
  assert.equal(settled.action, "dispatch");
  assert.equal(settled.goal.turns, 1);
  assert.equal(settled.goal.evaluatedRuns, 1);
  assert.equal(settled.goal.pendingRun, undefined);
  assert.equal(settlePendingRun(settled.goal, LATER).action, "none");
});

test("run evaluation context is bounded to the latest transcript text", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;

  goal = recordRunEvaluationContext(goal, `old-${"x".repeat(32_000)}-latest`, LATER);

  assert.equal(goal.pendingRun?.evaluationContext?.length, 32_000);
  assert.equal(goal.pendingRun?.evaluationContext?.endsWith("-latest"), true);
});

test("completion requires a fresh passing verification record", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, {
    runId: "run-1",
    evaluationRequestId: "eval-1",
  }).goal;
  goal = recordEvidence(goal, {
    kind: "verification",
    summary: "npm test passed",
    command: "npm test",
    outcome: "passed",
    goalRevision: 1,
    runId: "run-1",
  }, LATER);
  goal = recordRunCandidate(goal, {
    protocol: "valid",
    worker: decision("complete"),
    evaluator: {
      goalId: "goal-1",
      goalRevision: 1,
      runId: "run-1",
      evaluationRequestId: "eval-1",
      decision: "complete",
      reason: "looks good",
      confidence: "high",
    },
  }, LATER);

  const settled = settlePendingRun(goal, LATER);
  assert.equal(settled.action, "complete");
  assert.equal(settled.goal.status, "complete");
});

test("terminal settlement releases the lease so another session can act immediately", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordEvidence(goal, {
    kind: "verification",
    summary: "tests passed",
    command: "npm test",
    outcome: "passed",
    goalRevision: 1,
    runId: "run-1",
  }, LATER);
  goal = recordRunCandidate(goal, { protocol: "valid", worker: decision("complete"), evaluator: decision("complete") }, LATER);

  const settled = settlePendingRun(goal, LATER);
  const nextSession = acquireGoalLease(settled.goal, "session-b", LATER);

  assert.equal(settled.action, "complete");
  assert.equal(settled.goal.lease, undefined);
  assert.equal(nextSession.ok, true);
  if (nextSession.ok) assert.equal(nextSession.goal.lease?.sessionId, "session-b");
});

test("completion retains proof for every configured command beyond the compact evidence cap", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  const commands = Array.from({ length: 11 }, (_, index) => `check-${index + 1}`);
  goal = { ...goal, verification: { ...goal.verification, commands } };
  for (const command of commands) {
    goal = recordEvidence(goal, {
      kind: "verification",
      summary: `${command} passed`,
      command,
      outcome: "passed",
      goalRevision: 1,
      runId: "run-1",
    }, LATER);
  }
  assert.equal(goal.evidence.length, 10);
  assert.equal(goal.verification.proofs.length, 11);
  goal = recordRunCandidate(goal, { protocol: "valid", worker: decision("complete"), evaluator: decision("complete") }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "complete");
});

test("completion rejects zero-command goals without current-run verification evidence", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordRunCandidate(goal, {
    protocol: "valid",
    worker: decision("complete"),
    evaluator: decision("complete"),
  }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "needs_user");
  assert.match(settled.reason ?? "", /verification evidence is missing/i);
});

test("completion rejects a command whose latest current-run result failed", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = { ...goal, verification: { commands: ["npm test"], proofs: [] } };
  goal = recordEvidence(goal, {
    kind: "verification",
    summary: "initial pass",
    command: "npm test",
    outcome: "passed",
    goalRevision: 1,
    runId: "run-1",
  }, LATER);
  goal = recordEvidence(goal, {
    kind: "verification",
    summary: "regression",
    command: "npm test",
    outcome: "failed",
    goalRevision: 1,
    runId: "run-1",
  }, LATER);
  goal = recordRunCandidate(goal, {
    protocol: "valid",
    worker: decision("complete"),
    evaluator: decision("complete"),
  }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "needs_user");
  assert.match(settled.reason ?? "", /verification evidence is missing/i);
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

test("conflicting model terminal proposals require a human at settlement", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = {
    ...goal,
    pendingRun: { ...goal.pendingRun!, toolProposal: "complete", toolProposalConflict: true },
  };
  goal = recordRunCandidate(goal, { protocol: "valid", worker: decision("complete"), evaluator: decision("complete") }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "needs_user");
  assert.match(settled.reason ?? "", /conflicting model terminal proposals/i);
});

test("a matching evaluator continue overrides a worker terminal proposal", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordRunCandidate(goal, {
    protocol: "valid",
    worker: decision("complete"),
    evaluator: decision("continue"),
  }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "dispatch");
  assert.equal(settled.goal.status, "active");
  assert.equal(settled.goal.lastEvaluation?.reason, "continue reason");
  assert.equal(settled.goal.evaluatedRuns, 1);
});

test("settlement blocks once structured verification failures reach the limit", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = { ...goal, consecutiveFailedVerificationAttempts: goal.maxFailedVerificationAttempts };
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordRunCandidate(goal, { protocol: "valid", worker: decision("continue"), evaluator: decision("continue") }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "blocked");
  assert.equal(settled.goal.pendingRun, undefined);
});

test("an aborted assistant run blocks without an automatic retry", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordRunCandidate(goal, {
    protocol: "malformed",
    source: "assistant_stop",
    reason: "Assistant turn ended with aborted.",
  }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "blocked");
  assert.equal(settled.goal.status, "blocked");
});

test("resumeGoal extends spent turn budgets", () => {
  const goal = {
    ...createGoal("/repo/app", "Make tests pass", NOW, "goal-1"),
    status: "blocked" as const,
    turns: 10,
    maxTurns: 10,
  };

  const resumed = resumeGoal(goal, LATER);

  assert.equal(resumed.status, "active");
  assert.equal(resumed.turns, 10);
  assert.equal(resumed.maxTurns, 20);
});

test("old schema-v2 states normalize without additive usage fields", () => {
  const goal = normalizeGoalState({
    schemaVersion: 2,
    goalId: "old-goal",
    goalRevision: 1,
    storageRevision: 1,
    projectRoot: "/repo/app",
    objective: "Old state",
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    turns: 0,
    maxTurns: 10,
    maxFailedVerificationAttempts: 3,
    consecutiveFailedVerificationAttempts: 0,
    verification: { commands: [] },
    evidence: [],
  });

  assert.equal(goal.schemaVersion, 2);
  assert.equal(goal.tokenBudget, undefined);
  assert.equal(goal.usage, undefined);
  assert.equal(goal.limitDetail, undefined);
});

test("autonomous usage is cumulative and recorded once per pending run", () => {
  let goal = acquireGoalLease(createGoal("/repo", "Ship", NOW, "goal-1"), "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  const once = recordRunUsage(goal, USAGE, LATER, "low-level-run-1");
  const twice = recordRunUsage(once, USAGE, LATER, "low-level-run-1");

  assert.deepEqual(once.usage, USAGE);
  assert.deepEqual(once.pendingRun?.usageRunFingerprints, ["low-level-run-1"]);
  assert.deepEqual(twice.usage, USAGE);
});

test("valid continue at the token budget releases run ownership and limits dispatch", () => {
  let goal = acquireGoalLease({ ...createGoal("/repo", "Ship", NOW, "goal-1"), tokenBudget: 37 }, "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordRunUsage(goal, USAGE, LATER);
  goal = recordRunCandidate(goal, { protocol: "valid", worker: decision("continue"), evaluator: decision("continue") }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "token_budget_limited");
  assert.equal(settled.goal.status, "token_budget_limited");
  assert.equal(settled.goal.pendingRun, undefined);
  assert.equal(settled.goal.lease, undefined);
  assert.equal(tokenBudgetAllowsResume(settled.goal), false);
  assert.equal(resumeGoal(settled.goal, LATER).status, "token_budget_limited");
  assert.equal(tokenBudgetAllowsResume({ ...settled.goal, tokenBudget: 38 }), true);
  assert.equal(tokenBudgetAllowsResume({ ...settled.goal, tokenBudget: undefined }), true);
});

test("token budget resume gating applies to blocked and usage-limited states", () => {
  const base = { ...createGoal("/repo", "Ship", NOW, "goal-1"), tokenBudget: 37, usage: USAGE };

  for (const status of ["blocked", "usage_limited"] as const) {
    const limited = { ...base, status };
    assert.equal(tokenBudgetAllowsResume(limited), false);
    assert.equal(tokenBudgetAllowsResume({ ...limited, tokenBudget: 36 }), false);
    assert.equal(resumeGoal(limited, LATER).status, status);
    assert.equal(tokenBudgetAllowsResume({ ...limited, tokenBudget: 38 }), true);
    assert.equal(tokenBudgetAllowsResume({ ...limited, tokenBudget: undefined }), true);
    assert.equal(resumeGoal({ ...limited, tokenBudget: 38 }, LATER).status, "active");
    assert.equal(resumeGoal({ ...limited, tokenBudget: undefined }, LATER).status, "active");
  }
});

test("a valid completion can complete after the configured token budget is reached", () => {
  let goal = acquireGoalLease({ ...createGoal("/repo", "Ship", NOW, "goal-1"), tokenBudget: 37 }, "session-a", NOW).goal;
  goal = createPendingRun(goal, "session-a", NOW, { runId: "run-1", evaluationRequestId: "eval-1" }).goal;
  goal = recordRunUsage(goal, USAGE, LATER);
  goal = recordEvidence(goal, { kind: "verification", summary: "passed", outcome: "passed", goalRevision: 1, runId: "run-1" }, LATER);
  goal = recordRunCandidate(goal, { protocol: "valid", worker: decision("complete"), evaluator: decision("complete") }, LATER);

  const settled = settlePendingRun(goal, LATER);

  assert.equal(settled.action, "complete");
  assert.equal(settled.goal.status, "complete");
});

test("usage limit state is structured and human resume clears its detail", () => {
  const limited = markUsageLimited(createGoal("/repo", "Ship", NOW, "goal-1"), "Provider limit.", LATER, { runId: "run-1", retryAfter: "5" });
  assert.equal(limited.status, "usage_limited");
  assert.equal(limited.limitDetail?.retryAfter, "5");
  assert.equal(resumeGoal(limited, LATER).limitDetail, undefined);
});

test("shouldAutoContinue honors status and turn budget", () => {
  const goal = createGoal("/repo/app", "Make tests pass", NOW, "goal-1");

  assert.equal(shouldAutoContinue(goal), true);
  assert.equal(shouldAutoContinue({ ...goal, status: "paused" }), false);
  assert.equal(shouldAutoContinue({ ...goal, turns: 10 }), false);
});
