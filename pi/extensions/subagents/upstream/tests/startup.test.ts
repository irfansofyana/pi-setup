import { test } from "node:test";
import assert from "node:assert/strict";
import { ThreadManager } from "../src/orch/manager.ts";
import type { AgentDriver, DriverOptions } from "../src/types.ts";

// One regression scenario guards reservation visibility, lazy reopen and late-driver cleanup.
test(
  "stop sees reserved children during lazy parent reopen and startup cannot strand shutdown",
  { timeout: 2000 },
  async () => {
    let release!: (driver: AgentDriver) => void;
    let options: DriverOptions | undefined;
    let disposed = false;
    const manager = new ThreadManager({
      rootSnapshot: () => [],
      getType: (name) => ({ name, description: "worker", systemPrompt: "prompt" }),
      toolsFor: () => [],
      createDriver: async (input) => {
        options = input;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    manager.restore([
      {
        view: {
          path: "/root/worker",
          parent: "/root",
          owner: "/root",
          type: "worker",
          state: "paused",
          task: "work",
          status: "Paused",
          createdAt: 0,
          sessionFile: "/tmp/saved.jsonl",
        },
        definition: { name: "worker", description: "worker", systemPrompt: "prompt" },
      },
    ]);
    const child = await manager.spawn("/root", {
      path: "worker/child",
      type: "worker",
      task: "nested",
      wait: false,
    });
    assert.equal(child.state, "starting");
    assert.ok(manager.saved().some((item) => item.view.path === child.path));
    const steering = assert.rejects(
      manager.steer("/root", child.path, "later"),
      /stopped ancestor/,
    );
    await manager.stop("/root", "worker");
    await steering;
    assert.equal(manager.get(child.path).state, "stopped");
    assert.equal(options?.signal.aborted, true);
    await assert.rejects(
      manager.spawn("/root/worker", { path: "late", type: "worker", task: "late" }),
      /working agent/,
    );
    await manager.shutdown();
    release({
      prompt: async () => {},
      steer: async () => {},
      snapshot: () => [],
      output: () => "",
      abort: async () => {},
      dispose: () => {
        disposed = true;
      },
      sendUpdate: () => {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, true);
  },
);

test("stopped idle restore reopens read-only with a fresh controller and tracks leaf checkpoints", async () => {
  let options:
    | (DriverOptions & {
        sessionLeafId?: string | null;
      })
    | undefined;
  let releaseUpdate = () => {};
  let delivered = false;
  let currentLeaf: string | null = null;
  const messages = [{ role: "user", content: "restored", timestamp: 0 }];
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => ({ name, description: "worker", systemPrompt: "prompt" }),
    toolsFor: () => [],
    createDriver: async (input) => {
      options = input as DriverOptions & { sessionLeafId?: string | null };
      return {
        sessionFile: "/tmp/saved.jsonl",
        get sessionLeafId() {
          return currentLeaf;
        },
        prompt: async () => {},
        steer: async () => {},
        snapshot: () => messages,
        output: () => "",
        abort: async () => {},
        dispose: () => {},
        sendUpdate: async (message) => {
          messages.push({ role: "user", content: message, timestamp: 1 });
          currentLeaf = "leaf-2";
          input.onEvent({ kind: "checkpoint", text: "persisted" } as never);
          await new Promise<void>((resolve) => {
            releaseUpdate = resolve;
          });
          delivered = true;
        },
      } as AgentDriver;
    },
  });

  manager.restore([
    {
      view: {
        path: "/root/worker",
        parent: "/root",
        owner: "/root",
        type: "worker",
        state: "paused",
        task: "work",
        status: "Paused",
        createdAt: 0,
        sessionFile: "/tmp/saved.jsonl",
        sessionLeafId: null,
      } as any,
      definition: { name: "worker", description: "worker", systemPrompt: "prompt" },
    },
  ]);

  await manager.stop("/root", "worker");
  const pending = manager.deliver("/root/worker", "progress");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(options?.signal.aborted, false);
  assert.equal(Object.prototype.hasOwnProperty.call(options ?? {}, "sessionLeafId"), true);
  assert.equal(options?.sessionLeafId, null);
  assert.equal(delivered, false);
  assert.equal(
    (manager.saved()[0]!.view as { sessionLeafId?: string | null }).sessionLeafId,
    "leaf-2",
  );

  releaseUpdate();
  await pending;
  assert.equal(delivered, true);
  assert.match(await manager.transcript("/root", "worker"), /progress/);
  await manager.shutdown();
});

