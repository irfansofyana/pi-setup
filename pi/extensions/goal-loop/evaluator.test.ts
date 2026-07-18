import test from "node:test";
import assert from "node:assert/strict";

import { createSubagentGoalEvaluator, type GoalEvaluatorInput } from "./evaluator.ts";

type Handler = (value: unknown) => void;

function createEventBus() {
  const listeners = new Map<string, Set<Handler>>();
  return {
    on(event: string, handler: Handler): () => void {
      const handlers = listeners.get(event) ?? new Set<Handler>();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    },
    emit(event: string, value: unknown): void {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(value);
    },
  };
}

const input: GoalEvaluatorInput = {
  goalId: "goal-1",
  goalRevision: 1,
  runId: "run-1",
  evaluationRequestId: "eval-1",
  objective: "Ship a verified goal loop",
  steering: [],
  verificationCommands: ["npm test"],
  evidence: [],
  transcriptExcerpt: "Worker reports that the focused tests pass.",
  worker: {
    goalId: "goal-1",
    goalRevision: 1,
    runId: "run-1",
    evaluationRequestId: "eval-1",
    decision: "complete",
    reason: "Implementation and tests are done.",
    confidence: "medium",
  },
  cwd: "/tmp/project",
};

test("evaluates a run through correlated subagent RPC events", async () => {
  const events = createEventBus();
  events.on("subagents:rpc:ping", (raw) => {
    const requestId = (raw as { requestId: string }).requestId;
    events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });
  events.on("subagents:rpc:spawn", (raw) => {
    const requestId = (raw as { requestId: string }).requestId;
    events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: "agent-1" } });
    queueMicrotask(() => events.emit("subagents:completed", {
      id: "agent-1",
      result: `GOAL_EVALUATOR_DECISION: ${JSON.stringify({
        goalId: "goal-1",
        goalRevision: 1,
        runId: "run-1",
        evaluationRequestId: "eval-1",
        decision: "complete",
        reason: "Evidence supports completion.",
        confidence: "high",
      })}`,
    }));
  });

  const result = await createSubagentGoalEvaluator({ events }, { timeoutMs: 100 }).evaluate(input);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.decision, "complete");
});

test("fails closed when evaluator RPC is unavailable", async () => {
  const result = await createSubagentGoalEvaluator(
    { events: createEventBus() },
    { timeoutMs: 5 },
  ).evaluate(input);

  assert.deepEqual(result, { ok: false, reason: "Goal evaluator RPC did not respond." });
});

test("ignores terminal events from an unrelated subagent", async () => {
  const events = createEventBus();
  events.on("subagents:rpc:ping", (raw) => {
    const requestId = (raw as { requestId: string }).requestId;
    events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });
  events.on("subagents:rpc:spawn", (raw) => {
    const requestId = (raw as { requestId: string }).requestId;
    events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: "agent-1" } });
    queueMicrotask(() => events.emit("subagents:completed", { id: "agent-other", result: "wrong agent" }));
  });

  const result = await createSubagentGoalEvaluator({ events }, { timeoutMs: 5 }).evaluate(input);

  assert.deepEqual(result, { ok: false, reason: "Goal evaluator timed out." });
});
