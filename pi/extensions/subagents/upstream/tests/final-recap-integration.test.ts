import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

const UPDATE = "pi-subagent:update";
const SUMMARY = "pi-subagent:final-recap";
const MAILBOX = "pi-subagent:root-mailbox:v1";
const worker = "---\nname: worker\ndescription: Execute work\ntools:\n  allow: [agent_update]\n---\nExecute your assigned task.\n";
const answer = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }],
  provider: "integration-test", model: "offline", api: "openai-completions",
  stopReason: "stop", timestamp: Date.now(),
  usage: {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const toolUse = (id: string, name: string, args: JsonObject): AssistantMessage => ({
  ...answer(""), stopReason: "toolUse",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const spawn = (count = 1, wait = false): AssistantMessage => ({
  ...answer(""), stopReason: "toolUse",
  content: Array.from({ length: count }, (_, i) => ({
    type: "toolCall", id: `spawn-${i}`, name: "agent_spawn",
    arguments: { path: `worker-${i}`, type: "worker", task: `Task ${i}`, wait },
  })),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const flushTimers = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const messages = (manager: SessionManager, customType: string) => manager.getBranch().filter(
  (entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
    entry.type === "custom_message" && entry.customType === customType,
);
const mailbox = (manager: SessionManager) => manager.getBranch().filter(
  (entry) => entry.type === "custom" && entry.customType === MAILBOX,
);
function assertLastVisible(manager: SessionManager, text: string) {
  const last = manager.getBranch().filter((entry) =>
    entry.type === "message" || (entry.type === "custom_message" && entry.display)).at(-1);
  assert.ok(last?.type === "message" && last.message.role === "assistant",
    "the main assistant must own the last visible message");
  assert.deepEqual(last.message.content, [{ type: "text", text }]);
}
async function reload(session: AgentSession) {
  await session.extensionRunner.getCommand("agents")!.handler(
    "reload", session.extensionRunner.createCommandContext(),
  );
}

test("Final Recap batches idle detached completions, not progress, and persists consumption across reload/reopen", { timeout: 15000 }, async () => {
  const children = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
  let rootCalls = 0;
  await withOfflineHarness({
    agentFiles: { worker }, managerSettings: { finalRecap: true },
    onRequest(request) {
      if (request.path) {
        const i = Number(request.path.at(-1));
        return request.pathCall === 1
          ? toolUse(`progress-${i}`, "agent_update", { message: `Progress ${i}` })
          : children[i]!.promise;
      }
      rootCalls++;
      if (rootCalls === 1) return spawn(2);
      if (rootCalls === 2) return answer("Initial root answer");
      assert.equal(rootCalls, 3, "exactly one automatic summary request");
      assert.match(request.messagesText, /Worker 0 result/);
      assert.match(request.messagesText, /Worker 1 result/);
      return answer("Root combined summary");
    },
  }, async ({ cwd, open, close, requests, errors }) => {
    const session = await open(SessionManager.create(cwd));
    try {
      await session.prompt("Delegate parallel work");
      await waitFor(() => requests.filter((r) => r.path && r.pathCall === 2).length === 2, "both children waiting");
      await flushTimers();
      assert.equal(requests.filter((r) => !r.path).length, 2, "progress alone does not wake root");
      assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
      children.forEach((child, i) => child.resolve(answer(`Worker ${i} result`)));
      await waitFor(() => messages(session.sessionManager, SUMMARY).length === 1 && session.isIdle, "combined summary settled");
      assert.equal(requests.filter((r) => !r.path).length, 3);
      assertLastVisible(session.sessionManager, "Root combined summary");
      assert.ok(messages(session.sessionManager, UPDATE).every((entry) => !entry.display));
      const summary = messages(session.sessionManager, SUMMARY)[0]!;
      assert.equal(summary.display, false);
      const ids = (summary.details as { mailboxIds: string[] }).mailboxIds;
      assert.equal(new Set(ids).size, 2, "one batch consumes both completion IDs, not progress");
      const completions = messages(session.sessionManager, UPDATE).filter((entry) =>
        (entry.details as { state: string }).state === "completed");
      assert.deepEqual(new Set(ids), new Set(completions.map((entry) =>
        (entry.details as { mailboxId: string }).mailboxId)));
      await reload(session);
      await reload(session);
      await flushTimers();
      assert.equal(requests.filter((r) => !r.path).length, 3, "reload does not repeat a consumed batch");
      const file = session.sessionManager.getSessionFile()!;
      await close(session);
      const restored = await open(SessionManager.open(file));
      await reload(restored);
      await flushTimers();
      assert.equal(messages(restored.sessionManager, SUMMARY).length, 1);
      assert.equal(requests.filter((r) => !r.path).length, 3, "reopen does not repeat a consumed batch");
      assertLastVisible(restored.sessionManager, "Root combined summary");
      assert.deepEqual(errors, []);
    } finally {
      children.forEach((child, i) => child.resolve(answer(`Worker ${i} result`)));
    }
  });
});

test("recap waits until all outstanding async agents have reported, then runs once", { timeout: 15000 }, async () => {
  const children = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
  let rootCalls = 0;
  await withOfflineHarness({
    agentFiles: { worker }, managerSettings: { finalRecap: true },
    onRequest(request) {
      if (request.path) return children[Number(request.path.at(-1))]!.promise;
      rootCalls++;
      if (rootCalls === 1) return spawn(2);
      if (rootCalls === 2) return answer("Initial root answer");
      assert.equal(rootCalls, 3, "a single recap after the last completion");
      assert.match(request.messagesText, /First child result/);
      assert.match(request.messagesText, /Second child result/);
      return answer("Final root summary");
    },
  }, async ({ cwd, open, requests, errors }) => {
    const session = await open(SessionManager.create(cwd));
    try {
      await session.prompt("Delegate parallel work");
      children[0]!.resolve(answer("First child result"));
      await waitFor(() => mailbox(session.sessionManager).length === 1, "first completion retained");
      await flushTimers();
      assert.equal(requests.filter((r) => !r.path).length, 2, "no recap while a sibling is outstanding");
      assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
      children[1]!.resolve(answer("Second child result"));
      await waitFor(() => requests.filter((r) => !r.path).length === 3 && session.isIdle, "recap settled");
      const summaries = messages(session.sessionManager, SUMMARY);
      assert.equal(summaries.length, 1);
      assert.equal((summaries[0]!.details as { mailboxIds: string[] }).mailboxIds.length, 2);
      assertLastVisible(session.sessionManager, "Final root summary");
      await flushTimers();
      assert.equal(requests.filter((r) => !r.path).length, 3, "no summary loop");
      assert.deepEqual(errors, []);
    } finally {
      children.forEach((child, i) => child.resolve(answer(`Cleanup ${i}`)));
    }
  });
});

for (const foreground of [true, false]) {
  test(`Final Recap ${foreground ? "does not add a turn for foreground" : "recaps once after the root settles for detached root-busy"} completion`, { timeout: 15000 }, async () => {
    const child = deferred<AssistantMessage>();
    const root = deferred<AssistantMessage>();
    let rootCalls = 0;
    await withOfflineHarness({
      agentFiles: { worker }, managerSettings: { finalRecap: true },
      onRequest(request) {
        if (request.path) return child.promise;
        rootCalls++;
        if (rootCalls === 1) return spawn(1, foreground);
        if (rootCalls === 2) return root.promise;
        return answer("Recap after busy root");
      },
    }, async ({ cwd, open, requests, errors }) => {
      const session = await open(SessionManager.create(cwd));
      const prompt = session.prompt("Delegate work before answering");
      try {
        await waitFor(() => requests.some((r) => r.path), "child starts");
        if (!foreground) await waitFor(() => requests.some((r) => !r.path && r.pathCall === 2), "root streaming");
        child.resolve(answer("Completed while root busy"));
        await waitFor(() => mailbox(session.sessionManager).length === 1, "completion retained");
        root.resolve(answer("Normal root final answer"));
        await prompt;
        await flushTimers();
        if (foreground) {
          assert.equal(requests.filter((r) => !r.path).length, 2);
          assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
          assertLastVisible(session.sessionManager, "Normal root final answer");
        } else {
          await waitFor(() => messages(session.sessionManager, SUMMARY).length === 1 && session.isIdle, "recap after root settles");
          assert.equal(requests.filter((r) => !r.path).length, 3);
          assertLastVisible(session.sessionManager, "Recap after busy root");
        }
        assert.deepEqual(errors, []);
      } finally {
        child.resolve(answer("Cleanup"));
        root.resolve(answer("Normal root final answer"));
        await prompt;
      }
    });
  });
}

test("shutdown cancels a queued summary before opening a new session", { timeout: 15000 }, async () => {
  await withOfflineHarness({
    agentFiles: { worker }, managerSettings: { finalRecap: true },
    onRequest() { assert.fail("a summary must not run across a session switch"); },
  }, async ({ cwd, open, close, requests, errors }) => {
    const session = await open(SessionManager.create(cwd));
    const oldId = session.sessionManager.getSessionId();
    session.sessionManager.appendCustomEntry(MAILBOX, {
      rootSessionId: oldId,
      content: "Retained asynchronous result",
      finalRecap: true,
      details: { mailboxId: "queued-completion", path: "/root/worker", state: "completed" },
    });
    await reload(session);
    assert.equal(messages(session.sessionManager, UPDATE).length, 1);
    assert.equal(messages(session.sessionManager, SUMMARY).length, 0, "summary is deferred");
    await close(session);
    const next = await open(SessionManager.create(cwd));
    await flushTimers();
    assert.notEqual(next.sessionManager.getSessionId(), oldId);
    assert.equal(requests.length, 0);
    assert.equal(messages(next.sessionManager, SUMMARY).length, 0);
    assert.deepEqual(errors, []);
  });
});

for (const suppression of ["finalRecap", "off"] as const) {
  test(`Final Recap is suppressed by ${suppression} and off-mode results replay only once`, { timeout: 15000 }, async () => {
    const child = deferred<AssistantMessage>();
    let rootCalls = 0;
    await withOfflineHarness({
      agentFiles: { worker }, managerSettings: { finalRecap: true },
      onRequest(request) {
        if (request.path) return child.promise;
        rootCalls++;
        if (rootCalls === 1) return spawn();
        if (rootCalls === 2) return answer("Initial root answer");
        assert.equal(rootCalls, 3, "at most one summary after enabling");
        assert.match(request.messagesText, /Retained child result/);
        return answer("Replayed root summary");
      },
    }, async ({ directory, cwd, open, requests, errors }) => {
      const session = await open(SessionManager.create(cwd));
      try {
        await session.prompt("Delegate background work");
        const settingsFile = join(directory, "subagent-manager", "settings.json");
        await writeFile(settingsFile, JSON.stringify(suppression === "off"
          ? { finalRecap: true, subagentMode: "off" } : { finalRecap: false }));
        await reload(session);
        child.resolve(answer("Retained child result"));
        await waitFor(() => mailbox(session.sessionManager).length === 1, "completion retained under suppression");
        await flushTimers();
        // With recap disabled the async completion simply wakes the root (3rd request);
        // in off mode nothing is delivered.
        if (suppression === "finalRecap") await waitFor(() => requests.filter((r) => !r.path).length === 3, "completion wakes root");
        assert.equal(requests.filter((r) => !r.path).length, suppression === "off" ? 2 : 3);
        assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
        assert.equal(messages(session.sessionManager, UPDATE).length, suppression === "off" ? 0 : 1);
        await writeFile(settingsFile, JSON.stringify({ finalRecap: true }));
        await reload(session);
        if (suppression === "off") {
          await waitFor(() => requests.filter((r) => !r.path).length === 3 && session.isIdle, "off-mode retained summary replayed");
          assertLastVisible(session.sessionManager, "Replayed root summary");
        }
        await reload(session);
        await flushTimers();
        assert.equal(requests.filter((r) => !r.path).length, 3,
          "completion woke the root once; off-mode replay is consumed once");
        assert.deepEqual(errors, []);
      } finally {
        child.resolve(answer("Retained child result"));
      }
    });
  });
}

