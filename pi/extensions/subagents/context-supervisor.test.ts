import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSupervisor } from "./supervisor.ts";

test("opt-in supervisor snapshot is frozen before queue admission and passes only selected context to backend", async () => {
  const source = SessionManager.inMemory("/fixture");
  const anchor = source.appendMessage({ role: "user", content: "selected", timestamp: 1 });
  let serial = 0; const observed: any[] = [];
  const fleet = createSupervisor({ nextId: () => String(++serial), resolveSource: () => source, createBackend: async (context: any) => {
    observed.push(context);
    return { async run() { return { outcome: "completed" as const, complete: true }; }, async abort() {}, async dispose() {} };
  } });
  try {
    const request = { mode: "snapshot", sourceSessionId: source.getSessionId(), branchLeafId: anchor, entryAnchorId: anchor };
    const started = await fleet.start({ prompt: "task", role: "code-mapper", context: request });
    assert.equal(started.ok, true);
    source.appendMessage({ role: "user", content: "late secret", timestamp: 2 });
    assert.equal((await fleet.wait([started.runId]))[0].outcome, "completed");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].entryAnchorId, anchor);
    assert.doesNotMatch(JSON.stringify(observed[0]), /late secret/);
    assert.equal(fleet.inspect(started.threadId)?.context?.entryAnchorId, anchor);
    const fresh = await fleet.start({ prompt: "fresh" });
    await fleet.wait([fresh.runId]);
    assert.equal(observed[1], undefined);
  } finally { await fleet.dispose(); }
});

test("invalid context and unsupported fork reject before backend, identity and reservation", async () => {
  const source = SessionManager.inMemory("/fixture");
  const anchor = source.appendMessage({ role: "user", content: "ok", timestamp: 1 });
  let serial = 0, calls = 0;
  const fleet = createSupervisor({ nextId: () => String(++serial), resolveSource: () => source, createBackend: async () => { calls++; throw new Error("unexpected"); } });
  const context = { mode: "snapshot", sourceSessionId: source.getSessionId(), branchLeafId: anchor, entryAnchorId: anchor };
  assert.deepEqual(await fleet.start({ prompt: "x", role: "researcher", context }), { ok: false, code: "privacy_sensitive_context" });
  assert.deepEqual(await fleet.start({ prompt: "x", role: "code-mapper", context: { ...context, mode: "fork" } }), { ok: false, code: "unsupported_fork" });
  assert.deepEqual(await fleet.start({ prompt: "x", role: "code-mapper", context: { ...context, entryAnchorId: "missing" } }), { ok: false, code: "invalid_context" });
  assert.equal(serial, 0); assert.equal(calls, 0);
  await fleet.dispose();
});

test("resume requires retained live context, allocates new run and never revives interrupted session", async () => {
  let serial = 0; const prompts: string[] = [];
  const fleet = createSupervisor({ nextId: () => String(++serial), createBackend: async () => ({ hasRetainedContext() { return true; }, async run(prompt: string) { prompts.push(prompt); return { outcome: "completed" as const, complete: true }; }, async abort() {}, async dispose() {} }) });
  try {
    const first = await fleet.start({ prompt: "one" }); await fleet.wait([first.runId]);
    const resumed = await fleet.control({ version: 1, operation: "resume", threadId: first.threadId, message: "two" });
    assert.equal(resumed.status, "queued"); assert.notEqual(resumed.runId, first.runId);
    assert.equal((await fleet.wait([resumed.runId!]))[0].outcome, "completed");
    assert.deepEqual(prompts, ["one", "two"]);
    assert.equal((await fleet.control({ version: 1, operation: "resume", threadId: first.threadId })).error?.code, "invalid_request");
  } finally { await fleet.dispose(); }
});

test("resume fails closed when backend has no authoritative retained context", async () => {
  let serial = 0;
  const fleet = createSupervisor({ nextId: () => String(++serial), createBackend: async () => ({ async run() { return { outcome: "completed" as const, complete: true }; }, async abort() {}, async dispose() {} }) });
  try {
    const first = await fleet.start({ prompt: "one" }); await fleet.wait([first.runId]);
    assert.equal((await fleet.control({ version: 1, operation: "resume", threadId: first.threadId, message: "two" })).error?.code, "unsupported_field");
  } finally { await fleet.dispose(); }
});
