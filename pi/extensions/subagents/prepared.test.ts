import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisor } from "./supervisor.ts";

test("prepared role backends share one admission queue and enforce their own ceilings", async () => {
  let serial = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const fleet = createSupervisor({ concurrency: 1, nextId: () => String(++serial),
    createBackend: async () => { throw Error("unprepared backend forbidden"); },
    prepare: async (request: any) => ({ budget: { softTurns: request.role === "short" ? 1 : 3, hardTurns: request.role === "short" ? 1 : 3 },
      createBackend: async () => ({ async run(_prompt: string, emit: (event: any) => void) {
        started.push(request.role); if (request.role === "long") await gate;
        emit({ type: "message_end", message: { role: "assistant", id: request.role } });
        return { outcome: "completed" as const, complete: true };
      }, async abort() {}, async dispose() {} }) }),
  } as any);
  try {
    const a: any = await fleet.start({ role: "long", prompt: "first", model: "fixture/one" });
    const b: any = await fleet.start({ role: "short", prompt: "second", model: "fixture/two" });
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(started, ["long"]);
    release();
    const results = await fleet.wait([a.runId, b.runId]);
    assert.deepEqual(started, ["long", "short"]);
    assert.deepEqual(results.map(r => r.outcome), ["completed", "budget_exhausted"]);
  } finally { release(); await fleet.dispose(); }
});

test("invalid prepared budget and enlarged invocation limits never create a worker", async () => {
  let serial = 0, workers = 0;
  const fleet = createSupervisor({ nextId: () => String(++serial), createBackend: async () => { workers++; throw Error("unexpected"); },
    prepare: async (request: any) => ({ budget: { softTurns: request.role === "bad" ? NaN : 2, hardTurns: 2 }, createBackend: async () => { workers++; throw Error("unexpected"); } }),
  } as any);
  try {
    assert.equal((await fleet.start({ role: "bad", prompt: "task" })).status, undefined);
    assert.deepEqual(await fleet.start({ role: "bad", prompt: "task" }), { ok: false, code: "invalid_request" });
    assert.deepEqual(await fleet.start({ role: "good", prompt: "task", maxTurns: 3 }), { ok: false, code: "invalid_request" });
    assert.equal(workers, 0);
  } finally { await fleet.dispose(); }
});
