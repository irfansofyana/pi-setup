import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContinuationPrompt,
  continuationDeliveryOptions,
  createGoal,
  goalKey,
  normalizeGoalState,
  parseGoalArgs,
  recordEvidence,
  recordEvaluation,
  shouldAutoContinue,
} from "./index.ts";

test("parseGoalArgs treats bare text as a start command", () => {
  assert.deepEqual(parseGoalArgs("ship the README update"), {
    command: "start",
    value: "ship the README update",
  });
});

test("parseGoalArgs parses subcommands with values", () => {
  assert.deepEqual(parseGoalArgs("verify npm test"), {
    command: "verify",
    value: "npm test",
  });
  assert.deepEqual(parseGoalArgs("pause"), {
    command: "pause",
    value: "",
  });
});

test("goalKey is stable per project", () => {
  assert.equal(goalKey("/tmp/example"), "f33aa9244af53b88");
  assert.equal(goalKey("/tmp/example/"), "f33aa9244af53b88");
});

test("createGoal stores one active project goal with defaults", () => {
  const goal = createGoal("/repo/app", "Make tests pass", new Date("2026-06-26T00:00:00.000Z"));

  assert.equal(goal.projectRoot, "/repo/app");
  assert.equal(goal.objective, "Make tests pass");
  assert.equal(goal.status, "active");
  assert.equal(goal.turns, 0);
  assert.equal(goal.maxTurns, 10);
  assert.equal(goal.maxFailedVerificationAttempts, 3);
  assert.deepEqual(goal.verification.commands, []);
  assert.deepEqual(goal.evidence, []);
});

test("normalizeGoalState fills fields missing from older state files", () => {
  const goal = normalizeGoalState({
    projectRoot: "/repo/app",
    objective: "Make tests pass",
    status: "active",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    turns: 2,
    maxTurns: 10,
    maxFailedVerificationAttempts: 3,
    consecutiveFailedVerificationAttempts: 0,
    verification: {
      commands: ["npm test"],
    },
  });

  assert.deepEqual(goal.evidence, []);
  assert.deepEqual(goal.verification.commands, ["npm test"]);
});

test("continuationDeliveryOptions omits followUp when Pi is idle", () => {
  assert.equal(continuationDeliveryOptions(true), undefined);
  assert.deepEqual(continuationDeliveryOptions(false), { deliverAs: "followUp" });
});

test("recordEvaluation completes, blocks, or increments turns", () => {
  const started = createGoal("/repo/app", "Make tests pass", new Date("2026-06-26T00:00:00.000Z"));

  const continued = recordEvaluation(started, {
    decision: "continue",
    reason: "Tests still fail",
    confidence: "medium",
  }, new Date("2026-06-26T00:01:00.000Z"));
  assert.equal(continued.status, "active");
  assert.equal(continued.turns, 1);

  const completed = recordEvaluation(continued, {
    decision: "complete",
    reason: "Verification passed",
    confidence: "high",
  }, new Date("2026-06-26T00:02:00.000Z"));
  assert.equal(completed.status, "complete");
  assert.equal(completed.lastEvaluation?.reason, "Verification passed");

  const blocked = recordEvaluation(continued, {
    decision: "blocked",
    reason: "Same failure repeated",
    confidence: "high",
  }, new Date("2026-06-26T00:03:00.000Z"));
  assert.equal(blocked.status, "blocked");
});

test("shouldAutoContinue honors status and turn budget", () => {
  const goal = createGoal("/repo/app", "Make tests pass", new Date("2026-06-26T00:00:00.000Z"));
  assert.equal(shouldAutoContinue(goal), true);

  assert.equal(shouldAutoContinue({ ...goal, status: "paused" }), false);
  assert.equal(shouldAutoContinue({ ...goal, turns: 10 }), false);
});

test("recordEvaluation blocks after repeated verification failures", () => {
  const goal = {
    ...createGoal("/repo/app", "Make tests pass", new Date("2026-06-26T00:00:00.000Z")),
    consecutiveFailedVerificationAttempts: 2,
  };

  const updated = recordEvaluation(goal, {
    decision: "continue",
    reason: "npm test is still failing",
    confidence: "medium",
  }, new Date("2026-06-26T00:01:00.000Z"));

  assert.equal(updated.status, "blocked");
  assert.equal(updated.consecutiveFailedVerificationAttempts, 3);
});

test("recordEvidence appends bounded evidence entries", () => {
  let goal = createGoal("/repo/app", "Make tests pass", new Date("2026-06-26T00:00:00.000Z"));

  for (let index = 1; index <= 12; index += 1) {
    goal = recordEvidence(goal, {
      kind: "verification",
      summary: `npm test attempt ${index}`,
      command: "npm test",
      outcome: index === 12 ? "passed" : "failed",
    }, new Date(`2026-06-26T00:${String(index).padStart(2, "0")}:00.000Z`));
  }

  assert.equal(goal.evidence.length, 10);
  assert.equal(goal.evidence[0].summary, "npm test attempt 3");
  assert.equal(goal.evidence[9].outcome, "passed");
  assert.equal(goal.verification.lastResult, "passed: npm test attempt 12");
});

test("buildContinuationPrompt includes objective and verification commands", () => {
  const goal = {
    ...createGoal("/repo/app", "Make tests pass", new Date("2026-06-26T00:00:00.000Z")),
    verification: { commands: ["npm test"], lastResult: "failed" },
    evidence: [
      {
        at: "2026-06-26T00:01:00.000Z",
        kind: "verification" as const,
        summary: "npm test failed on one assertion",
        command: "npm test",
        outcome: "failed" as const,
      },
    ],
  };

  const prompt = buildContinuationPrompt(goal);

  assert.match(prompt, /Continue working toward this active goal/);
  assert.match(prompt, /Make tests pass/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /Recent evidence/);
  assert.match(prompt, /npm test failed on one assertion/);
  assert.match(prompt, /get_goal/);
  assert.match(prompt, /update_goal/);
  assert.match(prompt, /Stop and ask the user/);
});
