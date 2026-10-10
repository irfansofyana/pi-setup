import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupervisor } from "./supervisor.ts";
test("hung initialization has a bounded drain failure, quarantines admission and never frees the unresolved slot",async()=>{
 let n=0,release:any;const setup=new Promise<any>(resolve=>release=resolve);
 const supervisor=createSupervisor({nextId:()=>String(++n),cleanupMs:10,createBackend:async()=>setup});
 const accepted=await supervisor.start({prompt:"waiting"});await new Promise<void>(resolve=>setImmediate(resolve));
 const closing=supervisor.dispose().then(()=>undefined,error=>error);
 try{const error=await Promise.race([closing,new Promise(resolve=>setTimeout(()=>resolve(undefined),70))]);assert.match(String(error),/quarantined|unconfirmed/);assert.equal(supervisor.inspect(accepted.threadId)?.state,"quarantined");assert.equal((await supervisor.start({prompt:"late"})).ok,false);}
 finally{release({run:async()=>({outcome:"completed",complete:true}),abort:async()=>{},dispose:async()=>{}});await closing;await supervisor.wait([accepted.runId]);}
});

test("terminal result retains actual settled artifact references without deleting the worktree",async()=>{
  let n=0;
  const artifact={path:"/fixture/worktree",repo:"/fixture/repo",branch:"pi-subagent/fixture",base:"a".repeat(40),commit:"a".repeat(40),dirty:true,status:"M file.txt",diff:"file.txt | 1 +",truncated:false,files:["file.txt"]};
  const supervisor=createSupervisor({nextId:()=>String(++n),createBackend:async()=>({run:async()=>({outcome:"completed",complete:true}),abort:async()=>{},dispose:async()=>{},artifacts:async()=>[Object.freeze(artifact)]})});
  try{const accepted=await supervisor.start({prompt:"edit"});assert.equal(accepted.ok,true);if(!accepted.ok)return;
    const [result]=await supervisor.wait([accepted.runId]);assert.equal(result.artifacts?.[0].path,"/fixture/worktree");assert.equal(result.artifacts?.[0].dirty,true);}
  finally{await supervisor.dispose();}
});

type Event = { type: string; text?: string; assistantMessageEvent?: { type: string; delta: string } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness(options: { concurrency?: number; pending?: number; slots?: number; bytes?: number } = {}) {
  const gates: ReturnType<typeof deferred<{ outcome: "completed"; complete: true }>>[] = [];
  const started: string[] = [], aborted: number[] = [], disposed: number[] = [], messages: string[] = [], steers: string[] = [];
  let backendNumber = 0, running = 0, maxRunning = 0;
  const fleet = createSupervisor({ ...options, nextId: (() => { let n = 0; return () => String(++n); })(),
    createBackend: async () => {
      const i = backendNumber++;
      return { async run(prompt: string, emit: (e: Event) => void) { const gate = deferred<{ outcome: "completed"; complete: true }>(); gates.push(gate); started.push(prompt); running++; maxRunning = Math.max(maxRunning, running); emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: prompt }, text: prompt }); try { return await gate.promise; } finally { running--; } },
        async message(text: string) { messages.push(text); return { status: "unknown_delivery" as const }; },
        async steer(text: string) { steers.push(text); return { status: "queued" as const }; },
        async abort() { aborted.push(i); }, async dispose() { disposed.push(i); } };
    } });
  return { fleet, gates, started, aborted, disposed, messages, steers, get maxRunning() { return maxRunning; } };
}
async function tick() { await new Promise<void>(r => setImmediate(r)); }

test("exact-run inspection distinguishes a queued continuation from its running predecessor",async()=>{
 const gate=deferred<{outcome:"completed";complete:true}>();let n=0;
 const fleet=createSupervisor({nextId:()=>String(++n),createBackend:async()=>({run:async()=>gate.promise,abort:async()=>{},dispose:async()=>{}})});
 try{
  const first=await fleet.start({prompt:"first"});await tick();
  const next=await fleet.control({version:1,operation:"follow_up",threadId:first.threadId,message:"second"});
  const inspected=fleet.inspect(first.threadId,next.runId);
  assert.equal(inspected?.runId,next.runId);assert.equal(inspected?.state,"queued");
  assert.equal(fleet.inspect(first.threadId,"unrelated"),undefined);
 }finally{gate.resolve({outcome:"completed",complete:true});await fleet.dispose();}
});

test("single FIFO admission queue bounds execution and correlates events and immutable results", async () => {
  const h = harness({ concurrency: 1 }); const events: any[] = []; h.fleet.subscribe(e => events.push(e));
  const a = await h.fleet.start({ prompt: "first" }), b = await h.fleet.start({ prompt: "second" });
  await tick(); assert.deepEqual(h.started, ["first"]); assert.equal(h.fleet.inspect(b.threadId)?.state, "queued");
  h.gates[0].resolve({ outcome: "completed", complete: true });
  const [result] = await h.fleet.wait([a.runId]); await tick();
  assert.deepEqual(h.started, ["first", "second"]); assert.equal(result.outcome, "completed"); assert.equal(result.text, "first");
  assert.ok(Object.isFrozen(result)); assert.ok(events.some(e => e.runId === a.runId && e.event?.text === "first"));
  assert.ok(events.some(e => e.runId === b.runId && e.event?.text === "second"));
  h.gates[1].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([b.runId]); await h.fleet.dispose();
  assert.deepEqual(h.disposed, [0, 1]);
});

test("cancelled waiter leaves worker running and queued stop creates a retrievable result", async () => {
  const h = harness({ concurrency: 1 }); const a = await h.fleet.start({ prompt: "first" }), b = await h.fleet.start({ prompt: "second" });
  await tick(); const controller = new AbortController(); const waiting = h.fleet.wait([a.runId], controller.signal);
  controller.abort(); await assert.rejects(waiting, { name: "AbortError" }); assert.deepEqual(h.aborted, []);
  const receipt = await h.fleet.control({ version: 1, operation: "interrupt", threadId: b.threadId, expectedRunId: b.runId });
  assert.equal(receipt.status, "handled"); assert.equal((await h.fleet.wait([b.runId]))[0].outcome, "cancelled");
  h.gates[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick(); assert.deepEqual(h.started, ["first"]); await h.fleet.dispose();
});

test("active stop retains slot until backend settles and cannot turn interrupted work into completion", async () => {
  const h = harness({ concurrency: 1 }); const a = await h.fleet.start({ prompt: "first" }), b = await h.fleet.start({ prompt: "second" }); await tick();
  assert.equal((await h.fleet.control({ version: 1, operation: "interrupt", threadId: a.threadId, expectedRunId: a.runId })).status, "handled");
  await tick(); assert.deepEqual(h.started, ["first"]); assert.deepEqual(h.aborted, [0]);
  h.gates[0].resolve({ outcome: "completed", complete: true }); const [result] = await h.fleet.wait([a.runId]);
  assert.equal(result.outcome, "interrupted"); assert.equal(result.complete, false); await tick(); assert.deepEqual(h.started, ["first", "second"]);
  h.gates[1].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([b.runId]); await h.fleet.dispose();
});

test("pending, bytes and result reservations backpressure without evicting unconsumed outcomes", async () => {
  const h = harness({ concurrency: 1, pending: 1, slots: 2, bytes: 10 });
  const a = await h.fleet.start({ prompt: "a" }), b = await h.fleet.start({ prompt: "b" });
  assert.deepEqual(await h.fleet.start({ prompt: "c" }), { ok: false, code: "backpressure", domain: "pending_runs", recovery: "retry_after_drain" });
  await tick(); h.gates[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick();
  assert.deepEqual(await h.fleet.start({ prompt: "c" }), { ok: false, code: "backpressure", domain: "results", recovery: "consume_or_close" });
  assert.equal((await h.fleet.wait([a.runId]))[0].text, "a");
  assert.equal((await h.fleet.control({ version: 1, operation: "consume", threadId: a.threadId })).status, "handled");
  const c = await h.fleet.start({ prompt: "c" }); assert.equal(c.ok, true);
  h.gates[1].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([b.runId]); await tick();
  h.gates[2].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([c.runId]); await h.fleet.dispose();
  const oversized = harness({ bytes: 2 });
  assert.deepEqual(await oversized.fleet.start({ prompt: "éé" }), { ok: false, code: "backpressure", domain: "queued_bytes", recovery: "retry_after_drain" });
});

test("sustained sequential use releases closed thread capacity without losing unconsumed results", async () => {
  const h = harness({ threads: 1, slots: 2 });
  for (let i = 0; i < 2; i++) {
    const run = await h.fleet.start({ prompt: String(i) }); await tick();
    h.gates[i].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([run.runId]);
    assert.equal((await h.fleet.control({ version: 1, operation: "close", threadId: run.threadId })).status, "handled");
    assert.equal(h.fleet.inspect(run.threadId)?.threadState, "closed");
    assert.equal((await h.fleet.wait([run.runId]))[0].text, String(i));
  }
  assert.equal((await h.fleet.start({ prompt: "full" })).domain, "results");
  await h.fleet.dispose();
});

test("follow-up is a separately admitted run and stale controls cannot reach it", async () => {
  const h = harness({ concurrency: 1, pending: 1 });
  const a = await h.fleet.start({ prompt: "first" }); await tick();
  const accepted = await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "next" });
  assert.equal(accepted.status, "queued"); assert.notEqual(accepted.runId, a.runId);
  assert.equal((await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "third" })).error?.domain, "pending_runs");
  h.gates[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick();
  assert.deepEqual(h.started, ["first", "next"]);
  assert.deepEqual(h.disposed, []); // same live backend/session carries the conversation
  assert.equal((await h.fleet.control({ version: 1, operation: "interrupt", threadId: a.threadId, expectedRunId: a.runId })).error?.code, "stale_run");
  h.gates[1].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([accepted.runId!]);
  await h.fleet.control({ version: 1, operation: "close", threadId: a.threadId }); await h.fleet.dispose();
});

test("messages and steering correlate to current run without starting another run", async () => {
  const h = harness(); const a = await h.fleet.start({ prompt: "first" }); await tick();
  assert.equal((await h.fleet.control({ version: 1, operation: "message", threadId: a.threadId, message: "context" })).status, "unknown_delivery");
  assert.equal((await h.fleet.control({ version: 1, operation: "steer", threadId: a.threadId, expectedRunId: a.runId, message: "adjust" })).status, "queued");
  assert.equal((await h.fleet.control({ version: 1, operation: "steer", threadId: a.threadId, expectedRunId: "run-stale", message: "bad" })).error?.code, "stale_run");
  assert.deepEqual(h.started, ["first"]);
  h.gates[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]);
  await h.fleet.control({ version: 1, operation: "close", threadId: a.threadId }); await h.fleet.dispose();
});

test("consumed closed history is bounded while unconsumed closed results survive saturation", async () => {
  const h = harness({ threads: 1, slots: 2 });
  let firstThread = "";
  for (let i = 0; i < 20; i++) {
    const a = await h.fleet.start({ prompt: String(i) }); if (!i) firstThread = a.threadId; await tick();
    h.gates[i].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick();
    assert.equal((await h.fleet.control({ version: 1, operation: "consume", threadId: a.threadId })).status, "handled");
    await h.fleet.control({ version: 1, operation: "close", threadId: a.threadId });
    const last = h.fleet.inspect(a.threadId);
    assert.equal(last, undefined);
  }
  assert.equal(h.started.length, 20);
  assert.equal(h.fleet.inspect(firstThread), undefined);
  await h.fleet.dispose();
});

test("wait timeout leaves execution running and close cancels queued continuation", async () => {
  const h = harness({ concurrency: 1 }); const a = await h.fleet.start({ prompt: "hold" }); await tick();
  const b = await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "never" });
  await assert.rejects(h.fleet.wait([a.runId], undefined, 1), { name: "TimeoutError" });
  assert.deepEqual(h.aborted, []);
  await h.fleet.control({ version: 1, operation: "close", threadId: a.threadId });
  assert.equal((await h.fleet.wait([b.runId!]))[0].outcome, "cancelled");
  assert.equal(h.fleet.inspect(a.threadId)?.threadState, "closing");
  h.gates[0].resolve({ outcome: "completed", complete: true });
  assert.equal((await h.fleet.wait([a.runId]))[0].outcome, "interrupted");
  await tick(); assert.equal(h.fleet.inspect(a.threadId)?.threadState, "closed"); await h.fleet.dispose();
});

test("historical result remains addressable and consumable after follow-up", async () => {
  const h = harness({ slots: 2 }); const a = await h.fleet.start({ prompt: "one" }); await tick();
  h.gates[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick();
  const b = await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "two" }); await tick();
  const outcome = await h.fleet.control({ version: 1, operation: "result", threadId: a.threadId, expectedRunId: a.runId });
  assert.equal(outcome.result?.runId, a.runId);
  assert.equal((await h.fleet.control({ version: 1, operation: "consume", threadId: a.threadId, expectedRunId: a.runId })).status, "handled");
  h.gates[1].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([b.runId!]);
  await h.fleet.control({ version: 1, operation: "close", threadId: a.threadId }); await h.fleet.dispose();
});

test("repeated follow-ups cannot accumulate unlimited consumed run records", async () => {
  const h = harness({ slots: 2 }); const a = await h.fleet.start({ prompt: "zero" });
  let current = a.runId;
  for (let i = 0; i < 12; i++) {
    await tick(); h.gates[i].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([current]); await tick();
    assert.equal((await h.fleet.control({ version: 1, operation: "consume", threadId: a.threadId, expectedRunId: current })).status, "handled");
    if (i < 11) {
      const next = await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: String(i) });
      assert.equal(next.status, "queued"); current = next.runId!;
    }
  }
  await assert.rejects(h.fleet.wait([a.runId]), /Unknown run/);
  await h.fleet.control({ version: 1, operation: "close", threadId: a.threadId }); await h.fleet.dispose();
});

test("interrupted conversation cannot silently continue without retained context", async () => {
  const h = harness({ concurrency: 1 }); const a = await h.fleet.start({ prompt: "first" }); await tick();
  const b = await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "next" });
  await h.fleet.control({ version: 1, operation: "interrupt", threadId: a.threadId, expectedRunId: a.runId });
  h.gates[0].resolve({ outcome: "completed", complete: true });
  assert.equal((await h.fleet.wait([b.runId!]))[0].outcome, "cancelled");
  assert.deepEqual(h.started, ["first"]);
  assert.equal((await h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "again" })).error?.code, "unsupported_field");
  await h.fleet.control({ version: 1, operation: "close", threadId: a.threadId }); await h.fleet.dispose();
});

test("follow-up submitted at settlement cannot overlap the same thread", async () => {
  const h = harness({ concurrency: 2 }); const a = await h.fleet.start({ prompt: "first" }); await tick();
  const duringResult: string[] = []; let duringSubmissionState: string | undefined;
  h.fleet.subscribe(event => {
    if (event.type === "result" && event.runId === a.runId) {
      void h.fleet.control({ version: 1, operation: "follow_up", threadId: a.threadId, message: "second" }).then(r => duringResult.push(r.runId!));
      duringSubmissionState = h.fleet.inspect(a.threadId)?.state;
    }
  });
  h.gates[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await tick();
  assert.deepEqual(h.started, ["first", "second"]);
  assert.equal(duringSubmissionState, "queued");
  assert.equal(h.maxRunning, 1);
  h.gates[1].resolve({ outcome: "completed", complete: true }); await h.fleet.wait(duringResult);
  await h.fleet.dispose();
});

test("mailbox does not silently drop context when backend lacks context-only delivery", async () => {
  let n = 0, prompts = 0;
  const init = deferred<any>();
  const fleet = createSupervisor({ nextId: () => String(++n), createBackend: () => init.promise });
  const a = await fleet.start({ prompt: "task" });
  assert.equal((await fleet.control({ version: 1, operation: "message", threadId: a.threadId, message: "context" })).status, "queued");
  init.resolve({ async run() { prompts++; return { outcome: "completed", complete: true }; }, async abort() {}, async dispose() {} });
  const result = (await fleet.wait([a.runId]))[0];
  assert.equal(result.outcome, "failed"); assert.equal(prompts, 0); await fleet.dispose();
});

test("close during asynchronous mailbox delivery does not deliver subsequent context or launch a run", async () => {
  const init = deferred<any>(), delivery = deferred<{ status: "unknown_delivery" }>();
  let n = 0, prompts = 0; const messages: string[] = [];
  const fleet = createSupervisor({ nextId: () => String(++n), createBackend: () => init.promise });
  const a = await fleet.start({ prompt: "task" });
  await fleet.control({ version: 1, operation: "message", threadId: a.threadId, message: "one" });
  await fleet.control({ version: 1, operation: "message", threadId: a.threadId, message: "two" });
  init.resolve({ async run() { prompts++; return { outcome: "completed" as const, complete: true }; },
    async message(text: string) { messages.push(text); return delivery.promise; }, async abort() {}, async dispose() {} });
  await tick(); assert.deepEqual(messages, ["one"]);
  await fleet.control({ version: 1, operation: "close", threadId: a.threadId });
  delivery.resolve({ status: "unknown_delivery" });
  assert.equal((await fleet.wait([a.runId]))[0].outcome, "interrupted");
  assert.deepEqual(messages, ["one"]); assert.equal(prompts, 0); await fleet.dispose();
});

test("ID collisions fail admission before allocating a thread or result reservation", async () => {
  let calls = 0, collision = false;
  const fleet = createSupervisor({ threads: 1, slots: 1, nextId: () => collision ? "1" : String(++calls),
    createBackend: async () => ({ async run() { return { outcome: "completed" as const, complete: true }; }, async abort() {}, async dispose() {} }) });
  const a = await fleet.start({ prompt: "first" }); await fleet.wait([a.runId]);
  await fleet.control({ version: 1, operation: "consume", threadId: a.threadId });
  await fleet.control({ version: 1, operation: "close", threadId: a.threadId });
  collision = true;
  await assert.rejects(fleet.start({ prompt: "collision" }), /ID collision/);
  collision = false;
  const b = await fleet.start({ prompt: "second" }); assert.equal(b.ok, true);
  await fleet.dispose();
});

test("rejects unsupported operations and stale targets without altering work", async () => {
  const h = harness(); const a = await h.fleet.start({ prompt: "task" }); await tick();
  assert.equal((await h.fleet.control({ version: 1, operation: "resume", threadId: a.threadId, message: "again" })).error?.code, "unsupported_field");
  assert.equal((await h.fleet.control({ version: 1, operation: "interrupt", threadId: a.threadId, expectedRunId: "run-stale" })).error?.code, "stale_run");
  h.gates[0].resolve({ outcome: "completed", complete: true }); await h.fleet.wait([a.runId]); await h.fleet.dispose();
});

test("stop during backend initialization prevents submission and drains after disposal", async () => {
  const init = deferred<any>(); const entered: string[] = [], disposed: string[] = [];
  let n = 0;
  const fleet = createSupervisor({ concurrency: 1, nextId: () => String(++n), createBackend: () => init.promise });
  const a = await fleet.start({ prompt: "cancel before model" });
  const b = await fleet.start({ prompt: "next" });
  assert.equal(fleet.inspect(a.threadId)?.state, "initializing");
  await fleet.control({ version: 1, operation: "interrupt", threadId: a.threadId, expectedRunId: a.runId });
  assert.equal(fleet.inspect(b.threadId)?.state, "queued");
  init.resolve({ async run(prompt: string) { entered.push(prompt); return { outcome: "completed", complete: true }; },
    async abort() {}, async dispose() { disposed.push("done"); } });
  assert.equal((await fleet.wait([a.runId]))[0].complete, false);
  await tick(); assert.deepEqual(disposed, ["done"]); assert.deepEqual(entered, ["next"]);
  await fleet.wait([b.runId]); await fleet.dispose(); assert.deepEqual(disposed, ["done", "done"]);
});

test("rejects configured caps above fixed contract ceilings", () => {
  assert.throws(() => harness({ slots: 33 }), RangeError);
  assert.throws(() => harness({ pending: 33 }), RangeError);
});

test("failed backend disposal quarantines its slot rather than admitting another worker", async () => {
  let n = 0, executions = 0;
  const gate = deferred<{ outcome: "completed"; complete: true }>();
  const fleet = createSupervisor({ concurrency: 1, nextId: () => String(++n), createBackend: async () => ({
    async run() { executions++; return gate.promise; },
    async abort() {}, async dispose() { throw new Error("cleanup unconfirmed"); },
  }) });
  const a = await fleet.start({ prompt: "first" }), b = await fleet.start({ prompt: "second" });
  await fleet.control({ version: 1, operation: "close", threadId: a.threadId });
  gate.resolve({ outcome: "completed", complete: true });
  await fleet.wait([a.runId]); await tick();
  assert.equal(fleet.inspect(a.threadId)?.state, "quarantined");
  assert.equal(fleet.inspect(b.threadId)?.state, "queued");
  assert.equal(executions, 1);
  await fleet.control({ version: 1, operation: "interrupt", threadId: b.threadId, expectedRunId: b.runId });
  await assert.rejects(fleet.dispose(), /quarantined/);
});

test("idle close cleanup failure quarantines ownership and blocks replacement", async () => {
  let n = 0, calls = 0;
  const fleet = createSupervisor({ concurrency: 1, nextId: () => String(++n), createBackend: async () => ({
    async run() { calls++; return { outcome: "completed" as const, complete: true }; },
    async abort() {}, async dispose() { throw new Error("cannot close"); },
  }) });
  const a = await fleet.start({ prompt: "first" }); await fleet.wait([a.runId]); await tick();
  const closed = await fleet.control({ version: 1, operation: "close", threadId: a.threadId });
  assert.equal(closed.error?.code, "cleanup_unconfirmed");
  const b = await fleet.start({ prompt: "second" }); await tick();
  assert.equal(fleet.inspect(b.threadId)?.state, "queued"); assert.equal(calls, 1);
  await fleet.control({ version: 1, operation: "interrupt", threadId: b.threadId, expectedRunId: b.runId });
  await assert.rejects(fleet.dispose(), /quarantined/);
});

test("backend initialization failure is a terminal failed result and drains queued work", async () => {
  let n = 0, calls = 0;
  const fleet = createSupervisor({ concurrency: 1, nextId: () => String(++n), createBackend: async () => {
    if (++calls === 1) throw new Error("offline initialization failed");
    return { async run() { return { outcome: "completed" as const, complete: true }; }, async abort() {}, async dispose() {} };
  } });
  const a = await fleet.start({ prompt: "first" }), b = await fleet.start({ prompt: "second" });
  assert.equal((await fleet.wait([a.runId]))[0].outcome, "failed");
  assert.equal((await fleet.wait([b.runId]))[0].outcome, "completed"); await fleet.dispose();
});
