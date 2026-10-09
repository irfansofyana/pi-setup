import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { newRunIds, validateControl, validateLegacy, limits, backpressure } from "./contracts.ts";

const fixture = JSON.parse(readFileSync(new URL("./legacy-fixture.json", import.meta.url), "utf8"));
test("legacy fixture preserves installed tool keys and v2 event envelopes", () => {
  assert.deepEqual(Object.keys(fixture.tools.Agent.required), ["prompt", "description", "subagent_type"]);
  assert.deepEqual(fixture.tools.get_subagent_result, { agent_id: "string", wait: "boolean?", verbose: "boolean?" });
  assert.deepEqual(fixture.tools.steer_subagent, { agent_id: "string", message: "string" });
  assert.deepEqual(fixture.rpc, { version: 2, channels: ["subagents:rpc:ping", "subagents:rpc:spawn", "subagents:rpc:stop"], reply: "<channel>:reply:<requestId>", success: { success: true, data: { id: "agent-example" } }, failure: { success: false, error: "example error" } });
  assert.deepEqual(Object.keys(fixture.lifecycle.created), ["id", "type", "description", "isBackground"]);
  assert.deepEqual(Object.keys(fixture.lifecycle.settled), ["id", "type", "description", "result", "error", "status", "toolUses", "durationMs", "tokens", "usage"]);
});
test("new IDs are distinct, namespaced and control rejects stale run and unknown fields", () => {
  const ids = newRunIds(() => "fixed");
  assert.deepEqual(ids, { agentId: "agent-fixed", threadId: "thread-fixed", runId: "run-fixed", controlId: "control-fixed" });
  assert.deepEqual(validateControl({ version: 1, operation: "steer", threadId: ids.threadId, expectedRunId: ids.runId, message: "hi" }, ids.runId), { ok: true });
  assert.deepEqual(validateControl({ version: 1, operation: "steer", threadId: ids.threadId, expectedRunId: "run-other", message: "hi" }, ids.runId), { ok: false, code: "stale_run" });
  assert.deepEqual(validateControl({ version: 1, operation: "steer", threadId: "bad", expectedRunId: ids.runId, message: "hi" }, ids.runId), { ok: false, code: "invalid_request" });
  assert.deepEqual(validateControl({ version: 1, operation: "steer", threadId: ids.threadId, expectedRunId: ids.runId, message: "hi", model: "other" }, ids.runId), { ok: false, code: "unsupported_field" });
});
test("legacy fields validate without broadening v2 RPC or tool authority", () => {
  assert.deepEqual(validateLegacy("Agent", { prompt: "task", description: "inspect", subagent_type: "reviewer", max_turns: 2 }), { ok: true });
  assert.deepEqual(validateLegacy("Agent", { prompt: "task", description: "inspect", subagent_type: "reviewer", schedule: "* * * * *" }), { ok: false, code: "unsupported_field" });
  assert.deepEqual(validateLegacy("get_subagent_result", { agent_id: "agent-example", wait: true }), { ok: true });
  assert.deepEqual(validateLegacy("steer_subagent", { agent_id: "agent-example", message: "go", unknown: true }), { ok: false, code: "unsupported_field" });
  assert.deepEqual(validateLegacy("Agent", { prompt: "task", description: "inspect", subagent_type: "reviewer", model: "fuzzy" }), { ok: false, code: "invalid_request" });
  assert.deepEqual(validateLegacy("Agent", { prompt: "task", description: "inspect", subagent_type: "reviewer", thinking: 42 }), { ok: false, code: "invalid_request" });
  assert.deepEqual(validateLegacy("Agent", { prompt: "task", description: "inspect", subagent_type: "reviewer", isolated: true }), { ok: false, code: "invalid_request" });
  assert.deepEqual(validateLegacy("get_subagent_result", { agent_id: "agent-example", verbose: "yes" }), { ok: false, code: "invalid_request" });
  assert.deepEqual(validateLegacy("steer_subagent", { agent_id: "agent-example", message: 42 }), { ok: false, code: "invalid_request" });
});
test("capacity limits include encoded bytes, reservation backpressure never evicts unconsumed results", () => {
  assert.equal(limits.pendingRunsPerRoot, 32);
  assert.equal(limits.followUpsPerThread, 8);
  assert.equal(limits.queuedBytes, 1024 * 1024);
  assert.equal(limits.mailboxPerThread, 32);
  assert.equal(limits.mailboxBytesPerThread, 256 * 1024);
  assert.equal(limits.mailboxBytesTotal, 4 * 1024 * 1024);
  assert.equal(limits.threadsPerRoot, 16);
  assert.equal(limits.contextBytes, 128 * 1024);
  assert.equal(limits.inspectorBytesPerThread, 256 * 1024);
  assert.equal(limits.inspectorBytesTotal, 4 * 1024 * 1024);
  assert.equal(limits.resultSlots, 32);
  assert.equal(limits.resultBytesPerRun, 256 * 1024);
  assert.equal(limits.resultBytesTotal, 8 * 1024 * 1024);
  assert.deepEqual(backpressure("results", 32, 32), { ok: false, code: "backpressure", domain: "results", recovery: "consume_or_close" });
});