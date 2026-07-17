import test from "node:test";
import assert from "node:assert/strict";

import { parseCurrentRunCandidate } from "./evaluation.ts";

const EXPECTED = {
  goalId: "goal-1",
  goalRevision: 1,
  runId: "run-1",
  evaluationRequestId: "eval-1",
};

test("parses one exact current-run worker decision", () => {
  const result = parseCurrentRunCandidate([
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `done\nGOAL_WORKER_DECISION: ${JSON.stringify({
            ...EXPECTED,
            decision: "continue",
            reason: "still working",
          })}`,
        },
      ],
    },
  ], EXPECTED);

  assert.equal(result.protocol, "valid");
  assert.equal(result.worker?.decision, "continue");
});

test("evaluator markers override worker markers", () => {
  const result = parseCurrentRunCandidate([
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-eval",
        name: "Agent",
        arguments: {
          description: "Evaluate goal status",
          prompt: `Evaluation request: ${EXPECTED.evaluationRequestId}`,
        },
      }],
    },
    {
      role: "toolResult",
      toolName: "Agent",
      toolCallId: "call-eval",
      content: [{
        type: "text",
        text: `GOAL_EVALUATOR_DECISION: ${JSON.stringify({
          ...EXPECTED,
          decision: "continue",
          reason: "verification missing",
          confidence: "high",
        })}`,
      }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            `GOAL_WORKER_DECISION: ${JSON.stringify({
              ...EXPECTED,
              decision: "complete",
              reason: "looks done",
            })}`,
          ].join("\n"),
        },
      ],
    },
  ], EXPECTED);

  assert.equal(result.protocol, "valid");
  assert.equal(result.evaluator?.decision, "continue");
});

test("rejects markers without the exact prefix spacing", () => {
  const result = parseCurrentRunCandidate([
    {
      role: "assistant",
      content: [{
        type: "text",
        text: `GOAL_WORKER_DECISION:${JSON.stringify({ ...EXPECTED, decision: "continue", reason: "still working" })}`,
      }],
    },
  ], EXPECTED);

  assert.equal(result.protocol, "malformed");
});

test("rejects decision examples inside Markdown fences", () => {
  const result = parseCurrentRunCandidate([
    {
      role: "assistant",
      content: [{
        type: "text",
        text: [
          "```text",
          `GOAL_WORKER_DECISION: ${JSON.stringify({ ...EXPECTED, decision: "continue", reason: "example only" })}`,
          "```",
        ].join("\n"),
      }],
    },
  ], EXPECTED);

  assert.equal(result.protocol, "malformed");
});

test("mismatched ids are rejected as stale", () => {
  const result = parseCurrentRunCandidate([
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `GOAL_WORKER_DECISION: ${JSON.stringify({
            ...EXPECTED,
            runId: "run-2",
            decision: "continue",
            reason: "wrong run",
          })}`,
        },
      ],
    },
  ], EXPECTED);

  assert.equal(result.protocol, "stale");
});

test("duplicate worker decisions are rejected", () => {
  const result = parseCurrentRunCandidate([
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            `GOAL_WORKER_DECISION: ${JSON.stringify({
              ...EXPECTED,
              decision: "continue",
              reason: "first",
            })}`,
            `GOAL_WORKER_DECISION: ${JSON.stringify({
              ...EXPECTED,
              decision: "continue",
              reason: "second",
            })}`,
          ].join("\n"),
        },
      ],
    },
  ], EXPECTED);

  assert.equal(result.protocol, "duplicate");
});

test("missing protocol falls back safely", () => {
  const result = parseCurrentRunCandidate([
    {
      role: "assistant",
      content: [{ type: "text", text: "plain assistant text with no decision" }],
    },
  ], EXPECTED);

  assert.equal(result.protocol, "missing");
});

test("ignores evaluator output from unrelated Agent calls", () => {
  const result = parseCurrentRunCandidate([
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-unrelated",
        name: "Agent",
        arguments: { description: "Other work", prompt: "unrelated" },
      }],
    },
    {
      role: "toolResult",
      toolName: "Agent",
      toolCallId: "call-unrelated",
      content: [{ type: "text", text: "GOAL_EVALUATOR_DECISION: {not-json" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: `GOAL_WORKER_DECISION: ${JSON.stringify({ ...EXPECTED, decision: "continue", reason: "still working" })}` }],
    },
  ], EXPECTED);

  assert.equal(result.protocol, "valid");
  assert.equal(result.evaluator, undefined);
});
