import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBackend } from "./backend.ts";
import { provider } from "./backend.test.ts";
import { createSupervisor } from "./supervisor.ts";

test("two real Pi SDK read-only offline threads stream text/tool and settle independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-m2-"));
  const home = join(root, "home"), cwd = join(root, "cwd");
  await mkdir(home); await mkdir(cwd); await writeFile(join(cwd, "fixture.txt"), "approved fixture\n");
  let serial = 0, constructed = 0;
  const events: any[] = [];
  const fleet = createSupervisor({ concurrency: 2, nextId: () => String(++serial), createBackend: async () => {
    constructed++;
    const opened = await createNativeBackend({ agentDir: home, cwd, model: "offline-fixture/offline", provider: provider(() => {}) });
    if (!opened.ok) throw new Error(opened.code);
    return opened.backend;
  } });
  const unsubscribe = fleet.subscribe(e => events.push(e));
  try {
    const a = await fleet.start({ prompt: "Read fixture.txt" });
    const b = await fleet.start({ prompt: "Read fixture.txt again" });
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(fleet.inspect(a.threadId)?.runId, a.runId);
    const results = await fleet.wait([a.runId, b.runId]);
    assert.deepEqual(results.map(r => r.outcome), ["completed", "completed"]);
    assert.ok(results.every(r => r.complete && r.text?.includes("Reading fixture") && r.text?.includes("Found fixture")));
    for (const runId of [a.runId, b.runId]) {
      const own = events.filter(e => e.runId === runId);
      assert.ok(own.some(e => e.event?.type === "tool_execution_start" && e.event.toolName === "read"));
      assert.ok(own.some(e => e.event?.type === "tool_execution_end" && !e.event.isError && JSON.stringify(e.event.result).includes("approved fixture")));
      assert.equal(own.filter(e => e.event?.type === "agent_settled").length, 1);
      assert.equal(own.filter(e => e.type === "result").length, 1);
    }
    assert.equal(constructed, 2);
    assert.deepEqual(await readdir(home), []);
    assert.deepEqual(await readdir(cwd), ["fixture.txt"]);
  } finally { unsubscribe(); await fleet.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("native offline Pi finalized assistant usage counts once across tool and final turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-budget-"));
  const home = join(root, "home"), cwd = join(root, "cwd");
  await mkdir(home); await mkdir(cwd); await writeFile(join(cwd, "fixture.txt"), "approved fixture\n");
  let serial = 0; const events: any[] = [];
  const fleet = createSupervisor({ nextId: () => String(++serial), budget: { softTurns: 3, hardTurns: 5, maxTokens: 100 }, createBackend: async () => {
    const opened = await createNativeBackend({ agentDir: home, cwd, model: "offline-fixture/offline", provider: provider(() => {}) });
    if (!opened.ok) throw new Error(opened.code);
    return opened.backend;
  } });
  fleet.subscribe(event => events.push(event));
  try {
    const a = await fleet.start({ prompt: "Read fixture.txt" });
    assert.equal((await fleet.wait([a.runId]))[0].outcome, "completed");
    const ends = events.filter(e => e.runId === a.runId && e.event?.type === "message_end" && e.event.message?.role === "assistant");
    assert.equal(ends.length, 2);
    const snapshot = fleet.inspect(a.threadId)!;
    assert.equal(snapshot.turns, 2);
    assert.deepEqual(snapshot.usage, { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: 0 });
    assert.deepEqual(await readdir(home), []);
    assert.deepEqual(await readdir(cwd), ["fixture.txt"]);
  } finally { await fleet.dispose(); await rm(root, { recursive: true, force: true }); }
});
