import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedSupervisor } from "./manager-service.ts";
import { createRootThreadService } from "./root-service.ts";
import { createProtocol } from "./protocol.ts";
import { createOrchestration } from "./orchestration.ts";

async function fixture(persist = false) {
  const root = await mkdtemp(join(tmpdir(),"root-service-")), messages: any[] = [], prompts: string[] = [], warnings: string[] = [];
  const listeners = new Map<string,Set<any>>();
  const events = { on(name: string, fn: any) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name,set); return () => set.delete(fn); },
    emit(name: string, value: any) { messages.push([name,value]); for (const fn of listeners.get(name) ?? []) fn(value); } };
  let serial = 0;
  const service = createManagedSupervisor({ nextId: () => `${++serial}`, createBackend: async () => ({
    hasRetainedContext: () => true, abort: async () => {}, dispose: async () => {},
    run: async prompt => { prompts.push(prompt); return { outcome: "completed", complete: true }; },
  }) });
  const protocol = createProtocol({ events, supervisor: service, start: service.start, generation: "test" });
  const orchestration = await createOrchestration({ agentDir: root, owner: "test", config: { persist },
    start: async request => { const receipt = await service.start(request); if (receipt.ok) protocol.announce(receipt,{type:request.role!,description:"test",isBackground:true}); return receipt; },
    wait: service.wait, control: protocol.control, notify: message => warnings.push(message), outbox: protocol.pending });
  const detach = service.subscribe(event => { if (event.type === "result") orchestration.remember(event.result!); });
  const first = await orchestration.admit({ role: "researcher", prompt: "first" }); if (!first.ok) throw Error("fixture admission");
  const path = service.pathFor(first.threadId)!;
  await service.manager.wait("/root",path); await orchestration.flush();
  return { root, service, orchestration, first, path, messages, prompts, warnings,
    scope: createRootThreadService(service,orchestration.control),
    async dispose() { await chmod(join(root,"subagents-state"),0o700).catch(()=>{}); await service.dispose(); await orchestration.close(); protocol.dispose(); detach(); await rm(root,{recursive:true,force:true}); } };
}

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
