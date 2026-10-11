import test from "node:test";
import assert from "node:assert/strict";
import { createManagedSupervisor } from "./manager-service.ts";

test("reviewed opt-in trees admit fresh descendants and independent roots in one bounded pool",async()=>{
  let serial=0; const drivers:any[]=[];
  const service=createManagedSupervisor({concurrency:1,threads:4,nextId:()=>String(++serial),createBackend:async()=>({
    run:async()=>({outcome:"completed",complete:true}),abort:async()=>{},dispose:async()=>{},
  })},{maxLevels:4,onDriver:driver=>drivers.push(driver)} as any);
  try{
    const parent=await service.start({role:"researcher",prompt:"parent"},"controller");assert.equal(parent.ok,true);
    if(!parent.ok)return;await service.wait([parent.runId]);await service.manager.wait("/root","controller");
    const child=await service.start({role:"reviewer",prompt:"child"},"/root/controller/child");assert.equal(child.ok,true);
    if(!child.ok)return;await service.wait([child.runId]);
    const independent=await service.start({role:"researcher",prompt:"independent"},"/separate");assert.equal(independent.ok,true);
    if(!independent.ok)return;await service.wait([independent.runId]);
    assert.deepEqual(drivers.map(driver=>driver.inherited),[[],[],[]]);
    assert.throws(()=>service.manager.scope("/root/controller").get("/separate"),/descendant/);
  }finally{await service.dispose();}
});

test("foreground admission does not become a detached completion merely because policy allocation is asynchronous", async () => {
  let serial=0; const events:any[]=[];
  const service=createManagedSupervisor({nextId:()=>String(++serial),createBackend:async()=>({run:async()=>({outcome:"completed",complete:true}),abort:async()=>{},dispose:async()=>{}})},
    {onEvent:event=>events.push(event)});
  try {
    const started=await service.start({role:"researcher",prompt:"foreground"},"foreground",undefined,false);
    assert.equal(started.ok,true); if(!started.ok)return;
    await service.wait([started.runId]); await service.manager.wait("/root","foreground");
    assert.equal(events.find(event=>event.kind==="settled").async,false);
  } finally {await service.dispose();}
});

test("manager resolves custom definitions instead of imposing a fixed role-name list", async () => {
  let serial = 0;
  const service = createManagedSupervisor({ nextId: () => `${++serial}`, createBackend: async () => ({
    hasRetainedContext: () => true, abort: async () => {}, dispose: async () => {}, run: async () => ({ outcome: "completed", complete: true }),
  }) }, { getType(name) { if (name !== "worker") throw Error("unknown type"); return { name, description: "Custom helper", tools: {}, systemPrompt: "work", thinkingLevel: "low" }; } } as any);
  try {
    const result = await service.start({ role: "worker", prompt: "General work" });
    assert.equal(result.ok, true); if (!result.ok) return;
    await service.wait([result.runId]); assert.equal(service.manager.list()[0].type, "worker");
    const bad = await service.start({ role: "missing", prompt: "must reject" }); assert.equal(bad.ok, false);
  } finally { await service.dispose(); }
});

function fixture() {
  let serial = 0, sessions = 0, disposed = 0;
  const requests: any[] = [], prompts: string[] = [];
  const service = createManagedSupervisor({ nextId: () => `${++serial}`, concurrency: 1, threads: 4, slots: 8,
    createBackend: async () => { throw Error("unprepared"); },
    prepare: async request => {
      requests.push(request);
      return { model: request.model ?? "fixture/chosen", thinking: "high", budget: { softTurns: 5, hardTurns: 5 }, createBackend: async () => {
        sessions++;
        return { hasRetainedContext: () => true, abort: async () => {}, dispose: async () => { disposed++; },
          run: async (prompt, emit) => { prompts.push(prompt);
            emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: prompt } });
            emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: prompt }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
            return { outcome: "completed", complete: true };
          } };
      } };
    } });
  return { service, requests, prompts, sessions: () => sessions, disposed: () => disposed };
}

test("legacy admission and follow-up are visible in the upstream tree with exact run/result identity", async () => {
  const f = fixture(), service = f.service;
  try {
    const first = await service.start({ role: "researcher", prompt: "first" });
    assert.equal(first.ok, true); if (!first.ok) return;
    const [result] = await service.wait([first.runId]); assert.equal(result.text, "first");
    assert.equal(service.manager.list().length, 1);
    const path = service.pathFor(first.threadId); assert.ok(path);
    const next = await service.control({ version: 1, operation: "follow_up", threadId: first.threadId, expectedRunId: first.runId, message: "second" });
    assert.notEqual(next.status, "rejected"); assert.notEqual(next.runId, first.runId);
    const [second] = await service.wait([next.runId!]); assert.equal(second.text, "second");
    assert.equal(service.inspect(first.threadId, first.runId)?.result?.text, "first");
    assert.equal(f.sessions(), 1); assert.equal(service.manager.list().length, 1);
    await service.control({ version: 1, operation: "close", threadId: first.threadId, expectedRunId: next.runId });
    assert.equal(service.manager.list().length, 0); assert.equal(f.disposed(), 1);
  } finally { await service.dispose(); }
});

test("upstream named spawn forwards reviewed files/model/turn limits to the same policy pool", async () => {
  const f = fixture();
  try {
    const view = await f.service.spawnNamed({ path: "build-one", type: "builder", task: "implement", files: ["src/example.ts"], model: "fixture/explicit", maxTurns: 2 });
    assert.equal(view.path, "/root/build-one"); assert.equal(view.state, "completed");
    assert.equal(view.thinkingLevel,"high");
    assert.deepEqual(f.requests[0].files, ["src/example.ts"]); assert.equal(f.requests[0].model, "fixture/explicit");
    assert.equal(f.requests[0].maxTurns, 2); assert.equal(f.requests[0].context, undefined);
    assert.equal(f.service.manager.saved()[0].view.sessionFile, undefined);
    assert.deepEqual(f.service.manager.saved()[0].inherited, []);
    await assert.rejects(f.service.spawnNamed({ path: "build-one", type: "reviewer", task: "overwrite", files: ["other.ts"] }), /already exists/);
    assert.equal(f.requests.length, 1);
  } finally { await f.service.dispose(); }
});

test("named and legacy entrypoints cannot bypass shared thread/result capacity or specialist depth", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) await f.service.spawnNamed({ path: `task-${i}`, type: "researcher", task: "answer" });
    const overflow = await f.service.start({ role: "researcher", prompt: "overflow" }); assert.equal(overflow.ok, false);
    await assert.rejects(f.service.spawnNamed({ path: "/root/task-0/nested", type: "researcher", task: "nested" }), /depth/);
    assert.equal(f.sessions(), 4);
  } finally { await f.service.dispose(); }
});

test("formal queued follow-ups keep the upstream thread running until every exact run settles", async () => {
  let serial = 0, release!: () => void;
  const prompts: string[] = [];
  const service = createManagedSupervisor({ nextId: () => `${++serial}`, createBackend: async () => ({
    hasRetainedContext: () => true, abort: async () => release?.(), dispose: async () => {},
    run: async (prompt, emit) => {
      prompts.push(prompt);
      if (prompt === "first") await new Promise<void>(resolve => { release = resolve; });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: prompt } });
      return { outcome: "completed", complete: true };
    },
  }) });
  try {
    const first = await service.start({ role: "researcher", prompt: "first" }); assert.equal(first.ok, true); if (!first.ok) return;
    while (!release) await new Promise<void>(resolve => setImmediate(resolve));
    const next = await service.control({ version: 1, operation: "follow_up", threadId: first.threadId, expectedRunId: first.runId, message: "second" });
    assert.equal(next.status, "queued"); release();
    await service.wait([next.runId!]);
    const view = await service.manager.wait("/root", service.pathFor(first.threadId)!);
    assert.equal(view.output, "second"); assert.deepEqual(prompts, ["first", "second"]);
  } finally { await service.dispose(); }
});

test("concurrent formal continuations reserve distinct exact runs instead of becoming same-turn steering", async () => {
  const f = fixture();
  try {
    const first = await f.service.start({ role: "researcher", prompt: "first" }); if (!first.ok) throw Error("admission");
    await f.service.wait([first.runId]);
    const requests = ["second", "third"].map(message => f.service.control({ version: 1, operation: "follow_up", threadId: first.threadId, expectedRunId: first.runId, message }));
    const receipts = await Promise.all(requests);
    assert.ok(receipts.every(receipt => receipt.status !== "rejected"));
    assert.notEqual(receipts[0].runId, receipts[1].runId);
    await f.service.wait(receipts.map(receipt => receipt.runId!));
    await f.service.manager.wait("/root", f.service.pathFor(first.threadId)!);
    assert.deepEqual(f.prompts, ["first", "second", "third"]);
  } finally { await f.service.dispose(); }
});

for (const phase of ["prepare", "initialize", "run"] as const) test(`shutdown quarantines permanently hung ${phase} within cleanup grace`, async () => {
  let serial = 0;
  const never = new Promise<never>(() => {});
  const backend = { run: async () => never, abort: async () => {}, dispose: async () => {} };
  const service = createManagedSupervisor({ nextId: () => `${++serial}`, cleanupMs: 15,
    prepare: async () => { if (phase === "prepare") await never; return { budget: { softTurns: 1, hardTurns: 1 }, createBackend: async () => { if (phase === "initialize") await never; return backend; } }; },
    createBackend: async () => backend });
  const launch = service.start({ role: "researcher", prompt: "hang" });
  void launch.catch(() => {});
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  const before = performance.now();
  await assert.rejects(service.dispose(), /quarantin|cleanup|drain/i);
  assert.ok(performance.now() - before < 1000);
  assert.equal((await service.start({ role: "researcher", prompt: "replacement" })).ok, false);
});

test("a failed predecessor cannot hide an accepted queued continuation from upstream wait/status", async () => {
  let serial = 0, release!: () => void, finish!: () => void;
  const service = createManagedSupervisor({ nextId: () => `${++serial}`, createBackend: async () => ({
    hasRetainedContext: () => true, abort: async () => {}, dispose: async () => {},
    run: async (prompt, emit) => {
      if (prompt === "first") { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "failed", complete: false }; }
      await new Promise<void>(resolve => { finish = resolve; });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "recovered" } });
      return { outcome: "completed", complete: true };
    },
  }) });
  try {
    const first = await service.start({ role: "researcher", prompt: "first" }); if (!first.ok) throw Error("admission");
    while (!release) await new Promise<void>(resolve => setImmediate(resolve));
    const next = await service.control({ version: 1, operation: "follow_up", threadId: first.threadId, expectedRunId: first.runId, message: "second" });
    release(); while (!finish) await new Promise<void>(resolve => setImmediate(resolve));
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
    const path = service.pathFor(first.threadId)!;
    assert.equal(service.manager.get(path).state,"running");
    assert.equal(service.handleFor(path)?.runId,next.runId);
    finish(); const final = await service.manager.wait("/root",path);
    assert.equal(final.state,"completed"); assert.equal(final.output,"recovered");
    assert.equal((await service.wait([first.runId]))[0].outcome,"failed");
    assert.equal((await service.wait([next.runId!]))[0].complete,true);
  } finally { finish?.(); release?.(); await service.dispose(); }
});
