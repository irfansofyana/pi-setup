import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  buildContinuationPrompt,
  buildGoalSystemPrompt,
  createGoal,
  createGoalLoopExtension,
  formatGoalDuration,
  goalKey,
  goalStatusText,
  normalizeGoalLoopConfig,
  normalizeGoalState,
  parseGoalArgs,
  recordEvidence,
  resumeGoal,
  shouldAutoContinue,
  sumAssistantUsage,
} from "./index.ts";
import { createGoalStorage, GoalStorageConflictError } from "./storage.ts";
import type { GoalEvaluator, GoalEvaluatorInput } from "./evaluator.ts";

const NOW = new Date("2026-07-12T00:00:00.000Z");

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

const passthroughEvaluator: GoalEvaluator = {
  async evaluate(input) {
    return { ok: true, record: evaluatorDecision(input, input.worker.decision, input.worker.reason) };
  },
};

function createHarness(session = "session-a", evaluator: GoalEvaluator = passthroughEvaluator) {
  const root = mkdtempSync(join(tmpdir(), "goal-loop-index-"));
  const storage = createGoalStorage({
    storageRoot: join(root, "state"),
    legacyStatePath: join(root, "legacy", "state.json"),
    auditRoot: join(root, "logs"),
    corruptRoot: join(root, "corrupt"),
    archiveRoot: join(root, "archive"),
    getProcessStartToken: () => "test-process-start",
  });
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const sent: string[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  let idle = true;
  let pendingMessages = false;
  let throwOnSend = false;
  let currentNow = NOW;
  let id = 0;
  const api = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: any) { handlers.set(name, handler); },
    sendUserMessage(message: string) {
      if (throwOnSend) throw new Error("synthetic send failure");
      sent.push(message);
    },
  };
  const ctx: any = {
    cwd: "/repo/app",
    ui: {
      notify(message: string, type?: string) { notifications.push({ message, type }); },
      setStatus() {},
    },
    sessionManager: { getSessionId: () => session },
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
  };
  createGoalLoopExtension({ storage, config: { allowModelCreateGoal: false }, now: () => currentNow, randomId: () => `id-${++id}`, evaluator })(api as any);
  return {
    root, storage, tools, commands, handlers, sent, notifications, ctx,
    setIdle(value: boolean) { idle = value; },
    setPendingMessages(value: boolean) { pendingMessages = value; },
    setThrowOnSend(value: boolean) { throwOnSend = value; },
    setNow(value: Date) { currentNow = value; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

const RUN_USAGE = {
  input: 10,
  output: 20,
  cacheRead: 3,
  cacheWrite: 4,
  reasoning: 7,
  totalTokens: 37,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
};

const ERROR_USAGE = {
  input: 2,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 3,
  cost: { input: 0.002, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

function workerMessages(goal: any, decision: "complete" | "continue" | "blocked" | "needs_user" = "continue", usage: any = RUN_USAGE) {
  const pending = goal.pendingRun;
  return [{
    role: "user",
    content: `GOAL_LOOP_CONTINUATION_RUN: ${pending.runId}`,
  }, {
    role: "assistant",
    usage,
    stopReason: "stop",
    content: [{
      type: "text",
      text: `GOAL_WORKER_DECISION: ${JSON.stringify({
        goalId: goal.goalId,
        goalRevision: goal.goalRevision,
        runId: pending.runId,
        evaluationRequestId: pending.evaluationRequestId,
        decision,
        reason: `${decision} reason`,
      })}`,
    }],
  }];
}

function completionMessages(goal: any, usage: any = RUN_USAGE) {
  const pending = goal.pendingRun;
  return [{
    role: "user",
    content: `GOAL_LOOP_CONTINUATION_RUN: ${pending.runId}`,
  }, {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-eval",
      name: "Agent",
      arguments: { description: "Evaluate goal status", prompt: `Evaluation request: ${pending.evaluationRequestId}` },
    }],
  }, {
    role: "toolResult",
    toolName: "Agent",
    toolCallId: "call-eval",
    content: [{ type: "text", text: `GOAL_EVALUATOR_DECISION: ${JSON.stringify({
      goalId: goal.goalId,
      goalRevision: goal.goalRevision,
      runId: pending.runId,
      evaluationRequestId: pending.evaluationRequestId,
      decision: "complete",
      reason: "verified complete",
      confidence: "high",
    })}` }],
  }, {
    role: "assistant",
    usage,
    stopReason: "stop",
    content: [{ type: "text", text: `GOAL_WORKER_DECISION: ${JSON.stringify({
      goalId: goal.goalId,
      goalRevision: goal.goalRevision,
      runId: pending.runId,
      evaluationRequestId: pending.evaluationRequestId,
      decision: "complete",
      reason: "verified complete",
    })}` }],
  }];
}

async function acceptContinuation(harness: ReturnType<typeof createHarness>) {
  const continuation = harness.sent.at(-1)!;
  return harness.handlers.get("before_agent_start")({
    prompt: continuation,
    systemPrompt: "base",
    systemPromptOptions: { cwd: harness.ctx.cwd },
  }, harness.ctx);
}

async function completeCurrentGoal(harness: ReturnType<typeof createHarness>) {
  await acceptContinuation(harness);
  await harness.tools.get("update_goal").execute("call", {
    evidence: "verification passed",
    evidenceKind: "verification",
    outcome: "passed",
  }, undefined, undefined, harness.ctx);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: completionMessages(goal) }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  return goal.goalId;
}

test("parseGoalArgs treats bare /goal as status and keeps the status alias", () => {
  assert.deepEqual(parseGoalArgs(""), { command: "status", value: "" });
  assert.deepEqual(parseGoalArgs("status"), { command: "status", value: "" });
  assert.deepEqual(parseGoalArgs("ship the README update"), { command: "start", value: "ship the README update" });
  assert.deepEqual(parseGoalArgs("verify npm test"), { command: "verify", value: "npm test" });
  assert.deepEqual(parseGoalArgs("pause"), { command: "pause", value: "" });
  assert.deepEqual(parseGoalArgs("list"), { command: "list", value: "" });
  assert.deepEqual(parseGoalArgs("budget 1000"), { command: "budget", value: "1000" });
});

test("parseGoalArgs supports native clear aliases", () => {
  for (const alias of ["stop", "off", "reset", "none", "cancel"]) {
    assert.deepEqual(parseGoalArgs(alias), { command: "clear", value: "" });
  }
});

test("formatGoalDuration uses compact stable units", () => {
  assert.equal(formatGoalDuration("2026-07-18T00:00:00.000Z", new Date("2026-07-18T00:02:05.000Z")), "2m 5s");
  assert.equal(formatGoalDuration("2026-07-18T00:00:00.000Z", new Date("2026-07-18T01:02:00.000Z")), "1h 2m");
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

test("goal state compatibility helpers retain user-visible defaults", () => {
  assert.equal(goalKey("/tmp/example"), "f33aa9244af53b88");
  assert.equal(goalKey("/tmp/example/"), "f33aa9244af53b88");
  const goal = createGoal("/repo/app", "Make tests pass", NOW, "goal-1");
  assert.equal(goal.status, "active");
  assert.equal(goal.maxTurns, 10);
  assert.equal(shouldAutoContinue(goal), true);
  assert.equal(goalStatusText(goal), "goal ◐ 0/10");
  assert.equal(normalizeGoalState(goal).schemaVersion, 2);

  const resumed = resumeGoal({ ...goal, status: "blocked", turns: 10 }, NOW);
  assert.equal(resumed.maxTurns, 20);
});

test("recordEvidence is bounded and uses structured outcomes", () => {
  let goal = createGoal("/repo/app", "Make tests pass", NOW, "goal-1");
  for (let index = 1; index <= 12; index += 1) {
    goal = recordEvidence(goal, {
      kind: "verification",
      summary: `attempt ${index}`,
      command: "npm test",
      outcome: index === 12 ? "passed" : "failed",
      goalRevision: 1,
      runId: "run-1",
    }, NOW);
  }
  assert.equal(goal.evidence.length, 10);
  assert.equal(goal.consecutiveFailedVerificationAttempts, 0);
  assert.equal(goal.verification.lastResult, "passed: attempt 12");
});

test("prompts carry structured current-run authority", () => {
  const goal = {
    ...createGoal("/repo/app", "Make tests pass", NOW, "goal-1"),
    pendingRun: {
      runId: "run-1",
      evaluationRequestId: "eval-1",
      goalRevision: 1,
      sessionId: "session-a",
      dispatchedAt: NOW.toISOString(),
    },
    verification: { commands: ["npm test"], proofs: [] },
  };
  const continuation = buildContinuationPrompt(goal);
  const system = buildGoalSystemPrompt(goal);
  assert.match(continuation, /GOAL_WORKER_DECISION/);
  assert.match(continuation, /GOAL_LOOP_CONTINUATION_RUN: run-1/);
  assert.match(continuation, /run-1/);
  assert.match(continuation, /eval-1/);
  assert.match(system, /Model-authored terminal status is only a proposal/);
  assert.match(system, /GOAL_WORKER_DECISION/);
});

test("goal-loop config disables model goal creation by default", () => {
  assert.deepEqual(normalizeGoalLoopConfig(undefined), { allowModelCreateGoal: false });
  assert.deepEqual(normalizeGoalLoopConfig({ allowModelCreateGoal: true }), { allowModelCreateGoal: true });
  assert.deepEqual(normalizeGoalLoopConfig({ allowModelCreateGoal: "true" }), { allowModelCreateGoal: false });
});

test("model tool schema cannot activate, pause, or change budgets", () => {
  const harness = createHarness();
  const updateGoal = harness.tools.get("update_goal");
  assert.equal(harness.tools.get("create_goal"), undefined);
  assert.equal(updateGoal.executionMode, "sequential");
  assert.deepEqual(updateGoal.parameters.properties.proposedStatus.enum, ["complete", "blocked", "needs_user"]);
  assert.equal(updateGoal.parameters.properties.status, undefined);
  assert.equal(updateGoal.parameters.properties.maxTurns, undefined);
  assert.equal(updateGoal.parameters.additionalProperties, false);
  harness.cleanup();
});

test("verification commands and proof fields are bounded at the model boundary", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const tool = harness.tools.get("update_goal");

  const longEvidence = await tool.execute("call", { evidence: "x".repeat(2_001) }, undefined, undefined, harness.ctx);
  assert.deepEqual(longEvidence.details, { error: "invalid_evidence" });
  const longCommand = await tool.execute("call", { verificationCommand: "x".repeat(501) }, undefined, undefined, harness.ctx);
  assert.deepEqual(longCommand.details, { error: "invalid_verification_command" });
  const unconfiguredProof = await tool.execute("call", {
    evidence: "passed",
    evidenceKind: "verification",
    command: "not-configured",
    outcome: "passed",
  }, undefined, undefined, harness.ctx);
  assert.deepEqual(unconfiguredProof.details, { error: "unconfigured_evidence_command" });

  for (let index = 1; index <= 50; index += 1) {
    const result = await tool.execute("call", { verificationCommand: `check-${index}` }, undefined, undefined, harness.ctx);
    assert.equal(result.details.goal.verification.commands.length, index);
  }
  const overflow = await tool.execute("call", { verificationCommand: "check-51" }, undefined, undefined, harness.ctx);
  assert.deepEqual(overflow.details, { error: "too_many_verification_commands" });
  assert.equal(harness.storage.read(harness.ctx.cwd)?.verification.commands.length, 50);
  harness.cleanup();
});

test("start stops after quarantining corrupt state instead of replacing it", async () => {
  const harness = createHarness();
  writeFileSync(harness.storage.statePathFor(harness.ctx.cwd), "{not-json", "utf8");

  await harness.commands.get("goal").handler("Replacement objective", harness.ctx);

  assert.equal(harness.storage.stateExists(harness.ctx.cwd), false);
  assert.equal(harness.storage.corruptFiles().length, 1);
  assert.equal(harness.sent.length, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /state was corrupt/i);
  harness.cleanup();
});

test("orphaned recovery claims surface an actionable cleanup path", async () => {
  const harness = createHarness();
  const statePath = harness.storage.statePathFor(harness.ctx.cwd);
  const lockPath = join(statePath, "..", `.${basename(statePath, ".json")}.lock`);
  const reclaimPath = `${lockPath}.reclaim`;
  const createdAt = "2026-07-11T00:00:00.000Z";
  writeFileSync(lockPath, JSON.stringify({ ownerId: "dead", createdAt, pid: 999_999 }), "utf8");
  const lockStat = statSync(lockPath);
  writeFileSync(reclaimPath, JSON.stringify({
    ownerId: "orphaned-reclaimer",
    pid: 999_998,
    claimedAt: createdAt,
    lock: { pid: 999_999, ownerId: "dead", createdAt, dev: lockStat.dev, ino: lockStat.ino },
  }), "utf8");

  await harness.commands.get("goal").handler("Ship safely", harness.ctx);

  assert.equal(harness.storage.read(harness.ctx.cwd), undefined);
  assert.match(harness.notifications.at(-1)?.message ?? "", /After verifying no Pi process.*\.lock\.reclaim/i);
  harness.cleanup();
});

test("agent_end records a candidate and agent_settled dispatches exactly once", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  assert.equal(harness.sent.length, 1);
  const first = harness.storage.read(harness.ctx.cwd)!;

  await harness.handlers.get("agent_end")({ messages: workerMessages(first) }, harness.ctx);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.pendingRun?.candidate?.protocol, "valid");

  await harness.handlers.get("agent_settled")({}, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.turns, 1);
  harness.cleanup();
});

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
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(evaluatorCalls.length, 1);
  assert.equal(evaluatorCalls[0].runId, initial.pendingRun!.runId);
  assert.match(evaluatorCalls[0].transcriptExcerpt, /GOAL_WORKER_DECISION/);
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.evaluatedRuns, 1);
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
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "needs_user");
  assert.equal(harness.sent.length, 1);
  harness.cleanup();
});

test("a stale evaluator result cannot settle an edited goal", async () => {
  let releaseEvaluation!: () => void;
  const evaluationGate = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      await evaluationGate;
      return { ok: true, record: evaluatorDecision(input, "complete", "Old revision complete.") };
    },
  };
  const harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Original objective", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);

  const settling = harness.handlers.get("agent_settled")({}, harness.ctx);
  await Promise.resolve();
  await harness.commands.get("goal").handler("edit Revised objective", harness.ctx);
  releaseEvaluation();
  await settling;

  const revised = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(revised.objective, "Revised objective");
  assert.equal(revised.goalRevision, 2);
  assert.equal(revised.status, "active");
  assert.equal(revised.lastEvaluation, undefined);
  harness.cleanup();
});

test("a token budget change during evaluation settles against refreshed state", async () => {
  let releaseEvaluation!: () => void;
  const evaluationGate = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      await evaluationGate;
      return { ok: true, record: evaluatorDecision(input, "continue", "More work remains.") };
    },
  };
  const harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);

  const settling = harness.handlers.get("agent_settled")({}, harness.ctx);
  await Promise.resolve();
  await harness.commands.get("goal").handler("budget 1000", harness.ctx);
  releaseEvaluation();
  await settling;

  const settled = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(settled.tokenBudget, 1000);
  assert.equal(settled.evaluatedRuns, 1);
  assert.ok(settled.pendingRun);
  assert.equal(harness.sent.length, 2);
  harness.cleanup();
});

test("verification changes during evaluation trigger a fresh evaluation", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const evaluatorCalls: GoalEvaluatorInput[] = [];
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      evaluatorCalls.push(input);
      if (evaluatorCalls.length === 1) await firstGate;
      return { ok: true, record: evaluatorDecision(input, "continue", "More work remains.") };
    },
  };
  const harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);

  const settling = harness.handlers.get("agent_settled")({}, harness.ctx);
  await Promise.resolve();
  await harness.commands.get("goal").handler("verify npm test", harness.ctx);
  releaseFirst();
  await settling;

  assert.equal(evaluatorCalls.length, 2);
  assert.deepEqual(evaluatorCalls[1].verificationCommands, ["npm test"]);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.evaluatedRuns, 1);
  assert.equal(harness.sent.length, 2);
  harness.cleanup();
});

test("repeated verification changes during evaluation stop without a pending run", async () => {
  let harness: ReturnType<typeof createHarness>;
  let evaluatorCalls = 0;
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      evaluatorCalls += 1;
      await harness.commands.get("goal").handler(`verify check-${evaluatorCalls}`, harness.ctx);
      return { ok: true, record: evaluatorDecision(input, "continue", "More work remains.") };
    },
  };
  harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);

  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const stopped = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(evaluatorCalls, 3);
  assert.equal(stopped.status, "needs_user");
  assert.equal(stopped.pendingRun, undefined);
  assert.equal(stopped.lease, undefined);
  assert.equal(harness.sent.length, 1);
  harness.cleanup();
});

test("retry exhaustion retries its needs_user transition after a storage conflict", async () => {
  let harness: ReturnType<typeof createHarness>;
  let evaluatorCalls = 0;
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      evaluatorCalls += 1;
      await harness.commands.get("goal").handler(`verify check-${evaluatorCalls}`, harness.ctx);
      return { ok: true, record: evaluatorDecision(input, "continue", "More work remains.") };
    },
  };
  harness = createHarness("session-a", evaluator);
  const originalWrite = harness.storage.write.bind(harness.storage);
  let conflictInjected = false;
  harness.storage.write = (goal: any, revision: number, event: any) => {
    if (event.type === "evaluator_retry_exhausted" && !conflictInjected) {
      conflictInjected = true;
      throw new GoalStorageConflictError();
    }
    return originalWrite(goal, revision, event);
  };
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);

  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const stopped = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(conflictInjected, true);
  assert.equal(stopped.status, "needs_user");
  assert.equal(stopped.pendingRun, undefined);
  assert.equal(stopped.lease, undefined);
  assert.match(harness.notifications.at(-1)?.message ?? "", /stopped \(needs_user\)/i);
  harness.cleanup();
});

test("queued messages suppress dispatch and normal user turns cannot claim autonomous run authority", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const first = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(first) }, harness.ctx);
  harness.setPendingMessages(true);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.pendingRun, undefined);

  harness.setPendingMessages(false);
  const normalTurn = await harness.handlers.get("before_agent_start")({ prompt: "Please explain the diff", systemPrompt: "base", systemPromptOptions: { cwd: harness.ctx.cwd } }, harness.ctx);
  assert.match(normalTurn.systemPrompt, /Active Pi goal loop/);
  assert.doesNotMatch(normalTurn.systemPrompt, /GOAL_WORKER_DECISION/);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.pendingRun, undefined);

  await harness.commands.get("goal").handler("resume", harness.ctx);
  const extensionTurn = await acceptContinuation(harness);
  assert.match(extensionTurn.systemPrompt, /GOAL_WORKER_DECISION/);
  assert.ok(harness.storage.read(harness.ctx.cwd)?.pendingRun);
  harness.cleanup();
});

test("normal active-goal turns get context but cannot mutate a pending autonomous run", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const before = harness.storage.read(harness.ctx.cwd)!;
  harness.setNow(new Date(NOW.getTime() + 1_000));

  const normalTurn = await harness.handlers.get("before_agent_start")({
    prompt: "Please explain the current diff.",
    systemPrompt: "base",
    systemPromptOptions: { cwd: harness.ctx.cwd },
  }, harness.ctx);
  assert.match(normalTurn.systemPrompt, /Active Pi goal loop/);
  assert.doesNotMatch(normalTurn.systemPrompt, /GOAL_(?:WORKER|EVALUATOR)_DECISION/);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.lease?.renewedAt, new Date(NOW.getTime() + 1_000).toISOString());

  const rejected = await harness.tools.get("update_goal").execute("call", {
    evidence: "normal-turn evidence",
    proposedStatus: "complete",
  }, undefined, undefined, harness.ctx);
  assert.deepEqual(rejected.details, { error: "no_continuation_authority" });
  assert.equal(harness.storage.read(harness.ctx.cwd)?.evidence.length, before.evidence.length);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.pendingRun?.toolProposal, undefined);

  await acceptContinuation(harness);
  const accepted = await harness.tools.get("update_goal").execute("call", { evidence: "continuation evidence" }, undefined, undefined, harness.ctx);
  assert.equal(accepted.details.goal.evidence.at(-1)?.summary, "continuation evidence");

  const active = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(active) }, harness.ctx);
  const afterEnd = await harness.tools.get("update_goal").execute("call", { evidence: "late mutation" }, undefined, undefined, harness.ctx);
  assert.deepEqual(afterEnd.details, { error: "no_continuation_authority" });
  harness.cleanup();
});

test("terminal model proposals remain non-authoritative until settlement", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const tool = harness.tools.get("update_goal");
  await tool.execute("call", { proposedStatus: "complete", reason: "looks done" }, undefined, undefined, harness.ctx);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(goal.status, "active");
  assert.equal(goal.pendingRun?.toolProposal, "complete");
  harness.cleanup();
});

test("conflicting model terminal proposals retain the first and fail closed", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const tool = harness.tools.get("update_goal");
  await tool.execute("call", { proposedStatus: "complete", reason: "first" }, undefined, undefined, harness.ctx);
  await tool.execute("call", { proposedStatus: "blocked", reason: "second" }, undefined, undefined, harness.ctx);
  const afterProposals = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(afterProposals.pendingRun?.toolProposal, "complete");
  assert.equal(afterProposals.pendingRun?.toolProposalConflict, true);

  await harness.handlers.get("agent_end")({ messages: workerMessages(afterProposals, "complete") }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "needs_user");
  harness.cleanup();
});

test("expired leases cannot authorize model updates or run settlement", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const active = harness.storage.read(harness.ctx.cwd)!;
  const expiredAt = new Date(NOW.getTime() - 1);
  const expired = harness.storage.write({
    ...active,
    lease: {
      sessionId: "session-a",
      acquiredAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(),
      renewedAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(),
      expiresAt: expiredAt.toISOString(),
    },
  }, active.storageRevision, { type: "test_expired", at: NOW.toISOString() });

  const result = await harness.tools.get("update_goal").execute("call", { proposedStatus: "complete" }, undefined, undefined, harness.ctx);
  assert.deepEqual(result.details, { error: "no_pending_run" });
  await harness.handlers.get("agent_end")({ messages: workerMessages(expired, "continue") }, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.pendingRun?.candidate, undefined);
  harness.cleanup();
});

test("same-session expired pending run is cleared instead of becoming permanently stuck", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  harness.setNow(new Date(NOW.getTime() + 4 * 60 * 60 * 1000 + 1));

  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const goal = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(goal.status, "needs_user");
  assert.equal(goal.pendingRun, undefined);
  assert.equal(goal.lease, undefined);
  harness.cleanup();
});

test("agent_end ignores a normal user turn when a failed dispatch left a pending run", async () => {
  const harness = createHarness();
  harness.setThrowOnSend(true);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const pending = harness.storage.read(harness.ctx.cwd)!;

  await harness.handlers.get("agent_end")({
    messages: [
      { role: "user", content: "Please summarize the current goal." },
      ...workerMessages(pending, "continue").slice(1),
    ],
  }, harness.ctx);

  assert.equal(harness.storage.read(harness.ctx.cwd)?.pendingRun?.candidate, undefined);
  harness.cleanup();
});

test("session shutdown releases the lease and invalidates pending work", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);

  await harness.handlers.get("session_shutdown")({}, harness.ctx);

  const goal = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(goal.lease, undefined);
  assert.equal(goal.pendingRun, undefined);
  harness.cleanup();
});

test("fresh leases refuse mutations from another session", async () => {
  const first = createHarness("session-a");
  await first.commands.get("goal").handler("Ship safely", first.ctx);

  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const secondCtx: any = {
    ...first.ctx,
    ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
    sessionManager: { getSessionId: () => "session-b" },
  };
  createGoalLoopExtension({ storage: first.storage, config: { allowModelCreateGoal: false }, now: () => NOW })(
    { registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, command: any) { commands.set(name, command); }, on() {}, sendUserMessage() {} } as any,
  );
  await commands.get("goal").handler("pause", secondCtx);
  assert.equal(first.storage.read(first.ctx.cwd)?.status, "active");
  assert.match(notifications.at(-1) ?? "", /active in session session-/);
  first.cleanup();
});

test("pause releases the owner lease and edit dispatches a revised run", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Old objective", harness.ctx);
  await harness.commands.get("goal").handler("pause", harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.lease, undefined);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.pendingRun, undefined);

  await harness.commands.get("goal").handler("edit New objective", harness.ctx);
  const edited = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(edited.goalRevision, 2);
  assert.equal(edited.objective, "New objective");
  assert.ok(edited.pendingRun);
  assert.equal(harness.sent.length, 2);
  harness.cleanup();
});

test("send failures retain state and resume retries with fresh run IDs", async () => {
  const harness = createHarness();
  harness.setThrowOnSend(true);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const failedRun = harness.storage.read(harness.ctx.cwd)?.pendingRun?.runId;
  assert.ok(failedRun);
  assert.equal(harness.sent.length, 0);

  harness.setThrowOnSend(false);
  await harness.commands.get("goal").handler("resume", harness.ctx);
  const retriedRun = harness.storage.read(harness.ctx.cwd)?.pendingRun?.runId;
  assert.notEqual(retriedRun, failedRun);
  assert.equal(harness.sent.length, 1);
  harness.cleanup();
});

test("aborted runs block at settlement without retry", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const pending = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: [{ role: "user", content: `GOAL_LOOP_CONTINUATION_RUN: ${pending.pendingRun!.runId}` }, { role: "assistant", stopReason: "aborted", content: [] }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "blocked");
  assert.equal(harness.sent.length, 1);
  harness.cleanup();
});

test("sumAssistantUsage uses Pi totals without double-counting reasoning", () => {
  const usage = sumAssistantUsage([{
    role: "assistant",
    usage: RUN_USAGE,
    content: [],
  }]);
  assert.deepEqual(usage, {
    input: 10,
    output: 20,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 37,
    cost: { total: 0.037 },
  });
});

test("bare /goal reports local status and latest archived achievement", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("", harness.ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /No active goal/);

  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const goalId = await completeCurrentGoal(harness);

  assert.equal(harness.storage.read(harness.ctx.cwd), undefined);
  assert.equal(harness.storage.readLatestCompleted(harness.ctx.cwd)?.goalId, goalId);
  await harness.commands.get("goal").handler("", harness.ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /Latest achievement \(read-only\)/);

  const inspected = await harness.tools.get("get_goal").execute("call", {}, undefined, undefined, harness.ctx);
  assert.equal(inspected.details.goal, undefined);
  assert.equal(inspected.details.latestAchievement.goalId, goalId);
  assert.match(inspected.content[0].text, /No active goal/);
  const mutation = await harness.tools.get("update_goal").execute("call", { evidence: "must not mutate archive" }, undefined, undefined, harness.ctx);
  assert.deepEqual(mutation.details, { error: "missing_goal" });
  assert.equal(harness.storage.readLatestCompleted(harness.ctx.cwd)?.evidence.some((entry: any) => entry.summary === "must not mutate archive"), false);
  harness.cleanup();
});

test("archive failure retains an immutable completion receipt until archival is confirmed", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  await harness.tools.get("update_goal").execute("call", { evidence: "passed", evidenceKind: "verification", outcome: "passed" }, undefined, undefined, harness.ctx);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: completionMessages(goal) }, harness.ctx);
  const originalArchive = harness.storage.archive.bind(harness.storage);
  harness.storage.archive = () => { throw new Error("synthetic archive failure"); };

  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const retained = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(retained.status, "complete");
  assert.equal(harness.storage.readLatestCompleted(harness.ctx.cwd), undefined);
  for (const command of ["pause", "resume", "edit Mutated receipt", "budget 1", "verify npm test"]) {
    await harness.commands.get("goal").handler(command, harness.ctx);
    assert.deepEqual(harness.storage.read(harness.ctx.cwd), retained, command);
  }

  await harness.commands.get("goal").handler("Replacement before archive", harness.ctx);
  assert.deepEqual(harness.storage.read(harness.ctx.cwd), retained);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.notifications.at(-1)?.message ?? "", /archive receipt could not be persisted|completed receipt can be archived/i);

  harness.storage.archive = originalArchive;
  await harness.commands.get("goal").handler("Replacement after archive", harness.ctx);
  assert.equal(harness.storage.readLatestCompleted(harness.ctx.cwd)?.goalId, retained.goalId);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.objective, "Replacement after archive");
  harness.cleanup();
});

test("clear failure keeps the archived completion receipt immutable until safe replacement", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  await harness.tools.get("update_goal").execute("call", { evidence: "passed", evidenceKind: "verification", outcome: "passed" }, undefined, undefined, harness.ctx);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: completionMessages(goal) }, harness.ctx);
  harness.storage.clear = () => { throw new Error("synthetic clear failure"); };

  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const retained = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(retained.status, "complete");
  assert.equal(harness.storage.readLatestCompleted(harness.ctx.cwd)?.goalId, goal.goalId);
  for (const command of ["pause", "resume", "edit Mutated receipt", "budget 1", "verify npm test"]) {
    await harness.commands.get("goal").handler(command, harness.ctx);
    assert.deepEqual(harness.storage.read(harness.ctx.cwd), retained, command);
  }

  await harness.commands.get("goal").handler("Replacement objective", harness.ctx);
  assert.equal(harness.storage.readLatestCompleted(harness.ctx.cwd)?.goalId, retained.goalId);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.objective, "Replacement objective");
  harness.cleanup();
});

test("partial completion cleanup rejects edit and archives the retained receipt before starting over", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Original objective", harness.ctx);
  await acceptContinuation(harness);
  await harness.tools.get("update_goal").execute("call", { evidence: "passed", evidenceKind: "verification", outcome: "passed" }, undefined, undefined, harness.ctx);
  const completing = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: completionMessages(completing) }, harness.ctx);
  const originalClear = harness.storage.clear.bind(harness.storage);
  harness.storage.clear = () => { throw new Error("synthetic clear failure"); };
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const retained = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(retained.status, "complete");
  await harness.commands.get("goal").handler("edit Mutated receipt", harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.objective, "Original objective");
  assert.match(harness.notifications.at(-1)?.message ?? "", /cannot be edited.*start a new goal/i);

  harness.storage.clear = originalClear;
  const originalArchive = harness.storage.archive.bind(harness.storage);
  let archiveCalls = 0;
  let archivedBeforeReplacement = false;
  harness.storage.archive = (goal: any) => {
    archiveCalls += 1;
    archivedBeforeReplacement = harness.storage.read(harness.ctx.cwd)?.goalId === retained.goalId;
    return originalArchive(goal);
  };
  await harness.commands.get("goal").handler("Replacement objective", harness.ctx);

  assert.equal(archiveCalls, 1);
  assert.equal(archivedBeforeReplacement, true);
  assert.equal(harness.storage.readLatestCompleted(harness.ctx.cwd)?.goalId, retained.goalId);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.objective, "Replacement objective");
  harness.cleanup();
});

test("starting over archives a leftover completed active state before replacement", async () => {
  const harness = createHarness();
  const complete = harness.storage.write({ ...createGoal(harness.ctx.cwd, "Old achievement", NOW, "old-goal"), status: "complete" }, 0, { type: "test_complete", at: NOW.toISOString() });
  const originalArchive = harness.storage.archive.bind(harness.storage);
  let archivedBeforeWrite = false;
  harness.storage.archive = (goal: any) => {
    archivedBeforeWrite = harness.storage.read(harness.ctx.cwd)?.goalId === complete.goalId;
    return originalArchive(goal);
  };

  await harness.commands.get("goal").handler("New objective", harness.ctx);

  assert.equal(archivedBeforeWrite, true);
  assert.equal(harness.storage.readLatestCompleted(harness.ctx.cwd)?.goalId, "old-goal");
  assert.equal(harness.storage.read(harness.ctx.cwd)?.objective, "New objective");
  harness.cleanup();
});

test("/goal list discovers independent goals in distinct worktree roots", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("First worktree goal", harness.ctx);
  harness.ctx.cwd = "/repo/app-worktree-two";
  await harness.commands.get("goal").handler("Second worktree goal", harness.ctx);

  assert.equal(harness.storage.listActive().length, 2);
  await harness.commands.get("goal").handler("list", harness.ctx);
  const message = harness.notifications.at(-1)?.message ?? "";
  assert.match(message, /\/repo\/app \[active\]/);
  assert.match(message, /\/repo\/app-worktree-two \[active\]/);
  harness.cleanup();
});

test("token budgets stop continuation, gate resume, and remain human-owned", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship within budget", harness.ctx);
  await harness.commands.get("goal").handler("budget 37", harness.ctx);
  await acceptContinuation(harness);
  const active = harness.storage.read(harness.ctx.cwd)!;
  const system = await harness.handlers.get("before_agent_start")({ prompt: "normal", systemPrompt: "base", systemPromptOptions: { cwd: harness.ctx.cwd } }, harness.ctx);
  assert.match(system.systemPrompt, /token budget: 0\/37 tokens/i);
  await acceptContinuation(harness);
  await harness.handlers.get("agent_end")({ messages: workerMessages(active) }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const limited = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(limited.status, "token_budget_limited");
  assert.equal(limited.usage?.totalTokens, 37);
  assert.equal(limited.pendingRun, undefined);
  assert.equal(limited.lease, undefined);
  assert.equal(harness.sent.length, 1);

  await harness.commands.get("goal").handler("resume", harness.ctx);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.notifications.at(-1)?.message ?? "", /cannot resume/i);
  await harness.commands.get("goal").handler("budget 38", harness.ctx);
  await harness.commands.get("goal").handler("resume", harness.ctx);
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "active");
  assert.equal(harness.storage.read(harness.ctx.cwd)?.limitDetail, undefined);
  await harness.commands.get("goal").handler("budget off", harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.tokenBudget, undefined);
  harness.cleanup();
});

test("normal user turns never count toward autonomous goal usage", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "Explain status", systemPrompt: "base", systemPromptOptions: { cwd: harness.ctx.cwd } }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: [{ role: "user", content: "Explain status" }, { role: "assistant", usage: RUN_USAGE, stopReason: "stop", content: [] }] }, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.usage, undefined);
  harness.cleanup();
});

test("agent_end accounts autonomous usage once and settlement stays exactly once", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  const messages = workerMessages(goal);

  await harness.handlers.get("agent_end")({ messages }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages }, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.usage?.totalTokens, 37);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.usage?.totalTokens, 37);
  harness.cleanup();
});

test("a markerless successful Pi retry replaces the 429 error candidate and counts chain usage once", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  const runId = goal.pendingRun!.runId;
  await harness.handlers.get("after_provider_response")({ status: 429, headers: { "retry-after": "2" } }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: [{
    role: "user",
    content: `GOAL_LOOP_CONTINUATION_RUN: ${runId}`,
  }, {
    role: "assistant",
    usage: ERROR_USAGE,
    stopReason: "error",
    errorMessage: "429 Too Many Requests",
    timestamp: 1,
    content: [],
  }] }, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.pendingRun?.candidate?.source, "assistant_stop");
  assert.ok(harness.storage.read(harness.ctx.cwd)?.pendingRun?.providerUsageLimit);

  await harness.handlers.get("after_provider_response")({ status: 200, headers: {} }, harness.ctx);
  const retryMessages = workerMessages(goal).slice(1).map((message: any) => ({ ...message, timestamp: 2 }));
  await harness.handlers.get("agent_end")({ messages: retryMessages }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: retryMessages }, harness.ctx);

  const recovered = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(recovered.pendingRun?.candidate?.protocol, "valid");
  assert.equal(recovered.pendingRun?.providerUsageLimit, undefined);
  assert.equal(recovered.usage?.totalTokens, 40);
  assert.equal(recovered.usage?.cost.total, 0.04);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "active");
  assert.equal(harness.storage.read(harness.ctx.cwd)?.usage?.totalTokens, 40);
  assert.equal(harness.sent.length, 2);
  harness.cleanup();
});

test("a queued follow-up steers one combined Pi run, revokes authority, and preserves autonomous usage", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  const marker = workerMessages(goal)[0];
  await harness.handlers.get("message_start")({ message: marker }, harness.ctx);
  const accepted = await harness.tools.get("update_goal").execute("call", { evidence: "autonomous evidence" }, undefined, undefined, harness.ctx);
  assert.equal(accepted.details.goal.evidence.at(-1)?.summary, "autonomous evidence");

  const followUp = { role: "user", content: "Explain that result.", timestamp: 2 };
  await harness.handlers.get("message_start")({ message: followUp }, harness.ctx);
  const rejected = await harness.tools.get("update_goal").execute("call", { evidence: "follow-up mutation" }, undefined, undefined, harness.ctx);
  assert.deepEqual(rejected.details, { error: "no_pending_run" });

  const autonomousOutput = { ...workerMessages(goal, "continue", RUN_USAGE)[1], timestamp: 1 };
  const laterOutput = { ...workerMessages(goal, "blocked", ERROR_USAGE)[1], timestamp: 3 };
  await harness.handlers.get("agent_end")({ messages: [marker, autonomousOutput, followUp, laterOutput] }, harness.ctx);

  const interrupted = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(interrupted.pendingRun, undefined);
  assert.equal(interrupted.pendingSteer?.sessionId, "session-a");
  assert.equal(interrupted.steering.at(-1)?.text, "Explain that result.");
  assert.equal(interrupted.usage?.totalTokens, 37);
  assert.equal(interrupted.evidence.some((entry: any) => entry.summary === "follow-up mutation"), false);

  await harness.handlers.get("agent_settled")({}, harness.ctx);
  const settled = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(settled.status, "active");
  assert.ok(settled.pendingRun);
  assert.equal(settled.pendingSteer, undefined);
  assert.equal(settled.lease?.sessionId, "session-a");
  assert.equal(settled.usage?.totalTokens, 37);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1], /Explain that result\./);
  harness.cleanup();
});

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

test("a non-text queued follow-up durably interrupts and resumes the goal", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await acceptContinuation(harness);
  const followUp = { role: "user", content: [{ type: "image", data: "attachment" }] };

  await harness.handlers.get("message_start")({ message: followUp }, harness.ctx);

  const steered = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(steered.goalRevision, initial.goalRevision + 1);
  assert.equal(steered.pendingRun, undefined);
  assert.equal(steered.pendingSteer?.interruptedRunId, initial.pendingRun?.runId);
  assert.equal(steered.steering.at(-1)?.text, "User supplied a non-text follow-up.");

  await harness.handlers.get("agent_end")({ messages: [followUp] }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const resumed = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(resumed.status, "active");
  assert.ok(resumed.pendingRun);
  assert.equal(resumed.pendingSteer, undefined);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1], /User supplied a non-text follow-up\./);
  harness.cleanup();
});

test("manual resume consumes steering left pending while Pi was busy", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  await harness.handlers.get("message_start")({ message: { role: "user", content: "Keep headings unchanged" } }, harness.ctx);
  harness.setPendingMessages(true);

  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.ok(harness.storage.read(harness.ctx.cwd)?.pendingSteer);

  harness.setPendingMessages(false);
  await harness.commands.get("goal").handler("resume", harness.ctx);
  const resumed = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(resumed.pendingSteer, undefined);
  assert.ok(resumed.pendingRun);
  await acceptContinuation(harness);
  await harness.handlers.get("agent_end")({ messages: workerMessages(resumed, "continue") }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "active");
  assert.equal(harness.sent.length, 3);
  harness.cleanup();
});

test("independent evaluator receives every current-run verification proof", async () => {
  const evaluatorCalls: GoalEvaluatorInput[] = [];
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      evaluatorCalls.push(input);
      return { ok: true, record: evaluatorDecision(input, "complete", "All checks passed.") };
    },
  };
  const harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const commands = Array.from({ length: 11 }, (_, index) => `check-${index + 1}`);
  for (const command of commands) {
    await harness.tools.get("update_goal").execute("call", {
      verificationCommand: command,
      evidence: `${command} passed`,
      evidenceKind: "verification",
      command,
      outcome: "passed",
    }, undefined, undefined, harness.ctx);
  }
  const goal = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(goal, "complete") }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(evaluatorCalls.length, 1);
  assert.equal(evaluatorCalls[0].evidence.length, 10);
  assert.equal(evaluatorCalls[0].verificationProofs.length, 11);
  assert.deepEqual(evaluatorCalls[0].verificationProofs.map((proof) => proof.command), commands);
  harness.cleanup();
});

test("oversized persisted verification state fails closed before evaluator RPC", async () => {
  let evaluatorCalls = 0;
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      evaluatorCalls += 1;
      return { ok: true, record: evaluatorDecision(input, "continue", "More work remains.") };
    },
  };
  const harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);
  const candidate = harness.storage.read(harness.ctx.cwd)!;
  harness.storage.write({
    ...candidate,
    verification: {
      ...candidate.verification,
      commands: Array.from({ length: 51 }, (_, index) => `legacy-check-${index + 1}`),
    },
  }, candidate.storageRevision, { type: "legacy_oversized_fixture", at: NOW.toISOString() });

  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const stopped = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(evaluatorCalls, 0);
  assert.equal(stopped.status, "needs_user");
  assert.equal(stopped.pendingRun, undefined);
  assert.equal(stopped.lease, undefined);
  assert.match(stopped.lastEvaluation?.reason ?? "", /exceed evaluator input limits/i);
  harness.cleanup();
});

test("oversized persisted objective fails closed before evaluator RPC", async () => {
  let evaluatorCalls = 0;
  const evaluator: GoalEvaluator = {
    async evaluate(input) {
      evaluatorCalls += 1;
      return { ok: true, record: evaluatorDecision(input, "continue", "More work remains.") };
    },
  };
  const harness = createHarness("session-a", evaluator);
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const initial = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("agent_end")({ messages: workerMessages(initial, "continue") }, harness.ctx);
  const candidate = harness.storage.read(harness.ctx.cwd)!;
  harness.storage.write({ ...candidate, objective: "x".repeat(4_001) }, candidate.storageRevision, {
    type: "legacy_oversized_objective_fixture",
    at: NOW.toISOString(),
  });

  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const stopped = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(evaluatorCalls, 0);
  assert.equal(stopped.status, "needs_user");
  assert.equal(stopped.pendingRun, undefined);
  assert.match(stopped.lastEvaluation?.reason ?? "", /objective exceeds evaluator input limits/i);
  harness.cleanup();
});

test("a transient correlated 429 followed by a successful run continues", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("after_provider_response")({ status: 429, headers: { "retry-after": "2" } }, harness.ctx);
  await harness.handlers.get("after_provider_response")({ status: 200, headers: {} }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: workerMessages(goal) }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "active");
  assert.equal(harness.sent.length, 2);
  harness.cleanup();
});

test("a recovered 429 does not taint a later unrelated assistant error", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("after_provider_response")({ status: 429, headers: { "retry-after": "2" } }, harness.ctx);
  await harness.handlers.get("after_provider_response")({ status: 200, headers: {} }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: [{
    role: "user",
    content: `GOAL_LOOP_CONTINUATION_RUN: ${goal.pendingRun!.runId}`,
  }, {
    role: "assistant",
    usage: ERROR_USAGE,
    stopReason: "error",
    errorMessage: "unrelated assistant failure",
    timestamp: 4,
    content: [],
  }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const stopped = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(stopped.status, "blocked");
  assert.notEqual(stopped.status, "usage_limited");
  assert.equal(stopped.limitDetail, undefined);
  harness.cleanup();
});

for (const finalStatus of [500, 401]) {
  test(`a ${finalStatus} response after 429 is authoritative and remains a generic error`, async () => {
    const harness = createHarness();
    await harness.commands.get("goal").handler("Ship safely", harness.ctx);
    await acceptContinuation(harness);
    const goal = harness.storage.read(harness.ctx.cwd)!;
    await harness.handlers.get("after_provider_response")({ status: 429, headers: { "retry-after": "2" } }, harness.ctx);
    await harness.handlers.get("after_provider_response")({ status: finalStatus, headers: {} }, harness.ctx);
    await harness.handlers.get("agent_end")({ messages: [{
      role: "user",
      content: `GOAL_LOOP_CONTINUATION_RUN: ${goal.pendingRun!.runId}`,
    }, {
      role: "assistant",
      usage: ERROR_USAGE,
      stopReason: "error",
      errorMessage: `${finalStatus} provider error`,
      timestamp: finalStatus,
      content: [],
    }] }, harness.ctx);
    await harness.handlers.get("agent_settled")({}, harness.ctx);

    const stopped = harness.storage.read(harness.ctx.cwd)!;
    assert.equal(stopped.status, "blocked");
    assert.notEqual(stopped.status, "usage_limited");
    assert.equal(stopped.limitDetail, undefined);
    harness.cleanup();
  });
}

test("a correlated terminal 429 becomes usage_limited and generic error handling cannot overwrite it", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  await acceptContinuation(harness);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("after_provider_response")({ status: 429, headers: { "Retry-After": "5" } }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: [{
    role: "user",
    content: `GOAL_LOOP_CONTINUATION_RUN: ${goal.pendingRun!.runId}`,
  }, {
    role: "assistant",
    usage: RUN_USAGE,
    stopReason: "error",
    content: [],
  }] }, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "active");
  assert.match(harness.storage.read(harness.ctx.cwd)?.pendingRun?.providerUsageLimit?.reason ?? "", /Provider usage limit/);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  const limited = harness.storage.read(harness.ctx.cwd)!;
  assert.equal(limited.status, "usage_limited");
  assert.equal(limited.limitDetail?.retryAfter, "5");
  assert.equal(limited.pendingRun, undefined);
  assert.equal(limited.lease, undefined);
  assert.equal(limited.usage?.totalTokens, 37);
  await harness.commands.get("goal").handler("resume", harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "active");
  assert.equal(harness.storage.read(harness.ctx.cwd)?.limitDetail, undefined);
  assert.equal(harness.sent.length, 2);
  harness.cleanup();
});

test("an uncorrelated 429 does not change generic aborted-run handling", async () => {
  const harness = createHarness();
  await harness.commands.get("goal").handler("Ship safely", harness.ctx);
  const goal = harness.storage.read(harness.ctx.cwd)!;
  await harness.handlers.get("after_provider_response")({ status: 429, headers: { "retry-after": "5" } }, harness.ctx);
  await harness.handlers.get("agent_end")({ messages: [{
    role: "user",
    content: `GOAL_LOOP_CONTINUATION_RUN: ${goal.pendingRun!.runId}`,
  }, {
    role: "assistant",
    usage: RUN_USAGE,
    stopReason: "aborted",
    content: [],
  }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "blocked");
  harness.cleanup();
});

test("README documents hardened lifecycle and storage requirements", () => {
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  assert.match(readme, /Pi >=0\.80\.4/);
  assert.match(readme, /agent_settled/);
  assert.match(readme, /human-owned/);
  assert.match(readme, /normalized Pi working root/);
  assert.match(readme, /state\/<root-key>\.json/);
  assert.match(readme, /logs\/<root-key>\.jsonl/);
  assert.match(readme, /archive\/<root-key>\/<goal-id>\.json/);
  assert.match(readme, /distinct Git worktree root/);
  assert.match(readme, /subdirectory.*symlink/);
  assert.match(readme, /\/goal list/);
  assert.match(readme, /\/goal budget/);
  assert.match(readme, /usage_limited/);
  assert.match(readme, /token_budget_limited/);
  assert.match(readme, /4,000 characters/);
  assert.match(readme, /stop.*off.*reset.*none.*cancel/);
  assert.match(readme, /follow-up.*steer/i);
  assert.match(readme, /evaluates every settled autonomous run/i);
  assert.match(readme, /subagents:rpc:spawn/);
  assert.match(readme, /fails closed.*needs_user/i);
  assert.match(readme, /\/reload/);
});
