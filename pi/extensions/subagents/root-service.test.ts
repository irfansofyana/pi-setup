import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedSupervisor } from "./manager-service.ts";
import { createRootThreadService } from "./root-service.ts";
import { createProtocol } from "./protocol.ts";
import { createOrchestration } from "./orchestration.ts";
import type { Backend } from "./supervisor.ts";

test("human task controls preserve delivery receipts and reject replaced run targets", async () => {
  const view: any = { path: "/root/test", costId: "lifetime", createdAt: 1 };
  let runId = "run-first", calls = 0;
  const receipt: any = { version: 1, controlId: "control-test", runId, status: "unknown_delivery" };
  const root = createRootThreadService({ manager: { scope: () => ({ get: () => view }) },
    handleFor: () => ({ threadId: "thread-test" }), inspect: () => ({ runId }) } as any,
    async request => { calls++; assert.equal(request.operation, "follow_up"); assert.equal(request.expectedRunId, "run-first"); return receipt; });
  const target = root.taskTarget({ path: view.path, identity: "lifetime" })!;
  for (const status of ["queued", "accepted", "handled", "applied", "rejected", "unknown_delivery"]) {
    receipt.status = status;
    const result = await root.sendTask(target, "follow_up", "next task");
    assert.equal(result.status, status); assert.equal(result.receipt, receipt);
  }
  runId = "run-second";
  assert.equal((await root.sendTask(target, "steer", "old target")).reason, "stale_target");
  view.costId = "replacement";
  assert.equal(root.taskTarget({ path: view.path, identity: "lifetime" }), undefined);
  assert.equal(calls, 6);
});

test("exceptions after control dispatch are unknown delivery, never a definite rejection", async () => {
  const root = createRootThreadService({ manager: { scope: () => ({ get: () => ({ path: "/root/test", costId: "life" }) }) },
    handleFor: () => ({ threadId: "thread-test" }), inspect: () => ({ runId: "run-test" }) } as any,
    async () => { throw Error("PRIVATE_FAILURE"); });
  const result = await root.sendTask(root.taskTarget({ path: "/root/test", identity: "life" })!, "steer", "hello");
  assert.deepEqual(result, { status: "unknown_delivery" });
});

async function fixture(persist = false, active?: Pick<Backend, "run" | "abort">) {
  const root = await mkdtemp(join(tmpdir(),"root-service-")), messages: any[] = [], prompts: string[] = [], warnings: string[] = [];
  const listeners = new Map<string,Set<any>>();
  const events = { on(name: string, fn: any) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name,set); return () => set.delete(fn); },
    emit(name: string, value: any) { messages.push([name,value]); for (const fn of listeners.get(name) ?? []) fn(value); } };
  let serial = 0;
  const service = createManagedSupervisor({ nextId: () => `${++serial}`, createBackend: async () => ({
    hasRetainedContext: () => true, abort: active?.abort ?? (async () => {}), dispose: async () => {},
    run: async (prompt, emit) => { prompts.push(prompt); return active ? active.run(prompt, emit) : { outcome: "completed", complete: true }; },
  }) });
  const protocol = createProtocol({ events, supervisor: service, start: service.start, generation: "test" });
  const orchestration = await createOrchestration({ agentDir: root, owner: "test", config: { persist },
    start: async request => { const receipt = await service.start(request); if (receipt.ok) protocol.announce(receipt,{type:request.role!,description:"test",isBackground:true}); return receipt; },
    wait: service.wait, control: protocol.control, notify: message => warnings.push(message), outbox: protocol.pending });
  const detach = service.subscribe(event => { if (event.type === "result") orchestration.remember(event.result!); });
  const first = await orchestration.admit({ role: "researcher", prompt: "first" }); if (!first.ok) throw Error("fixture admission");
  const path = service.pathFor(first.threadId)!;
  if (!active) await service.manager.wait("/root",path);
  await orchestration.flush();
  return { root, service, orchestration, first, path, messages, prompts, warnings,
    scope: createRootThreadService(service,orchestration.control),
    async dispose() { await chmod(join(root,"subagents-state"),0o700).catch(()=>{}); await service.dispose(); await orchestration.close(); protocol.dispose(); detach(); await rm(root,{recursive:true,force:true}); } };
}

test("human follow-up queues a distinct run through orchestration without interrupting current work", { timeout: 5000 }, async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(false, {
    abort: async () => release(),
    run: async (prompt, emit) => {
      if (prompt === "first") { started(); await gate; }
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: prompt } });
      return { outcome: "completed", complete: true };
    },
  });
  try {
    await ready;
    const view = f.scope.get(f.path);
    const target = f.scope.taskTarget({ path: view.path, identity: view.costId ?? view.createdAt })!;
    const queued = await f.scope.sendTask(target, "follow_up", "second");
    assert.equal(queued.status, "queued"); assert.notEqual(queued.receipt?.runId, f.first.runId);
    assert.deepEqual(f.prompts, ["first"], "follow-up waits for the current run");
    release(); await f.service.manager.wait("/root", f.path);
    assert.deepEqual(f.prompts, ["first", "second"]);
    assert.equal(f.scope.get(f.path).output, "second");
    assert.deepEqual(f.messages.filter(([name]) => name === "subagents:completed").map(([, value]) => value.runId), [f.first.runId, queued.receipt!.runId]);
    assert.equal((await f.scope.sendTask(target, "follow_up", "stale retry")).reason, "stale_target");
    assert.deepEqual(f.prompts, ["first", "second"]);
  } finally { release(); await f.dispose(); }
});

test("tree continuation announces exact new runs and retains completed recovery metadata", async () => {
  const f = await fixture();
  try {
    await f.scope.steer(f.path,"second"); await f.service.manager.wait("/root",f.path);
    const next = f.service.handleFor(f.path)!;
    assert.notEqual(next.runId,f.first.runId);
    assert.deepEqual(f.messages.filter(([name])=>name==="subagents:completed").map(([,value])=>value.runId),[f.first.runId,next.runId]);
    assert.equal(f.orchestration.results().find(entry=>entry.result.runId===next.runId)?.pending,false);
  } finally { await f.dispose(); }
});

test("tree continuation cannot bypass retained-result backpressure", async () => {
  const f = await fixture();
  try {
    const [result] = await f.service.wait([f.first.runId]);
    for (let i=0;i<31;i++) f.orchestration.remember({...result,runId:`run-retained-${i}`});
    await assert.rejects(f.scope.steer(f.path,"should not launch"),/backpressure/);
    assert.deepEqual(f.prompts,["first"]);
  } finally { await f.dispose(); }
});

test("tree continuation cannot bypass a real persistence failure", async () => {
  const f = await fixture(true);
  try {
    await chmod(join(f.root,"subagents-state"),0o500);
    await f.orchestration.flush();
    assert.ok(f.warnings.some(message=>/state write failed/.test(message)));
    await assert.rejects(f.scope.steer(f.path,"should not launch"),/backpressure/);
    assert.deepEqual(f.prompts,["first"]);
  } finally { await f.dispose(); }
});
