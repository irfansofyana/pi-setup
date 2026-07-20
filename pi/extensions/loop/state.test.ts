import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LOOP_INTERVAL_MS,
  advanceFixedDeadline,
  parseDurationToken,
  parseLoopArgs,
  parseWakeIntent,
} from "./state.ts";

test("parseLoopArgs recognizes strict public grammar", () => {
  assert.deepEqual(parseLoopArgs(""), { kind: "status" });
  assert.deepEqual(parseLoopArgs("stop"), { kind: "stop" });
  assert.deepEqual(parseLoopArgs("5m check deploy"), {
    kind: "start",
    prompt: "check deploy",
    mode: { kind: "fixed", intervalMs: 300_000, intervalText: "5m" },
  });
  assert.deepEqual(parseLoopArgs("work until tests pass"), {
    kind: "start",
    prompt: "work until tests pass",
    mode: { kind: "dynamic" },
  });
});

test("natural interval forms map to fixed scheduling", () => {
  assert.equal(parseDurationToken("5m"), 300_000);
  assert.equal(parseDurationToken("0m"), undefined);
  assert.equal(parseDurationToken("1.5m"), undefined);
  assert.equal(parseDurationToken("every5m"), undefined);
  assert.equal(parseDurationToken(`${MAX_LOOP_INTERVAL_MS + 1}s`), undefined);
  assert.equal(parseLoopArgs("5m").kind, "error");
  assert.equal(parseLoopArgs("0m check").kind, "error");
  assert.equal(parseLoopArgs("8d check").kind, "error");
  assert.equal(parseLoopArgs("1.5m check").kind, "error");
  assert.deepEqual(parseLoopArgs("every 5 minutes check deploy"), {
    kind: "start",
    prompt: "check deploy",
    mode: { kind: "fixed", intervalMs: 300_000, intervalText: "5m" },
  });
  assert.deepEqual(parseLoopArgs("check deploy every 2 hours"), {
    kind: "start",
    prompt: "check deploy",
    mode: { kind: "fixed", intervalMs: 7_200_000, intervalText: "2h" },
  });
  assert.deepEqual(parseLoopArgs("30 seconds check deploy"), {
    kind: "start",
    prompt: "check deploy",
    mode: { kind: "fixed", intervalMs: 30_000, intervalText: "30s" },
  });
  assert.deepEqual(parseLoopArgs("STOP"), { kind: "stop" });
});

test("parseWakeIntent requires exactly one bounded wake source", () => {
  assert.deepEqual(parseWakeIntent({ delaySeconds: 60, reason: "retry" }), {
    kind: "time",
    delaySeconds: 60,
    reason: "retry",
  });
  assert.deepEqual(parseWakeIntent({ subagentId: "agent-1" }), {
    kind: "subagent",
    subagentId: "agent-1",
    reason: undefined,
  });
  assert.deepEqual(parseWakeIntent({ filePath: "dist/result.json", fileEvent: "create" }), {
    kind: "file",
    filePath: "dist/result.json",
    fileEvent: "create",
    reason: undefined,
  });
  assert.deepEqual(parseWakeIntent({ eventName: "monitor:done", correlationId: "run-1" }), {
    kind: "event",
    eventName: "monitor:done",
    correlationId: "run-1",
    reason: undefined,
  });
  assert.match((parseWakeIntent({}) as { error: string }).error, /exactly one/);
  assert.match((parseWakeIntent({ delaySeconds: 1, subagentId: "a" }) as { error: string }).error, /exactly one/);
  assert.match((parseWakeIntent({ delaySeconds: 0 }) as { error: string }).error, /between/);
  assert.match((parseWakeIntent({ eventName: "arbitrary:event", correlationId: "x" }) as { error: string }).error, /eventName/);
  assert.match((parseWakeIntent({ filePath: "x", fileEvent: "chmod" }) as { error: string }).error, /fileEvent/);
});

test("advanceFixedDeadline preserves cadence and skips missed bursts", () => {
  assert.equal(advanceFixedDeadline(1_000, 1_000, 500), 1_000);
  assert.equal(advanceFixedDeadline(1_000, 1_000, 1_000), 2_000);
  assert.equal(advanceFixedDeadline(1_000, 1_000, 3_500), 4_000);
});
