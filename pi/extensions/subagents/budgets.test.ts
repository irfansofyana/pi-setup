import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupervisor } from "./supervisor.ts";

const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const message = (id: string, u = usage(1)) => ({ type: "message_end", message: { role: "assistant", id, usage: u } });
function fixture(budget: { softTurns: number; hardTurns: number; maxTokens?: number; maxCost?: number; elapsedMs?: number }, extra: Record<string, unknown> = {}) {
  let n = 0; const runs: { prompt: string; emit: (event: any) => void; resolve: (result: {outcome: "completed"; complete: true}) => void }[] = [];
  const aborts: number[] = [], steers: string[] = [];
  const fleet = createSupervisor({ nextId: () => String(++n), budget, ...extra, createBackend: async () => ({
    run(prompt: string, emit: (event: any) => void) { return new Promise<{outcome: "completed"; complete: true}>(resolve => runs.push({ prompt, emit, resolve })); },
    async abort() { aborts.push(runs.length); }, async dispose() {},
    async steer(text: string) { steers.push(text); return { status: "queued" as const }; },
  }) });
  return { fleet, runs, aborts, steers };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("a final stop exactly at the hard ceiling succeeds but cannot buy a follow-up",async()=>{
 const h=fixture({softTurns:2,hardTurns:2},{evaluatorSupported:true});
 const a=await h.fleet.start({prompt:"evaluate",evaluator:true});await tick();
 h.runs[0].emit(message("first"));h.runs[0].emit({...message("final"),message:{...message("final").message,stopReason:"stop"}});
 h.runs[0].resolve({outcome:"completed",complete:true});
 assert.equal((await h.fleet.wait([a.runId]))[0].outcome,"completed");assert.deepEqual(h.aborts,[]);await tick();
 const next=await h.fleet.control({version:1,operation:"follow_up",threadId:a.threadId,message:"more"});assert.equal(next.status,"rejected");await h.fleet.dispose();
});

test("role ceiling cannot be enlarged by invocation, and soft turn requests wrap-up before hard stop", async () => {
  const h = fixture({ softTurns: 3, hardTurns: 5 });
  assert.equal((await h.fleet.start({ prompt: "bad", maxTurns: 4 })).ok, false);
  const a = await h.fleet.start({ prompt: "one", maxTurns: 2 }); await tick();
  h.runs[0].emit(message("one")); assert.deepEqual(h.steers, []);
  h.runs[0].emit(message("two")); await tick(); assert.equal(h.steers.length, 1);
  h.runs[0].emit(message("three")); assert.deepEqual(h.aborts, []);
  h.runs[0].emit(message("four")); h.runs[0].emit(message("five")); await tick(); assert.deepEqual(h.aborts, [1]);
  h.runs[0].resolve({ outcome: "completed", complete: true });
  assert.equal((await h.fleet.wait([a.runId]))[0].outcome, "budget_exhausted"); await h.fleet.dispose();
});

test("finalized native usage deduplicates run/message identities, preserves cache categories and never resets on follow-up", async () => {
  const h = fixture({ softTurns: 10, hardTurns: 15, maxTokens: 12 });
  const a = await h.fleet.start({ prompt: "one" }); await tick();
  h.runs[0].emit(message("m1", usage(2, 1, 3, 1, 0.2)));
  h.runs[0].emit(message("m1", usage(2, 1, 3, 1, 0.2)));
  assert.deepEqual(h.fleet.inspect(a.threadId)?.usage, { input: 2, output: 1, cacheRead: 3, cacheWrite: 1, totalTokens: 7, cost: 0.2 });
  h.runs[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick();
  const b = await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "two" }); await tick();
  h.runs[1].emit(message("m1", usage(1, 1, 0, 0, 0.1))); // same message ID in a different run
  h.runs[1].emit(message("m2", usage(3, 1, 0, 0, 0.1)));
  await tick(); assert.deepEqual(h.aborts, [2]);
  assert.equal(h.fleet.inspect(a.threadId)?.usage.totalTokens, 13);
  h.runs[1].resolve({ outcome: "completed", complete: true });
  const final=(await h.fleet.wait([b.runId!]))[0];
  assert.equal(final.outcome, "budget_exhausted");assert.equal(final.usage?.totalTokens,6);assert.equal(final.turns,2);await h.fleet.dispose();
});

test("descendant-tagged finalized events do not inflate parent accounting", async () => {
  const h = fixture({ softTurns: 10, hardTurns: 15, maxTokens: 3 });
  const a = await h.fleet.start({ prompt: "parent" }); await tick();
  h.runs[0].emit({ ...message("child", usage(100)), runId: "run-descendant" });
  h.runs[0].emit(message("parent", usage(1)));
  assert.equal(h.fleet.inspect(a.threadId)?.usage.totalTokens, 1);
  assert.deepEqual(h.aborts, []);
  h.runs[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await h.fleet.dispose();
});

test("follow-up cannot reset the shared turn ceiling", async () => {
  const h = fixture({ softTurns: 2, hardTurns: 3 });
  const a = await h.fleet.start({ prompt: "one" }); await tick();
  h.runs[0].emit(message("a")); h.runs[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick();
  const b = await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "two" }); await tick();
  h.runs[1].emit(message("b")); await tick(); assert.equal(h.steers.length, 1);
  h.runs[1].emit(message("c")); await tick(); assert.deepEqual(h.aborts, [2]);
  h.runs[1].resolve({ outcome: "completed", complete: true });
  assert.equal((await h.fleet.wait([b.runId!]))[0].outcome, "budget_exhausted"); await h.fleet.dispose();
});

test("missing or malformed finalized usage fails closed under observed token/cost threshold", async () => {
  const h = fixture({ softTurns: 10, hardTurns: 15, maxCost: 1 });
  const a = await h.fleet.start({ prompt: "one" }); await tick();
  h.runs[0].emit({ type: "message_end", message: { role: "assistant", id: "m1" } }); await tick();
  assert.deepEqual(h.aborts, [1]); h.runs[0].resolve({ outcome: "completed", complete: true });
  assert.equal((await h.fleet.wait([a.runId]))[0].outcome, "budget_exhausted"); await h.fleet.dispose();
});

test("completed backend without any finalized usage fails closed when accounting was required", async () => {
  const h = fixture({ softTurns: 10, hardTurns: 15, maxTokens: 5 });
  const a = await h.fleet.start({ prompt: "no usage" }); await tick();
  h.runs[0].resolve({ outcome: "completed", complete: true });
  assert.equal((await h.fleet.wait([a.runId]))[0].outcome, "budget_exhausted"); await h.fleet.dispose();
});

test("elapsed deadline aborts active backend but retains slot until settlement", async () => {
  const h = fixture({ softTurns: 10, hardTurns: 15, elapsedMs: 1 }, { concurrency: 1 });
  const a = await h.fleet.start({ prompt: "one" }), b = await h.fleet.start({ prompt: "two" });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.deepEqual(h.aborts, [1]); assert.equal(h.fleet.inspect(b.threadId)?.state, "queued");
  h.runs[0].resolve({ outcome: "completed", complete: true }); assert.equal((await h.fleet.wait([a.runId]))[0].outcome, "budget_exhausted");
  await tick(); h.runs[1].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([b.runId]); await h.fleet.dispose();
});

test("elapsed deadline is shared across follow-ups rather than reset", async () => {
  let now = 0;
  const h = fixture({ softTurns: 10, hardTurns: 15, elapsedMs: 1000 }, { now: () => now });
  const a = await h.fleet.start({ prompt: "one" }); await tick();
  h.runs[0].emit(message("a")); h.runs[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick();
  now = 900;
  const b = await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "two" }); await tick();
  now = 1100; await new Promise(resolve => setTimeout(resolve, 120)); assert.deepEqual(h.aborts, [2]);
  h.runs[1].resolve({ outcome: "completed", complete: true });
  assert.equal((await h.fleet.wait([b.runId!]))[0].outcome, "budget_exhausted"); await h.fleet.dispose();
});

test("evaluator request cannot enlarge a stricter canonical ceiling", async () => {
  const e = fixture({ softTurns: 1, hardTurns: 1 }, { evaluatorSupported: true });
  assert.equal((await e.fleet.start({ prompt: "evaluate", evaluator: true })).ok, false);
  await e.fleet.dispose();
});

test("evaluator hard-two mode is unavailable without explicit support, and has no grace when supported", async () => {
  const h = fixture({ softTurns: 10, hardTurns: 15 });
  assert.equal((await h.fleet.start({ prompt: "evaluate", evaluator: true })).ok, false);
  await h.fleet.dispose();
  const e = fixture({ softTurns: 10, hardTurns: 15 }, { evaluatorSupported: true });
  const a = await e.fleet.start({ prompt: "evaluate", evaluator: true }); await tick();
  e.runs[0].emit(message("1")); e.runs[0].emit(message("2")); await tick(); assert.deepEqual(e.aborts, [1]);
  e.runs[0].resolve({ outcome: "completed", complete: true }); assert.equal((await e.fleet.wait([a.runId]))[0].outcome, "budget_exhausted"); await e.fleet.dispose();
});
