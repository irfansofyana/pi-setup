import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import { registry, withOfflineHarness } from "./helpers/integrationHarness.ts";

const UPDATE_EVENT = "pi-footer:update-widget";
const WIDGET_ID = "subagent_cost";
const worker =
  "---\nname: worker\ndescription: Footer cost worker\ntools:\n  allow: []\n---\nPerform the assigned work.\n";
const answer = (cost: number): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "Done" }],
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

type WidgetUpdate = { widgetId: string; value: string | null };
function footerObserver(updates: WidgetUpdate[], registerFooter = true): ExtensionFactory {
  return (pi) => {
    if (registerFooter) {
      pi.registerCommand("footer", {
        description: "Configure the pi statusline/footer",
        handler: async () => {},
      });
    }
    pi.events.on(UPDATE_EVENT, (payload: unknown) => {
      const update = payload as Partial<WidgetUpdate> | undefined;
      if (update?.widgetId !== WIDGET_ID) return;
      assert.ok(typeof update.value === "string" || update.value === null);
      updates.push(update as WidgetUpdate);
    });
  };
}
function lastValue(updates: WidgetUpdate[]): string | null | undefined {
  return updates.at(-1)?.value;
}
async function reloadSettings(session: AgentSession) {
  await session.extensionRunner
    .getCommand("agents")!
    .handler("reload", session.extensionRunner.createCommandContext());
}

// The real shared event bus is covered here; the offline harness intentionally has no TUI.
test(
  "pi-footer receives only settled subagent dollars and unchanged values after reload/reopen",
  { timeout: 30000 },
  async () => {
    const updates: WidgetUpdate[] = [];
    await withOfflineHarness(
      {
        agentFiles: { worker },
        managerSettings: { costDisplay: "pi-footer-event", nerdFontIcons: false },
        extensionFactories: [footerObserver(updates)],
        onRequest(request) {
          if (!request.path) return answer(0.1);
          assert.equal(request.path, "/root/worker");
          return answer(request.pathCall === 1 ? 0.5 : 0.3);
        },
      },
      async ({ cwd, directory, errors, open, close, tool }) => {
        const manager = SessionManager.create(cwd, path.join(directory, "parents"));
        let session = await open(manager);
        assert.equal(lastValue(updates), "$0.0000", "session start publishes an empty ledger");
        // A root assistant flushes SessionManager's initial buffer to disk. Its own
        // .1 native cost must remain outside the standalone subagent widget.
        await session.prompt("Record a main-agent turn before delegated work");
        assert.equal(lastValue(updates), "$0.0000");
        const first = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "worker",
          task: "First run",
          wait: true,
        });
        await tool(session, "agent_wait", { path: "worker" });
        assert.equal(first.state, "completed");
        assert.equal(lastValue(updates), "$0.5000");
        assert.equal(registry(manager).threads[0].view.costUsd, 0.5);

        await tool(session, "agent_steer", { path: "worker", message: "Second run" });
        const resumed = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(resumed.state, "completed");
        assert.equal(resumed.costId, first.costId);
        assert.equal(lastValue(updates), "$0.8000", "publish .5 + .3, never cumulative .5 + .8");
        assert.ok(!updates.some((update) => update.value === "$1.3000"));

        for (let i = 0; i < 2; i++) {
          const before = updates.length;
          await reloadSettings(session);
          assert.ok(updates.length > before, "settings reload republishes the widget");
          assert.equal(lastValue(updates), "$0.8000");
        }
        const beforeReload = updates.length;
        await session.reload();
        assert.ok(updates.length > beforeReload, "extension reload republishes the widget");
        assert.equal(lastValue(updates), "$0.8000");
        const file = manager.getSessionFile()!;
        await close(session);
        const beforeReopen = updates.length;
        session = await open(SessionManager.open(file));
        assert.ok(updates.length > beforeReopen, "session reopen republishes the widget");
        assert.equal(lastValue(updates), "$0.8000");
        await close(session);

        const beforeFresh = updates.length;
        session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        assert.ok(updates.length > beforeFresh);
        assert.equal(
          lastValue(updates),
          "$0.0000",
          "a replacement session does not retain old dollars",
        );
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "pi-footer cost widget remains unchanged while a resumed agent is still running",
  { timeout: 30000 },
  async () => {
    const updates: WidgetUpdate[] = [];
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (message: AssistantMessage) => void;
    const pending = new Promise<AssistantMessage>((resolve) => {
      release = resolve;
    });
    await withOfflineHarness(
      {
        agentFiles: { worker },
        managerSettings: { costDisplay: "pi-footer-event", nerdFontIcons: false },
        extensionFactories: [footerObserver(updates)],
        onRequest(request) {
          assert.equal(request.path, "/root/worker");
          if (request.pathCall === 1) return answer(0.5);
          entered();
          return pending;
        },
      },
      async ({ cwd, errors, open, tool }) => {
        const session = await open(SessionManager.create(cwd));
        await tool(session, "agent_spawn", {
          path: "worker",
          type: "worker",
          task: "First run",
          wait: true,
        });
        await tool(session, "agent_wait", { path: "worker" });
        assert.equal(lastValue(updates), "$0.5000");
        try {
          await tool(session, "agent_steer", { path: "worker", message: "Wait for more work" });
          await started;
          assert.equal(
            lastValue(updates),
            "$0.5000",
            "a running turn has not settled its new usage",
          );
          release(answer(0.3));
          await tool(session, "agent_wait", { path: "worker" });
          assert.equal(lastValue(updates), "$0.8000");
          assert.deepEqual(errors, []);
        } finally {
          release(answer(0.3));
        }
      },
    );
  },
);

test(
  "pi-footer cost widget includes a Nerd Font icon only with the labs toggle enabled",
  { timeout: 30000 },
  async () => {
    const updates: WidgetUpdate[] = [];
    await withOfflineHarness(
      {
        agentFiles: { worker },
        managerSettings: { costDisplay: "pi-footer-event", nerdFontIcons: true },
        extensionFactories: [footerObserver(updates)],
        onRequest(request) {
          assert.equal(request.path, "/root/worker");
          return answer(0.5);
        },
      },
      async ({ cwd, directory, errors, open, tool }) => {
        const session = await open(SessionManager.create(cwd));
        await tool(session, "agent_spawn", {
          path: "worker",
          type: "worker",
          task: "First run",
          wait: true,
        });
        await tool(session, "agent_wait", { path: "worker" });
        const value = lastValue(updates);
        assert.equal(typeof value, "string");
        assert.match(value!, /\$0\.5000$/);
        assert.match(
          value!,
          /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u,
          "a Nerd Font glyph prefixes the number",
        );
        await writeFile(
          path.join(directory, "subagent-manager", "settings.json"),
          JSON.stringify({ costDisplay: "pi-footer-event", nerdFontIcons: false }),
        );
        await reloadSettings(session);
        assert.equal(lastValue(updates), "$0.5000", "disabling labs removes the icon immediately");
        await writeFile(
          path.join(directory, "subagent-manager", "settings.json"),
          JSON.stringify({ costDisplay: "pi-footer-event", nerdFontIcons: true }),
        );
        await reloadSettings(session);
        assert.equal(
          lastValue(updates),
          value,
          "reenabling labs republishes the icon without new spend",
        );
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "cost events are also published without a registered pi-footer command",
  { timeout: 30000 },
  async () => {
    const updates: WidgetUpdate[] = [];
    await withOfflineHarness(
      {
        agentFiles: { worker },
        managerSettings: { costDisplay: "pi-footer-event", nerdFontIcons: false },
        extensionFactories: [footerObserver(updates, false)],
        onRequest(request) {
          assert.equal(request.path, "/root/worker");
          return answer(0.5);
        },
      },
      async ({ cwd, errors, open, tool }) => {
        const session = await open(SessionManager.create(cwd));
        assert.equal(lastValue(updates), "$0.0000");
        await tool(session, "agent_spawn", {
          path: "worker",
          type: "worker",
          task: "First run",
          wait: true,
        });
        await tool(session, "agent_wait", { path: "worker" });
        assert.equal(lastValue(updates), "$0.5000");
        assert.deepEqual(errors, []);
      },
    );
  },
);


test("default status key publishes before startup completes and Pi status includes root spend", { timeout: 30000 }, async () => {
  const statuses = new Map<string, string>();
  const updates: WidgetUpdate[] = [];
  await withOfflineHarness({
    agentFiles: { worker },
    extensionFactories: [footerObserver(updates)],
    onRequest(request) {
      if (request.path) assert.equal(statuses.get(WIDGET_ID), "$0.0000", "key is selectable before child returns");
      return answer(request.path ? 0.5 : 0.1);
    },
  }, async ({ cwd, directory, errors, open, close, tool }) => {
    const session = await open(SessionManager.create(cwd));
    const base = session.extensionRunner.createCommandContext();
    session.extensionRunner.setUIContext({
      ...base.ui,
      setStatus(key: string, value: string | undefined) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setWidget() {},
      setFooter() { assert.fail("status modes must not replace footer"); },
      notify() {},
    }, "tui");
    await reloadSettings(session);
    assert.equal(statuses.get(WIDGET_ID), "$0.0000");
    statuses.clear(); // Startup must republish even if a consumer lost the initial update.
    await tool(session, "agent_spawn", { path: "worker", type: "worker", task: "Cost", wait: true });
    await tool(session, "agent_wait", { path: "worker" });
    assert.equal(statuses.get(WIDGET_ID), "$0.5000");
    await writeFile(path.join(directory, "subagent-manager", "settings.json"), JSON.stringify({ costDisplay: "pi-status" }));
    await reloadSettings(session);
    assert.equal(statuses.get(WIDGET_ID), "Total: $0.5000");
    await session.prompt("Root work");
    assert.equal(statuses.get(WIDGET_ID), "Total: $0.6000", "root agent_end refreshes total cost");
    assert.deepEqual(updates, [], "status transports do not publish event widgets");
    await close(session);
    assert.equal(statuses.has(WIDGET_ID), false);
    assert.deepEqual(errors, []);
  });
});

