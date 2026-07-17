import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContinuationPrompt,
  buildGoalSystemPrompt,
  createGoal,
  createGoalLoopExtension,
  goalKey,
  goalStatusText,
  normalizeGoalLoopConfig,
  normalizeGoalState,
  parseGoalArgs,
  recordEvidence,
  resumeGoal,
  shouldAutoContinue,
} from "./index.ts";
import { createGoalStorage } from "./storage.ts";

const NOW = new Date("2026-07-12T00:00:00.000Z");

function createHarness(session = "session-a") {
  const root = mkdtempSync(join(tmpdir(), "goal-loop-index-"));
  const storage = createGoalStorage({
    storageRoot: join(root, "state"),
    legacyStatePath: join(root, "legacy", "state.json"),
    auditRoot: join(root, "logs"),
    corruptRoot: join(root, "corrupt"),
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
  createGoalLoopExtension({ storage, config: { allowModelCreateGoal: false }, now: () => currentNow, randomId: () => `id-${++id}` })(api as any);
  return {
    root, storage, tools, commands, handlers, sent, notifications, ctx,
    setIdle(value: boolean) { idle = value; },
    setPendingMessages(value: boolean) { pendingMessages = value; },
    setThrowOnSend(value: boolean) { throwOnSend = value; },
    setNow(value: Date) { currentNow = value; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function workerMessages(goal: any, decision: "complete" | "continue" | "blocked" | "needs_user" = "continue") {
  const pending = goal.pendingRun;
  return [{
    role: "user",
    content: `GOAL_LOOP_CONTINUATION_RUN: ${pending.runId}`,
  }, {
    role: "assistant",
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

async function acceptContinuation(harness: ReturnType<typeof createHarness>) {
  const continuation = harness.sent.at(-1)!;
  return harness.handlers.get("before_agent_start")({
    prompt: continuation,
    systemPrompt: "base",
    systemPromptOptions: { cwd: harness.ctx.cwd },
  }, harness.ctx);
}

test("parseGoalArgs handles objectives and subcommands", () => {
  assert.deepEqual(parseGoalArgs("ship the README update"), { command: "start", value: "ship the README update" });
  assert.deepEqual(parseGoalArgs("verify npm test"), { command: "verify", value: "npm test" });
  assert.deepEqual(parseGoalArgs("pause"), { command: "pause", value: "" });
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
    verification: { commands: ["npm test"] },
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
  await harness.handlers.get("agent_end")({ messages: [{ role: "user", content: `GOAL_LOOP_CONTINUATION_RUN: ${pending.pendingRun.runId}` }, { role: "assistant", stopReason: "aborted", content: [] }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.storage.read(harness.ctx.cwd)?.status, "blocked");
  assert.equal(harness.sent.length, 1);
  harness.cleanup();
});

test("README documents hardened lifecycle and storage requirements", () => {
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  assert.match(readme, /Pi >=0\.80\.4/);
  assert.match(readme, /agent_settled/);
  assert.match(readme, /human-owned/);
  assert.match(readme, /state\/<project-key>\.json/);
  assert.match(readme, /logs\/<project-key>\.jsonl/);
  assert.match(readme, /\/reload/);
});
