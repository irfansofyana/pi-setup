import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContinuationPrompt,
  createGoal,
  goalKey,
  parseGoalArgs,
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

test("buildContinuationPrompt includes objective and verification commands", () => {
  const goal = {
    ...createGoal("/repo/app", "Make tests pass", new Date("2026-06-26T00:00:00.000Z")),
    verification: { commands: ["npm test"], lastResult: "failed" },
  };

  const prompt = buildContinuationPrompt(goal);

  assert.match(prompt, /Continue working toward this active goal/);
  assert.match(prompt, /Make tests pass/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /Stop and ask the user/);
});
