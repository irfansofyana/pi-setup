import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ThreadManager } from "../src/orch/manager.ts";
import { DEFAULT_MANAGER_SETTINGS } from "../src/prefs/settings.ts";
import type { ManagerOptions } from "../src/types.ts";
import { registry, withOfflineHarness } from "./helpers/integrationHarness.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(t: TestContext, options: Partial<ManagerOptions> = {}) {
  const running = new Map<string, () => void>();
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => ({ name, description: "Test coordinator", systemPrompt: "Coordinate" }),
    toolsFor: () => [],
    createDriver: async ({ path }) => ({
      prompt: async () => {
        await new Promise<void>((resolve) => running.set(path, resolve));
      },
      steer: async () => {},
      snapshot: () => [],
      output: () => "done",
      abort: async () => {
        running.get(path)?.();
      },
      dispose: () => {},
      sendUpdate: () => {},
    }),
    ...options,
  });
  t.after(() => manager.shutdown());
  const spawn = (caller: string, path: string) =>
    manager.scope(caller).spawn({ path, type: "worker", task: "Work", wait: false });
  return { manager, running, spawn };
}

test("level limits apply equally to normal and independent roots", async (t) => {
  // maxLevels -> number of agent levels allowed below the main thread.
  for (const [settings, allowed] of [
    [{ maxLevels: 1 }, 0],
    [{}, 2], // default three levels
    [{ maxLevels: 4 }, 3],
  ] as const) {
    const { spawn } = fixture(t, settings);
    for (const top of ["/root/a", "/k"]) {
      let parent = "/root";
      for (let level = 0; level < allowed; level++) {
        const child = level === 0 ? top : `l${level + 2}`;
        await spawn(parent, child);
        parent = level === 0 ? top : `${parent}/${child}`;
      }
      await assert.rejects(spawn(parent, "deep"), /depth limit/);
      // Main-thread authority must not bypass the level limit either.
      if (allowed) await assert.rejects(spawn("/root", `${parent}/deep`), /depth limit/);
    }
  }
});

test("updated limits affect future spawns without cancelling existing threads", async (t) => {
  const { manager, spawn } = fixture(t);
  await spawn("/root", "a");
  await tick();
  manager.setLimits({ ...DEFAULT_MANAGER_SETTINGS, maxLevels: 2, maxConcurrent: 2, maxThreads: 3 });
  await assert.rejects(spawn("/root/a", "b"), /depth limit/);
  await spawn("/root", "b");
  await tick();
  assert.equal(manager.get("/root/a").state, "running");
  await assert.rejects(spawn("/root", "c"), /concurrent/i);
  manager.setLimits({ ...DEFAULT_MANAGER_SETTINGS, maxLevels: 3, maxConcurrent: 4, maxThreads: 3 });
  await spawn("/root/a", "b");
  await assert.rejects(spawn("/root", "c"), /thread limit/i);
});

const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const spawnPair = (names: string[]): AssistantMessage => ({
  ...answer(""),
  stopReason: "toolUse",
  content: names.map((path) => ({
    type: "toolCall",
    id: `spawn-${path}`,
    name: "agent_spawn",
    arguments: { path, type: "coordinator", task: "Coordinate", wait: true },
  })),
});

test("real SDK same-turn foreground spawns overlap at L2 and L3", { timeout: 15000 }, async () => {
  const leaves = new Set<string>();
  const finished: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let expired = false;
  const watchdog = setTimeout(() => {
    expired = true;
    release();
  }, 8000);
  try {
    await withOfflineHarness(
      {
        agentFiles: {
          coordinator:
            "---\nname: coordinator\ndescription: Offline coordinator\ntools:\n  allow: [agent_spawn, agent_wait]\n---\nCoordinate independent tasks.\n",
        },
        async onRequest(request) {
          if (request.pathCall !== 1) return answer("coordinated");
          if (request.path === null) {
            return spawnPair(["a", "b"]);
          }
          if (request.path === "/root/a" || request.path === "/root/b")
            return spawnPair(["x", "y"]);
          assert.match(request.path, /^\/root\/[ab]\/[xy]$/);
          leaves.add(request.path);
          if (leaves.size === 4) release();
          await barrier;
          finished.push(request.path);
          return answer("leaf completed");
        },
      },
      async ({ cwd, errors, open, requests }) => {
        const root = SessionManager.create(cwd);
        const session = await open(root);
        await session.prompt("Launch two coordinators, each with two independent workers");
        assert.equal(expired, false, "all four L3 requests must start before any finishes");
        assert.equal(leaves.size, 4);
        assert.equal(finished.length, 4);
        const threads = registry(root).threads;
        assert.equal(threads.length, 6);
        assert.ok(threads.every((thread) => thread.view.state === "completed"));
        assert.deepEqual(errors, []);
        assert.equal(requests.filter((request) => request.pathCall === 1).length, 7);
      },
    );
  } finally {
    clearTimeout(watchdog);
    release();
  }
});

test("extension reload applies manager settings without reopening the parent", async () => {
  await withOfflineHarness(
    {
      agentFiles: {
        coordinator: "---\nname: coordinator\ndescription: Coordinator\n---\nCoordinate.\n",
      },
      managerSettings: { maxLevels: 1 },
      onRequest: () => answer("completed"),
    },
    async ({ directory, cwd, open, tool, errors }) => {
      const root = SessionManager.create(cwd);
      const session = await open(root);
      const spawn = () =>
        tool<{ state: string }>(session, "agent_spawn", {
          path: "a",
          type: "coordinator",
          task: "Work",
          wait: true,
        });
      await assert.rejects(spawn(), /depth limit/);
      await writeFile(
        join(directory, "subagent-manager", "settings.json"),
        JSON.stringify({ maxLevels: 3 }),
      );
      await session.prompt("/agents reload");
      const result = await spawn();
      assert.equal(result.state, "completed");
      assert.equal(registry(root).threads.length, 1);
      assert.deepEqual(errors, []);
    },
  );
});

