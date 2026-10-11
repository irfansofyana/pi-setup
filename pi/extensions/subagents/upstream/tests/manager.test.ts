import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ThreadManager } from "../src/orch/manager.ts";
import { TranscriptChannel } from "../src/orch/transcript.ts";
import type {
  AgentDriver,
  AgentType,
  DriverOptions,
  ManagerOptions,
  SavedThread,
  SavedThreadView,
  ThreadEvent,
  TranscriptSnapshot,
} from "../src/types.ts";

const user = (text: string): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const workerType: AgentType = { name: "worker", description: "test", systemPrompt: "child prompt" };

/** A driver whose prompt records the message and blocks until `release()`. */
function gated(overrides: Partial<AgentDriver> = {}) {
  let release = () => {};
  const runs: string[] = [];
  const driver: AgentDriver = {
    prompt: (message) => {
      runs.push(message);
      return new Promise<void>((resolve) => (release = resolve));
    },
    steer: async () => {},
    snapshot: () => [],
    output: () => `answer: ${runs.at(-1)}`,
    abort: async () => release(),
    dispose: () => {},
    sendUpdate: () => {},
    ...overrides,
  };
  return { driver, runs, release: () => release() };
}

function saved(
  path: string,
  view: Partial<SavedThreadView> = {},
  extra: Partial<SavedThread> = {},
): SavedThread {
  const parent = path.slice(0, path.lastIndexOf("/"));
  return {
    view: {
      path,
      parent,
      owner: parent,
      type: "worker",
      state: "paused",
      task: "task",
      status: "Paused",
      createdAt: 0,
      ...view,
    },
    definition: workerType,
    ...extra,
  };
}

function fixture(extra: Partial<ManagerOptions> = {}) {
  const drivers = new Map<
    string,
    {
      options: DriverOptions;
      driver: AgentDriver;
      finish: () => void;
      steering: string[];
      messages: AgentMessage[];
      runs: string[];
      disposed: boolean;
    }
  >();
  const events: ThreadEvent[] = [];
  const root = [user("root context")];
  const manager = new ThreadManager({
    rootSnapshot: () => root,
    getType: (name) => ({ ...workerType, name }),
    toolsFor: () => [],
    onEvent: (event) => events.push(event),
    createDriver: async (options) => {
      let finish = () => {};
      const data = {
        options,
        driver: {} as AgentDriver,
        finish: () => finish(),
        steering: [] as string[],
        messages: structuredClone(options.inherited),
        runs: [] as string[],
        disposed: false,
      };
      data.driver = {
        sessionFile: `/tmp/${options.path.replaceAll("/", "-")}.jsonl`,
        prompt: async (message) => {
          data.runs.push(message);
          data.messages.push(user(message));
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        steer: async (message) => {
          assert.ok(data.runs.length, "initial task must be prompted before steering");
          data.steering.push(message);
        },
        snapshot: () => data.messages,
        output: () => `answer: ${data.runs.at(-1)}`,
        abort: async () => {
          finish();
        },
        dispose: () => {
          data.disposed = true;
        },
        sendUpdate: (message) => {
          data.messages.push(user(message));
        },
      };
      drivers.set(options.path, data);
      return data.driver;
    },
    ...extra,
  });
  return { manager, drivers, events, root };
}

test("spawn snapshots only lexical parent; independent roots have no root context", async () => {
  const { manager, drivers, root } = fixture();
  await manager.spawn("/root", { path: "worker", type: "worker", task: "do work", wait: false });
  await tick();
  assert.deepEqual(drivers.get("/root/worker")!.options.inherited, root);
  root.push(user("later root message"));
  assert.equal(drivers.get("/root/worker")!.options.inherited.length, 1);
  await manager.spawn("/root", { path: "/k", type: "worker", task: "separate", wait: false });
  await tick();
  assert.deepEqual(drivers.get("/k")!.options.inherited, []);
  await manager.spawn("/root", { path: "/k/l", type: "worker", task: "nested", wait: false });
  await tick();
  assert.deepEqual(
    drivers.get("/k/l")!.options.inherited,
    [user("separate")].map((message) => ({
      ...message,
      timestamp: drivers.get("/k")!.messages[0].timestamp,
    })),
  );
  assert.equal(
    drivers.get("/k/l")!.options.parentSessionFile,
    drivers.get("/k")!.driver.sessionFile,
  );
  await assert.rejects(
    manager.spawn("/root/worker", { path: "/k/forbidden", type: "worker", task: "cross-tree" }),
    /descendants/,
  );
  await manager.shutdown();
});

test("pause stops without handback; completed and paused revive SAME driver", async () => {
  const { manager, drivers, events } = fixture();
  const waiting = manager.spawn("/root", { path: "worker", type: "worker", task: "first" });
  await tick();
  const data = drivers.get("/root/worker")!;
  manager.pause("/root/worker", "need feedback");
  data.finish();
  const paused = await waiting;
  assert.equal(paused.state, "paused");
  assert.equal(paused.output, undefined);
  assert.equal(manager.output(paused.path), "");
  assert.ok(events.some((event) => event.kind === "settled" && event.thread.state === "paused"));
  await manager.steer("/root", paused.path, "second");
  await tick();
  data.finish();
  const completed = await manager.wait("/root", paused.path);
  assert.equal(completed.state, "completed");
  assert.equal(completed.output, "answer: second");
  assert.equal(completed.task, "first"); // Stable task label, independent of steering history.
  await manager.steer("/root", paused.path, "third");
  await tick();
  data.finish();
  await manager.wait("/root", paused.path);
  assert.deepEqual(data.runs, ["first", "second", "third"]);
  assert.equal(drivers.size, 1);
  await manager.shutdown();
});

test("busy steering queues while progress stays nonfinal and goes to parent", async () => {
  const { manager, drivers, events } = fixture();
  await manager.spawn("/root", { path: "worker", type: "worker", task: "task", wait: false });
  await manager.steer("/root", "worker", "more detail");
  assert.deepEqual(drivers.get("/root/worker")!.steering, ["more detail"]);
  manager.update("/root/worker", "halfway");
  assert.ok(events.some((event) => event.kind === "update" && event.recipient === "/root"));
  assert.equal(manager.get("worker").state, "running");
  await manager.shutdown();
});

test("concurrent steer after failed startup reserves one restart and queues the next", async () => {
  let rejectFirst!: (error: Error) => void;
  let attempts = 0;
  const steering: string[] = [];
  const { driver, runs, release } = gated({
    steer: async (message) => {
      assert.ok(runs.length, "restart must prompt before queued steering");
      steering.push(message);
    },
  });
  const { manager } = fixture({
    createDriver: async () =>
      ++attempts === 1
        ? new Promise<AgentDriver>((_resolve, reject) => (rejectFirst = reject))
        : driver,
  });

  await manager.spawn("/root", { path: "worker", type: "worker", task: "first", wait: false });
  await tick();
  const first = manager.steer("/root", "worker", "retry");
  const second = manager.steer("/root", "worker", "queued");
  rejectFirst(new Error("bad model"));
  await Promise.all([first, second]);
  await tick();
  assert.equal(attempts, 2);
  assert.deepEqual(runs, ["retry"]);
  assert.deepEqual(steering, ["queued"]);
  release();
  assert.equal((await manager.wait("/root", "worker")).output, "answer: retry");
  await manager.shutdown();
});

test("nested child reopens its parent first; a failed parent open is retried later", async () => {
  let rejectParentOpen!: (error: Error) => void;
  let parentAttempts = 0;
  const childInherited: AgentMessage[][] = [];
  const parent = gated({ sessionFile: "/tmp/worker.jsonl" });
  parent.driver.snapshot = () => parent.runs.map((text) => ({ ...user(text), timestamp: 0 }));
  const child = gated();
  const { manager } = fixture({
    createDriver: async (options) => {
      if (options.path === "/root/worker") {
        if (++parentAttempts === 1)
          return new Promise<AgentDriver>((_resolve, reject) => (rejectParentOpen = reject));
        return parent.driver;
      }
      childInherited.push(structuredClone(options.inherited));
      return child.driver;
    },
  });
  manager.restore([saved("/root/worker", { sessionFile: "/tmp/saved-parent.jsonl" })]);

  await manager.spawn("/root", {
    path: "worker/child",
    type: "worker",
    task: "nested",
    wait: false,
  });
  rejectParentOpen(new Error("parent unavailable"));
  assert.equal((await manager.wait("/root", "worker/child")).state, "failed");
  assert.equal(childInherited.length, 0);

  await manager.steer("/root", "worker", "resume parent");
  await tick();
  parent.release();
  await manager.wait("/root", "worker");
  await manager.steer("/root", "worker/child", "resume child");
  await tick();
  assert.equal(parentAttempts, 2);
  assert.deepEqual(childInherited, [parent.driver.snapshot()]);
  child.release();
  assert.equal((await manager.wait("/root", "worker/child")).state, "completed");
  await manager.shutdown();
});

test("restored nested child opens parent first but keeps its saved inherited snapshot", async () => {
  const order: string[] = [];
  const childInherited: AgentMessage[][] = [];
  const savedChildSnapshot = [user("saved child snapshot")];
  const child = gated();
  const { manager } = fixture({
    createDriver: async (options) => {
      order.push(options.path);
      if (options.path === "/root/parent")
        return gated({ prompt: async () => {}, snapshot: () => [user("live parent")] }).driver;
      childInherited.push(structuredClone(options.inherited));
      return child.driver;
    },
  });
  manager.restore([
    saved("/root/parent", { sessionFile: "/tmp/saved-parent.jsonl" }),
    saved("/root/parent/child", {}, { inherited: savedChildSnapshot }),
  ]);
  await manager.steer("/root", "parent/child", "resume child");
  await tick();
  assert.deepEqual(order, ["/root/parent", "/root/parent/child"]);
  assert.deepEqual(childInherited, [savedChildSnapshot]);
  child.release();
  assert.equal((await manager.wait("/root", "parent/child")).state, "completed");
  await manager.shutdown();
});

test("cancelling a wait or timing out does not stop detached child", async () => {
  const { manager, drivers } = fixture();
  await manager.spawn("/root", { path: "worker", type: "worker", task: "task", wait: false });
  await tick();
  const abort = new AbortController();
  const waiting = manager.wait("/root", "worker", undefined, abort.signal);
  abort.abort();
  await assert.rejects(waiting, /Waiting cancelled/);
  assert.equal((await manager.wait("/root", "worker", 0)).state, "running");
  drivers.get("/root/worker")!.finish();
  assert.equal((await manager.wait("/root", "worker")).state, "completed");
  await manager.shutdown();
});

test("stop cascades but retains sessions, and children cannot wait on ancestors", async () => {
  const { manager, drivers } = fixture({ maxLevels: 4 });
  await manager.spawn("/root", { path: "worker", type: "worker", task: "parent", wait: false });
  await tick();
  await manager.spawn("/root/worker", {
    path: "child",
    type: "worker",
    task: "child",
    wait: false,
  });
  await tick();
  await manager.spawn("/root/worker", {
    path: "finished",
    type: "worker",
    task: "finished",
    wait: false,
  });
  await tick();
  drivers.get("/root/worker/finished")!.finish();
  await manager.wait("/root", "/root/worker/finished");
  await assert.rejects(manager.wait("/root/worker/child", "/root/worker"), /descendants/);
  await assert.rejects(manager.stop("/root/worker", "/root/worker"), /descendants/);
  assert.equal((await manager.stop("/root", "worker")).state, "stopped");
  assert.equal(manager.get("/root/worker/child").state, "stopped");
  assert.equal(manager.get("/root/worker/finished").state, "completed");
  await assert.rejects(
    manager.steer("/root", "worker/finished", "continue finished"),
    /stopped ancestor/,
  );
  await assert.rejects(
    manager.spawn("/root", {
      path: "worker/finished/new",
      type: "worker",
      task: "work",
      wait: false,
    }),
    /stopped ancestor/,
  );
  assert.equal(drivers.get("/root/worker")!.disposed, false);
  await manager.steer("/root", "worker", "continue");
  await tick();
  drivers.get("/root/worker")!.finish();
  assert.equal((await manager.wait("/root", "worker")).state, "completed");
  await manager.shutdown();
  assert.equal(drivers.get("/root/worker")!.disposed, true);
});

test("duplicate concurrent spawn is rejected and concurrency/depth limits apply", async () => {
  const { manager } = fixture({ maxConcurrent: 1, maxDepth: 1 });
  const results = await Promise.allSettled([
    manager.spawn("/root", { path: "worker", type: "worker", task: "task", wait: false }),
    manager.spawn("/root", { path: "worker", type: "worker", task: "task", wait: false }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(
    manager.spawn("/root", { path: "other", type: "worker", task: "task", wait: false }),
    /Concurrent/,
  );
  await assert.rejects(
    manager.spawn("/root", { path: "worker/child", type: "worker", task: "task", wait: false }),
    /depth/,
  );
  await manager.shutdown();
});

test("save/restore retains definition snapshot and reopens JSONL on resume", async () => {
  const first = fixture();
  await first.manager.spawn("/root", { path: "worker", type: "worker", task: "work", wait: false });
  await tick();
  const saved = first.manager.saved();
  await first.manager.shutdown();

  const second = fixture();
  assert.throws(
    () => second.manager.restore([{ ...saved[0], view: { ...saved[0].view, parent: "/wrong" } }]),
    /Invalid saved parent/,
  );
  assert.deepEqual(second.manager.list(), []); // Restore is atomic on corrupt registries.
  second.manager.restore(saved);
  assert.equal(second.manager.get("worker").state, "paused");
  assert.match(second.manager.get("worker").status, /Interrupted/);
  await second.manager.spawn("/root", {
    path: "worker/child",
    type: "worker",
    task: "nested",
    wait: false,
  });
  const pending = second.manager.saved();
  const pendingChild = pending.find((thread) => thread.view.path === "/root/worker/child");
  assert.ok(pendingChild);
  assert.equal(Object.prototype.hasOwnProperty.call(pendingChild, "inherited"), false);
  await second.manager.shutdown();

  const third = fixture();
  third.manager.restore(pending);
  await third.manager.deliver("/root/worker", "child progress while parent is unopened");
  assert.equal(third.drivers.get("/root/worker")!.messages.at(-1)?.role, "user");
  assert.match(JSON.stringify(third.drivers.get("/root/worker")!.messages), /child progress/);
  const inspected = JSON.parse(await third.manager.transcript("/root", "worker/child"));
  assert.deepEqual(inspected, third.drivers.get("/root/worker")!.messages);
  assert.deepEqual(third.drivers.get("/root/worker/child")!.options.inherited, inspected);
  await third.manager.steer("/root", "worker", "resume");
  await tick();
  assert.equal(third.drivers.get("/root/worker")!.options.sessionFile, saved[0].view.sessionFile);
  await third.manager.steer("/root", "worker/child", "resume child");
  await tick();
  assert.deepEqual(third.drivers.get("/root/worker/child")!.options.inherited, inspected);
  third.drivers.get("/root/worker/child")!.finish();
  await third.manager.wait("/root", "worker/child");
  third.drivers.get("/root/worker")!.finish();
  await third.manager.wait("/root", "worker");
  await third.manager.shutdown();
});

test("retained thread resumes its saved definition even after the type is removed", async () => {
  const original: AgentType = {
    ...workerType,
    description: "Legacy worker",
    thinkingLevel: "low",
    tools: { allow: ["read", "agent_update", "agent_pause"] },
  };
  const first = fixture({ getType: () => original });
  await first.manager.spawn("/root", { path: "worker", type: "worker", task: "work", wait: false });
  await tick();
  const snapshot = first.manager.saved();
  await first.manager.shutdown();

  const second = fixture({
    getType: () => {
      throw new Error("worker is no longer bundled");
    },
  });
  second.manager.restore(snapshot);
  await second.manager.steer("/root", "worker", "continue");
  await tick();
  const driver = second.drivers.get("/root/worker")!;
  assert.deepEqual(driver.options.type, original);
  assert.deepEqual(second.manager.saved()[0].definition, original);
  assert.equal(driver.options.sessionFile, snapshot[0].view.sessionFile);
  driver.finish();
  assert.equal((await second.manager.wait("/root", "worker")).state, "completed");
  await second.manager.shutdown();
});

test("startup failure returns a failed thread and does not reject spawn", async () => {
  const { manager } = fixture({
    createDriver: async () => {
      throw new Error("bad model");
    },
  });
  const result = await manager.spawn("/root", { path: "worker", type: "worker", task: "task" });
  assert.equal(result.state, "failed");
  assert.equal(result.error, "bad model");
  await manager.shutdown();
});

test("partial usage is live-only; final usage persists and elapsed freezes across runs", async () => {
  let run = 0;
  let releaseFinal = () => {};
  let emitPartialDone = () => {};
  const { manager, events } = fixture({
    createDriver: async (options) =>
      gated({
        prompt: async () => {
          if (++run === 1) {
            options.onEvent({
              kind: "usage",
              inputTokens: 11,
              outputTokens: 2,
              costUsd: 0.01,
              partial: true,
            });
            await new Promise<void>((resolve) => (emitPartialDone = resolve));
            options.onEvent({ kind: "usage", inputTokens: 15, outputTokens: 4, costUsd: 0.02 });
            await new Promise<void>((resolve) => (releaseFinal = resolve));
            return;
          }
          options.onEvent({ kind: "usage", inputTokens: 21, outputTokens: 7, costUsd: 0.03 });
        },
        abort: async () => {
          emitPartialDone();
          releaseFinal();
        },
      }).driver,
  });

  await manager.spawn("/root", { path: "worker", type: "worker", task: "work", wait: false });
  await tick();
  const live = manager.get("worker");
  assert.equal(live.inputTokens, 11);
  assert.equal(live.costUsd, 0.01);
  assert.equal(typeof live.startedAt, "number");
  assert.ok(events.some((event) => event.kind === "metrics" && event.thread.inputTokens === 11));
  const persisted = manager.saved()[0].view;
  assert.equal(persisted.inputTokens, 0);
  assert.equal(persisted.costUsd, undefined);
  assert.equal(Object.hasOwn(persisted, "startedAt"), false);

  emitPartialDone();
  await tick();
  assert.equal(manager.saved()[0].view.inputTokens, 15);
  assert.equal(manager.saved()[0].view.costUsd, 0.02);
  await delay(20);
  releaseFinal();
  const completed = await manager.wait("/root", "worker");
  assert.equal(completed.startedAt, undefined);
  assert.equal(completed.outputTokens, 4);
  assert.ok((completed.elapsedMs ?? 0) >= 20);
  const frozen = completed.elapsedMs!;
  await delay(20);
  assert.equal(manager.get("worker").elapsedMs, frozen);

  await manager.steer("/root", "worker", "continue");
  await tick();
  const resumed = await manager.wait("/root", "worker");
  assert.equal(resumed.inputTokens, 21);
  assert.equal(resumed.costUsd, 0.03);
  assert.ok((resumed.elapsedMs ?? 0) >= frozen);
  const snapshot = manager.saved();
  await manager.shutdown();

  const restored = fixture();
  restored.manager.restore(snapshot);
  await delay(20);
  assert.equal(restored.manager.get("worker").elapsedMs, snapshot[0].view.elapsedMs);
  assert.equal(restored.manager.get("worker").inputTokens, 21);
  assert.equal(restored.manager.get("worker").costUsd, 0.03);
  assert.equal(restored.manager.get("worker").startedAt, undefined);
  await restored.manager.shutdown();
});

test("restore defaults missing metrics to zero and resumed usage adds to saved totals", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  for (const [view, expected] of [
    [{}, { elapsedMs: 0, inputTokens: 4, outputTokens: 2 }],
    [
      { elapsedMs: 80, inputTokens: 10, outputTokens: 3, costUsd: 0.05 },
      { elapsedMs: 80, inputTokens: 14, outputTokens: 5 },
    ],
  ] as const) {
    let emit = () => {};
    const { manager } = fixture({
      createDriver: async (options) =>
        gated({
          prompt: async () => {
            emit = () =>
              options.onEvent({ kind: "usage", inputTokens: 4, outputTokens: 2, costUsd: 0.01 });
          },
        }).driver,
    });
    manager.restore([saved("/root/worker", { sessionFile: "/tmp/legacy.jsonl", ...view })]);
    assert.equal(manager.get("worker").inputTokens, view.inputTokens ?? 0);
    assert.equal(manager.get("worker").elapsedMs, view.elapsedMs ?? 0);
    await manager.steer("/root", "worker", "resume");
    await tick();
    emit();
    const thread = manager.get("worker");
    assert.equal(thread.inputTokens, expected.inputTokens);
    assert.equal(thread.outputTokens, expected.outputTokens);
    assert.ok(Math.abs(thread.costUsd! - (("costUsd" in view ? view.costUsd : 0) + 0.01)) < 1e-10);
    assert.equal(manager.saved()[0].view.costUsd, thread.costUsd);
    assert.equal(manager.saved()[0].view.inputTokens, expected.inputTokens);
    assert.equal(thread.elapsedMs, expected.elapsedMs);
    await manager.shutdown();
  }
});

test("scoped observation attaches while starting, persists no deltas, and disposes independently", async () => {
  let open!: (driver: AgentDriver) => void;
  let created = 0;
  let detached = 0;
  let aborts = 0;
  const events: ThreadEvent[] = [];
  const messages: AgentMessage[] = [user("parent")];
  const channel = new TranscriptChannel(() => messages, 1);
  const worker = gated({
    snapshot: () => structuredClone(messages),
    observeTranscript: (listener) => {
      const observation = channel.observe(listener);
      return {
        snapshot: observation.snapshot,
        unsubscribe: () => {
          detached++;
          observation.unsubscribe();
        },
      };
    },
    abort: async () => {
      aborts++;
      worker.release();
    },
    dispose: () => channel.dispose(),
  });
  const manager = new ThreadManager({
    rootSnapshot: () => messages,
    getType: () => workerType,
    toolsFor: () => [],
    onEvent: (event) => events.push(event),
    createDriver: () => {
      created++;
      return new Promise((resolve) => (open = resolve));
    },
  });
  await manager.spawn("/root", { path: "child", type: "worker", task: "work", wait: false });
  const updates: TranscriptSnapshot[] = [];
  const first = await manager.scope("/root").observeTranscript!("child", (snapshot) =>
    updates.push(snapshot),
  );
  const second = await manager.scope("/root").observeTranscript!("child", () => {});
  assert.equal(first.snapshot.thread?.state, "starting");
  assert.equal(first.snapshot.generation, 0);
  assert.equal(first.snapshot.assistant, null);
  await tick();
  assert.equal(created, 1, "inspection reuses startup initialization");
  open(worker.driver);
  await tick();
  assert.equal(updates.at(-1)?.thread?.state, "running");
  assert.equal(updates.at(-1)?.generation, 1);
  const persistedEvents = events.length;
  const beforeRevision = updates.at(-1)!.revision;
  channel.accept({ type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: {} });
  channel.accept({
    type: "tool_execution_update",
    toolCallId: "tool",
    toolName: "read",
    args: {},
    partialResult: { content: [{ type: "text", text: "streaming" }] },
  });
  assert.equal(
    events.length,
    persistedEvents,
    "stream events never enter persisted manager events",
  );
  assert.equal(updates.at(-1)?.tools[0]?.state, "running");
  assert.ok(updates.at(-1)!.revision > beforeRevision);
  first.unsubscribe();
  assert.equal(detached, 0, "other observer keeps shared subscription alive");
  const firstCount = updates.length;
  channel.accept({
    type: "tool_execution_end",
    toolCallId: "tool",
    toolName: "read",
    result: {},
    isError: false,
  });
  assert.equal(updates.length, firstCount);
  second.unsubscribe();
  second.unsubscribe();
  assert.equal(detached, 1, "unsubscribe is idempotent");
  assert.equal(aborts, 0, "closing observers never aborts the worker");
  const reopened = await manager.scope("/root").observeTranscript!("child", (snapshot) =>
    updates.push(snapshot),
  );
  assert.equal(
    reopened.snapshot.tools[0]?.state,
    "completed",
    "reopening uses retained midstream driver state",
  );
  await manager.shutdown();
  assert.equal(detached, 2, "shutdown detaches before disposing the driver");
  const count = updates.length;
  channel.accept({ type: "agent_settled" });
  assert.equal(updates.length, count);
  await assert.rejects(
    manager.scope("/root").observeTranscript!("child", () => {}),
    /shut down/,
  );
});

test("restored transcript observation is read-only and enforces scope", async () => {
  const { manager, drivers } = fixture();
  manager.restore([
    saved("/root/a", { state: "completed", sessionFile: "/tmp/a.jsonl" }),
    saved("/root/b", { state: "paused", sessionFile: "/tmp/b.jsonl" }),
  ]);
  const observation = await manager.scope("/root").observeTranscript!("a", () => {});
  assert.equal(observation.snapshot.thread?.state, "completed");
  assert.equal(observation.snapshot.generation, 1);
  assert.deepEqual(drivers.get("/root/a")?.runs, [], "read-only loading never prompts");
  assert.deepEqual(drivers.get("/root/a")?.steering, []);
  await assert.rejects(
    manager.scope("/root/a").observeTranscript!("/root/b", () => {}),
    /descendants/,
  );
  await assert.rejects(
    manager.scope("/root").observeTranscript!("/root", () => {}),
    /not a child/,
  );
  await assert.rejects(
    manager.scope("/root").observeTranscript!("missing", () => {}),
    /Unknown thread/,
  );
  observation.unsubscribe();
  await manager.shutdown();
});

test("reap frees retained slots, disposes drivers, and removes durable records", async () => {
  const { manager, drivers } = fixture({ maxThreads: 1 });
  await manager.spawn("/root", { path: "old", type: "worker", task: "old", wait: false });
  await tick();
  drivers.get("/root/old")!.finish();
  await manager.wait("/root", "old");
  await assert.rejects(
    manager.spawn("/root", { path: "new", type: "worker", task: "new", wait: false }),
    /Total thread limit/,
  );
  assert.deepEqual(manager.reap(), ["/root/old"]);
  assert.equal(drivers.get("/root/old")!.disposed, true);
  assert.deepEqual(manager.saved(), []);
  assert.throws(() => manager.get("/root/old"), /Unknown thread/);
  assert.deepEqual(manager.reap(), []);
  await manager.spawn("/root", { path: "new", type: "worker", task: "new", wait: false });
  assert.deepEqual(manager.reap(), [], "running agents survive");
  await manager.shutdown();
});

test("reap preserves non-completed threads and their completed ancestors", async () => {
  const { manager } = fixture();
  manager.restore([
    saved("/root/parent", { state: "completed", createdAt: 1 }),
    saved("/root/parent/done", { state: "completed", createdAt: 2 }),
    saved("/root/parent/paused", { state: "paused" }),
    saved("/root/stopped", { state: "stopped" }),
    saved("/root/failed", { state: "failed" }),
    saved("/root/newer", { state: "completed", createdAt: 10 }),
    saved("/root/older", { state: "completed", createdAt: 0 }),
    saved("/root/tree", { state: "completed", createdAt: 3 }),
    saved("/root/tree/child", { state: "completed", createdAt: 4 }),
  ]);
  assert.deepEqual(manager.reap(), [
    "/root/older",
    "/root/parent/done",
    "/root/tree",
    "/root/tree/child",
    "/root/newer",
  ]);
  assert.deepEqual(
    manager.list().map((thread) => thread.path),
    ["/root/parent", "/root/parent/paused", "/root/stopped", "/root/failed"],
  );
  await manager.shutdown();
});

test("reap keeps completed children available to an active parent", async () => {
  const { manager, drivers } = fixture();
  await manager.spawn("/root", { path: "parent", type: "worker", task: "parent", wait: false });
  await tick();
  await manager.spawn("/root/parent", {
    path: "child",
    type: "worker",
    task: "child",
    wait: false,
  });
  await tick();
  drivers.get("/root/parent/child")!.finish();
  await manager.wait("/root", "/root/parent/child");
  assert.deepEqual(manager.reap(), []);
  drivers.get("/root/parent")!.finish();
  await manager.wait("/root", "parent");
  assert.deepEqual(manager.reap(), ["/root/parent", "/root/parent/child"]);
  await manager.shutdown();
});

test("reap preview is read-only and excludes agents completed after confirmation started", async () => {
  const { manager, drivers } = fixture();
  await manager.spawn("/root", { path: "old", type: "worker", task: "old", wait: false });
  await manager.spawn("/root", { path: "new", type: "worker", task: "new", wait: false });
  await tick();
  drivers.get("/root/old")!.finish();
  await manager.wait("/root", "old");
  const candidates = manager.reapCandidates();
  assert.deepEqual(candidates, ["/root/old"]);
  assert.equal(drivers.get("/root/old")!.disposed, false);
  assert.equal(manager.saved().length, 2);
  drivers.get("/root/new")!.finish();
  await manager.wait("/root", "new");
  assert.deepEqual(manager.reap(candidates), ["/root/old"]);
  assert.equal(manager.get("/root/new").state, "completed");
  await manager.shutdown();
});

test("confirmed reap revalidates resumed descendants and preserves their ancestors", async () => {
  const { manager, drivers } = fixture();
  await manager.spawn("/root", { path: "parent", type: "worker", task: "parent", wait: false });
  await tick();
  await manager.spawn("/root/parent", {
    path: "child",
    type: "worker",
    task: "child",
    wait: false,
  });
  await tick();
  drivers.get("/root/parent/child")!.finish();
  await manager.wait("/root", "/root/parent/child");
  drivers.get("/root/parent")!.finish();
  await manager.wait("/root", "parent");
  const candidates = manager.reapCandidates();
  assert.equal(candidates.length, 2);
  await manager.steer("/root", "/root/parent/child", "Continue");
  assert.deepEqual(manager.reap(candidates), []);
  assert.equal(manager.list().length, 2);
  await manager.shutdown();
});

