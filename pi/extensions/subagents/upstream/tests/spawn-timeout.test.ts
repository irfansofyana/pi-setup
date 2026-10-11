import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadManager } from "../src/orch/manager.ts";
import type { ThreadEvent } from "../src/types.ts";
import { agentTools } from "../src/orch/tools.ts";

function setup() {
  const events: ThreadEvent[] = [];
  const gates: Array<(error?: Error) => void> = [];
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => ({ name, description: "t", systemPrompt: "t" }),
    toolsFor: () => [],
    onEvent: (event) => events.push(event),
    createDriver: async () => {
      let release: (error?: Error) => void = () => {};
      return {
        prompt: () =>
          new Promise<void>((resolve, reject) => {
            release = (e) => (e ? reject(e) : resolve());
            gates.push(release);
          }),
        steer: async () => {},
        snapshot: () => [
          {
            role: "assistant",
            content: [{ type: "text", text: "partial work" }],
            timestamp: 0,
          } as any,
        ],
        output: () => "done",
        abort: async () => release(),
        dispose: () => {},
        sendUpdate: () => {},
      };
    },
  });
  const spawn = (path: string, timeoutMs?: number) =>
    manager.spawn("/root", { path, type: "w", task: "task", wait: false, timeoutMs });
  const timeouts = () => events.filter((e) => e.kind === "timeout");
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return { manager, events, gates, spawn, timeouts, flush };
}

test("timeout reports state to the parent without stopping the child", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, spawn, timeouts, flush } = setup();
  await spawn("a", 30_000);
  await flush();
  t.mock.timers.tick(29_999);
  assert.equal(timeouts().length, 0);
  t.mock.timers.tick(1);
  const [event] = timeouts() as Extract<ThreadEvent, { kind: "timeout" }>[];
  assert.equal(event!.thread.state, "running");
  assert.equal(event!.recipient, "/root");
  assert.equal(event!.timeoutMs, 30_000);
  assert.match(event!.recentOutput, /partial work/);
  assert.equal(manager.get("a").state, "running", "child keeps running");
  gates[0]!();
  await manager.wait("/root", "a");
  await manager.shutdown();
});

test("timer is cleared on completion, failure, stop and shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, spawn, timeouts, flush } = setup();
  for (const name of ["done", "failed", "stopped", "alive"]) await spawn(name, 60_000);
  await flush();
  gates[0]!();
  gates[1]!(new Error("boom"));
  await manager.wait("/root", "done");
  await manager.wait("/root", "failed").catch(() => {});
  await manager.stop("/root", "stopped");
  t.mock.timers.tick(60_000);
  assert.deepEqual(
    timeouts().map((e) => e.thread.path),
    ["/root/alive"],
    "only the live child reports",
  );
  await spawn("late", 60_000);
  await manager.shutdown();
  t.mock.timers.tick(120_000);
  assert.equal(timeouts().length, 1, "shutdown clears pending timers");
});

test("steer timeoutMs-only re-arms from now; invalid ranges are rejected; unset means none", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, spawn, timeouts, flush } = setup();
  for (const bad of [0, 29_999, 300_001, 1.5, Number.NaN])
    await assert.rejects(spawn(`bad${bad}`, bad), /timeoutMs must be an integer between 30000/);
  await spawn("plain");
  await spawn("a", 30_000);
  await flush();
  t.mock.timers.tick(20_000);
  for (const bad of [10, 300_001])
    await assert.rejects(manager.steer("/root", "a", undefined, bad), /between 30000/);
  await manager.steer("/root", "a", undefined, 60_000);
  t.mock.timers.tick(59_999);
  assert.equal(timeouts().length, 0, "old deadline replaced");
  t.mock.timers.tick(1);
  assert.deepEqual(
    timeouts().map((e) => e.thread.path),
    ["/root/a"],
  );
  t.mock.timers.tick(300_000);
  assert.equal(timeouts().length, 1, "plain child never times out");
  gates.forEach((g) => g());
  await manager.wait("/root", "a");
  await assert.rejects(manager.steer("/root", "a", undefined, 30_000), /working agent/);
  await assert.rejects(manager.steer("/root", "a"), /message, timeoutMs, or both/);
  await manager.shutdown();
});

test("settled events flag detached spawns; outstandingAsync tracks them", async () => {
  const { manager, events, gates, spawn, flush } = setup();
  await spawn("bg");
  await flush();
  assert.equal(manager.outstandingAsync(), 1);
  gates[0]!();
  await manager.wait("/root", "bg");
  await flush();
  assert.equal(manager.outstandingAsync(), 0);
  const settled = events.find((e) => e.kind === "settled") as any;
  assert.equal(settled.async, true);
  await manager.shutdown();
});

test("tool schemas expose timeoutMs and agent_steer timeoutMs with 30s–5min bounds", () => {
  const tools = agentTools(
    () => ({}) as any,
    "/root",
    () => [],
    () => ({}) as any,
  );
  const spawn = tools.find((t) => t.name === "agent_spawn")!;
  const props = (spawn.parameters as any).properties.timeoutMs;
  assert.equal(props.minimum, 30000);
  assert.equal(props.maximum, 300000);
  assert.equal(tools.find((t) => t.name === "agent_extend_timeout"), undefined);
  const steer = tools.find((t) => t.name === "agent_steer")!;
  assert.equal((steer.parameters as any).properties.timeoutMs.minimum, 30000);
  assert.equal((steer.parameters as any).properties.timeoutMs.maximum, 300000);
  assert.deepEqual((steer.parameters as any).required, ["path"]);
});

test("steer with message and timeoutMs steers and re-arms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, spawn, timeouts, flush } = setup();
  await spawn("a", 30_000);
  await flush();
  t.mock.timers.tick(20_000);
  await manager.steer("/root", "a", "keep going", 60_000);
  t.mock.timers.tick(59_999);
  assert.equal(timeouts().length, 0);
  t.mock.timers.tick(1);
  assert.equal(timeouts().length, 1);
  gates.forEach((g) => g());
  await manager.shutdown();
});

