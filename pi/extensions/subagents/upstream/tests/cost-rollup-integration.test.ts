import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSession,
  type ExtensionCommandContext,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { COST_ENTRY, CostLedger, type CostRecord } from "../src/orch/cost-ledger.ts";
import type { ThreadView } from "../src/types.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";
import { registry, withOfflineHarness } from "./helpers/integrationHarness.ts";

const worker =
  "---\nname: worker\ndescription: Cost accounting worker\ntools:\n  allow: [agent_pause, agent_update]\n---\nPerform the assigned work.\n";
const answer = (cost: number, text = "Done"): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 10,
    output: 5,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 20,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  },
});
const toolUse = (cost: number, id: string, name: string, args: JsonObject): AssistantMessage => ({
  ...answer(cost),
  stopReason: "toolUse",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const records = (manager: SessionManager): CostRecord[] =>
  manager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === COST_ENTRY ? [entry.data as CostRecord] : [],
    );
const total = (manager: SessionManager): number => {
  const ledger = new CostLedger();
  ledger.restore(manager.getEntries());
  return ledger.totalUsd;
};
const approximately = (actual: number | undefined, expected: number) => {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(actual! - expected) < 1e-10, `expected ${expected}, received ${actual}`);
};
const nativeToolResults = (entries: SessionEntry[]) =>
  entries.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
  );

async function reloadSettings(session: AgentSession) {
  await session.extensionRunner
    .getCommand("agents")!
    .handler("reload", session.extensionRunner.createCommandContext());
}

async function reap(session: AgentSession) {
  // Exercise the real reap command with its confirmation; only the terminal host is fake.
  const driver = createDialogDriver({
    theme: {
      fg: (_token: string, text: string) => text,
      colors: {},
      style: (text: string) => text,
    } as unknown as Theme,
    choices: ["confirm"],
  });
  const base = session.extensionRunner.createCommandContext();
  const ctx = Object.defineProperties(Object.create(base), {
    mode: { value: "tui" },
    hasUI: { value: true },
    ui: {
      value: {
        ...base.ui,
        theme: driver.theme,
        custom: driver.custom,
        setWidget() {},
        notify() {},
      },
    },
  }) as ExtensionCommandContext;
  await session.extensionRunner.getCommand("agents")!.handler("reap", ctx);
}

test(
  "cost rollup counts stop/resume deltas across reload/reopen and retains reaped costs",
  { timeout: 30000 },
  async () => {
    let rootCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: { worker },
        onRequest(request) {
          if (request.path) {
            assert.equal(request.path, "/root/worker");
            return answer(request.pathCall === 1 ? 0.5 : request.pathCall === 2 ? 0.3 : 0.2);
          }
          rootCalls++;
          return rootCalls === 1
            ? toolUse(0.01, "spawn-worker", "agent_spawn", {
                path: "worker",
                type: "worker",
                task: "First run",
                wait: true,
              })
            : answer(0.02, "Main answer");
        },
      },
      async ({ directory, cwd, errors, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        let session = await open(root);
        await session.prompt("Delegate a task");
        const first = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(first.state, "completed");
        approximately(first.costUsd, 0.5);
        approximately(total(root), 0.5);
        const identity = first.costId;
        assert.equal(typeof identity, "string");
        assert.equal(registry(root).threads[0].view.costId, identity);
        assert.deepEqual(records(root), [{ threadId: identity, totalUsd: 0.5 }]);
        const rootResults = nativeToolResults(root.getEntries());
        assert.ok(rootResults.some((result) => result.toolName === "agent_spawn"));
        assert.ok(
          rootResults.every((result) => result.usage === undefined),
          "no synthetic usage in native tool results",
        );
        approximately(
          root
            .getEntries()
            .reduce(
              (sum, entry) =>
                sum +
                (entry.type === "message" && entry.message.role === "assistant"
                  ? entry.message.usage.cost.total
                  : 0),
              0,
            ),
          0.03,
        );

        await reloadSettings(session);
        await reloadSettings(session);
        await session.reload();
        assert.equal(records(root).length, 1);
        const file = root.getSessionFile()!;
        await close(session);
        let restored = SessionManager.open(file);
        session = await open(restored);
        approximately(total(restored), 0.5);
        assert.equal(
          records(restored).length,
          1,
          "recovery must not append already accounted cost",
        );
        await tool(session, "agent_steer", { path: "worker", message: "Second run" });
        const second = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(second.state, "completed");
        assert.equal(second.costId, identity);
        approximately(second.costUsd, 0.8);
        approximately(total(restored), 0.8);
        assert.deepEqual(
          records(restored).map((record) => record.totalUsd),
          [0.5, 0.8],
        );
        await reloadSettings(session);
        await close(session);
        restored = SessionManager.open(file);
        session = await open(restored);
        assert.equal(records(restored).length, 2);
        approximately(total(restored), 0.8);

        await reap(session);
        assert.deepEqual(registry(restored).threads, []);
        approximately(total(restored), 0.8); // Reaping must not remove historical spend.
        const replacement = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "worker",
          task: "Replacement run",
          wait: true,
        });
        await tool(session, "agent_wait", { path: "worker" });
        assert.equal(replacement.state, "completed");
        assert.notEqual(replacement.costId, identity, "a reused path represents a new lifetime");
        approximately(replacement.costUsd, 0.2);
        approximately(total(restored), 1);
        assert.equal(records(restored).length, 3);
        assert.equal(rootCalls, 2, "foreground settlement does not wake the parent");
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "nested parent and child roll up only their own usage, excluding inherited history",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: { worker },
        onRequest(request) {
          assert.ok(request.path, "no root model calls expected");
          if (request.path === "/root/team") return answer(request.pathCall === 1 ? 0.5 : 0.3);
          assert.equal(request.path, "/root/team/child");
          return answer(0.2);
        },
      },
      async ({ cwd, errors, open, tool }) => {
        const root = SessionManager.create(cwd);
        const session = await open(root);
        const parent = await tool<ThreadView>(session, "agent_spawn", {
          path: "team",
          type: "worker",
          task: "Parent work",
          wait: true,
        });
        await tool(session, "agent_wait", { path: "team" });
        const child = await tool<ThreadView>(session, "agent_spawn", {
          path: "team/child",
          type: "worker",
          task: "Nested work",
          wait: true,
        });
        await tool(session, "agent_wait", { path: "team/child" });
        approximately(child.costUsd, 0.2);
        assert.notEqual(child.costId, parent.costId);
        approximately(total(root), 0.7);
        const inherited = SessionManager.open(child.sessionFile!)
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "assistant");
        assert.ok(inherited.length >= 2, "child session includes inherited parent's answer");
        await tool(session, "agent_steer", { path: "team", message: "Parent follow-up" });
        const resumed = await tool<ThreadView>(session, "agent_wait", { path: "team" });
        approximately(resumed.costUsd, 0.8);
        approximately(total(root), 1);
        assert.deepEqual(records(root), [
          { threadId: parent.costId, totalUsd: 0.5 },
          { threadId: child.costId, totalUsd: 0.2 },
          { threadId: parent.costId, totalUsd: 0.8 },
        ]);
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "paused and failed subagent settlements retain their costs without repeating earlier runs",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: { worker },
        onRequest(request) {
          assert.equal(request.path, "/root/worker");
          if (request.pathCall === 1)
            return toolUse(0.5, "pause-worker", "agent_pause", { reason: "Need input" });
          if (request.pathCall === 2)
            return { ...answer(0.3), stopReason: "error", errorMessage: "Offline failure" };
          return answer(0.2);
        },
      },
      async ({ cwd, errors, open, tool }) => {
        const root = SessionManager.create(cwd);
        const session = await open(root);
        const paused = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "worker",
          task: "Pause",
          wait: true,
        });
        await tool(session, "agent_wait", { path: "worker" });
        assert.equal(paused.state, "paused");
        approximately(total(root), 0.5);
        await tool(session, "agent_steer", { path: "worker", message: "Try resumed task" });
        const failed = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(failed.state, "failed");
        approximately(failed.costUsd, 0.8);
        approximately(total(root), 0.8);
        await tool(session, "agent_steer", { path: "worker", message: "Recover failed task" });
        const recovered = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(recovered.state, "completed");
        assert.equal(recovered.costId, paused.costId);
        approximately(total(root), 1);
        assert.deepEqual(
          records(root).map((record) => record.totalUsd),
          [0.5, 0.8, 1],
        );
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "stopping a running subagent rolls up prior message spend only once before resume",
  { timeout: 30000 },
  async () => {
    let release!: (message: AssistantMessage) => void;
    const pendingReply = new Promise<AssistantMessage>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const pendingStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await withOfflineHarness(
      {
        agentFiles: { worker },
        onRequest(request) {
          assert.equal(request.path, "/root/worker");
          if (request.pathCall === 1)
            return toolUse(0.5, "progress-worker", "agent_update", {
              message: "First work complete",
            });
          if (request.pathCall === 2) {
            entered();
            return pendingReply;
          }
          return answer(0.3);
        },
      },
      async ({ cwd, errors, open, tool }) => {
        const root = SessionManager.create(cwd);
        const session = await open(root);
        const spawning = tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "worker",
          task: "Continue until stopped",
          wait: true,
        });
        await pendingStarted;
        approximately(registry(root).threads[0].view.costUsd, 0.5);
        assert.equal(total(root), 0, "running cost is not yet rolled up");
        const stopping = tool<ThreadView>(session, "agent_stop", { path: "worker" });
        // The offline provider is deliberately gated; complete its stream so cooperative abort can settle.
        release(answer(0, "Interrupted"));
        const stopped = await stopping;
        await spawning;
        await tool(session, "agent_wait", { path: "worker" });
        assert.equal(stopped.state, "stopped");
        approximately(stopped.costUsd, 0.5);
        approximately(total(root), 0.5);
        await tool(session, "agent_stop", { path: "worker" });
        assert.equal(records(root).length, 1, "repeated idle stop cannot recount earlier cost");
        await tool(session, "agent_steer", { path: "worker", message: "Continue after stop" });
        const resumed = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(resumed.state, "completed");
        assert.equal(resumed.costId, stopped.costId);
        approximately(resumed.costUsd, 0.8);
        approximately(total(root), 0.8);
        assert.deepEqual(
          records(root).map((record) => record.totalUsd),
          [0.5, 0.8],
        );
        assert.deepEqual(errors, []);
      },
    );
  },
);

