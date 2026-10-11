import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisor } from "./supervisor.ts";
import { createManagerDriverFactory } from "./manager-driver.ts";
import { ThreadManager } from "./upstream/src/orch/manager.ts";

const message = (text: string) => ({ role: "assistant", api: "fixture", provider: "fixture", model: "chosen", content: [{ type: "text", text }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "stop", timestamp: 1 });

test("upstream threads use one supervised fresh session and retain lifetime budgets across resume", async () => {
  let serial = 0, creations = 0, disposals = 0;
  const prompts: string[] = [];
  const supervisor = createSupervisor({ nextId: () => `${++serial}`, concurrency: 1, threads: 4, slots: 4,
    createBackend: async () => { throw Error("unprepared"); }, prepare: async request => {
      assert.equal(request.context, undefined);
      return { model: "fixture/chosen", budget: { softTurns: 2, hardTurns: 2, elapsedMs: 10000 }, createBackend: async () => {
        creations++;
        return { hasRetainedContext: () => true, abort: async () => {}, dispose: async () => { disposals++; },
          run: async (prompt, emit) => { prompts.push(prompt); emit({ type: "message_end", message: message(prompt) }); return { outcome: "completed", complete: true }; } };
      } };
    } });
  const factory = createManagerDriverFactory({ supervisor, requestFor: () => ({ role: "researcher" }) });
  const manager = new ThreadManager({ createDriver: factory, rootSnapshot: () => [], getType: name => ({ name, description: name, systemPrompt: "role" }), toolsFor: () => [], maxConcurrent: 1, maxThreads: 4, maxLevels: 2 });
  try {
    const first = await manager.spawn("/root", { path: "research", type: "researcher", task: "first" });
    assert.equal(first.state, "completed"); assert.equal(first.output, "first"); assert.equal(first.model, "fixture/chosen");
    await manager.steer("/root", "research", "second");
    assert.equal((await manager.wait("/root", "research")).state, "completed");
    await manager.steer("/root", "research", "third");
    assert.equal((await manager.wait("/root", "research")).state, "failed");
    assert.deepEqual(prompts, ["first", "second"]); assert.equal(creations, 1);
    assert.equal(manager.saved()[0].view.sessionFile, undefined);
    assert.deepEqual(manager.saved()[0].inherited, []);
    assert.equal(first.inputTokens, 1); assert.equal(manager.get("research").inputTokens, 2);
  } finally { await manager.shutdown(); await factory.shutdown(); }
  assert.equal(disposals, 1);
});

test("upstream stop reaches SDK guard while a launch is still preparing", async () => {
  let serial = 0, release!: () => void, ran = 0, disposed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const supervisor = createSupervisor({ nextId: () => `${++serial}`, createBackend: async () => {
    await gate; return { run: async () => { ran++; return { outcome: "completed", complete: true }; }, abort: async () => {}, dispose: async () => { disposed++; } };
  } });
  const factory = createManagerDriverFactory({ supervisor, requestFor: () => ({ role: "researcher" }) });
  const manager = new ThreadManager({ createDriver: factory, rootSnapshot: () => [], getType: name => ({ name, description: name, systemPrompt: "role" }), toolsFor: () => [] });
  await manager.spawn("/root", { path: "research", type: "researcher", task: "first", wait: false });
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  const stopping = manager.stop("/root", "research"); release(); await stopping;
  assert.equal(manager.get("research").state, "stopped"); assert.equal(ran, 0);
  await manager.shutdown(); await factory.shutdown(); assert.equal(disposed, 1);
});

test("upstream stopped threads resume their retained session instead of losing context", async () => {
  let serial = 0, release!: () => void, creations = 0, disposals = 0;
  const prompts: string[] = [];
  const supervisor = createSupervisor({ nextId: () => `${++serial}`, createBackend: async () => {
    creations++;
    return { hasRetainedContext: () => true, dispose: async () => { disposals++; }, abort: async () => { release?.(); },
      run: async (prompt, emit) => {
        prompts.push(prompt);
        if (prompts.length === 1) { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "interrupted", complete: false }; }
        emit({ type: "message_end", message: message("resumed") }); return { outcome: "completed", complete: true };
      } };
  } });
  const factory = createManagerDriverFactory({ supervisor, requestFor: () => ({ role: "researcher" }) });
  const manager = new ThreadManager({ createDriver: factory, rootSnapshot: () => [], getType: name => ({ name, description: name, systemPrompt: "role" }), toolsFor: () => [] });
  try {
    await manager.spawn("/root", { path: "research", type: "researcher", task: "first", wait: false });
    while (!release) await new Promise<void>(resolve => setImmediate(resolve));
    await manager.stop("/root", "research");
    assert.equal(manager.get("research").state, "stopped"); assert.equal(disposals, 0);
    await manager.steer("/root", "research", "continue");
    const final = await manager.wait("/root", "research");
    assert.equal(final.state, "completed"); assert.equal(final.output, "resumed");
    assert.equal(creations, 1); assert.deepEqual(prompts, ["first", "continue"]);
  } finally { await manager.shutdown(); await factory.shutdown(); }
  assert.equal(disposals, 1);
});

test("public manager failures expose startup rejection rather than incomplete-output placeholder", async () => {
  let serial = 0;
  const supervisor = createSupervisor({ nextId: () => `${++serial}`, createBackend: async () => { throw Error("unsupported_provider"); } });
  const factory = createManagerDriverFactory({ supervisor, requestFor: () => ({ role: "scout" }) });
  const manager = new ThreadManager({ createDriver: factory, rootSnapshot: () => [], getType: name => ({ name, description: name, systemPrompt: "role" }), toolsFor: () => [] });
  try {
    const view = await manager.spawn("/root", { path: "startup-failure", type: "scout", task: "Explain repository", wait: true });
    assert.equal(view.state, "failed");
    assert.match(view.error ?? "", /unsupported_provider/);
    assert.doesNotMatch(view.error ?? "", /output is incomplete/);
  } finally { await manager.shutdown(); await factory.shutdown(); }
});
