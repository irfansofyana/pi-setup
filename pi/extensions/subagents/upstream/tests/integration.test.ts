import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type AssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentType, SavedThread, ThreadView } from "../src/types.ts";
import { REGISTRY_ENTRY, registry, withOfflineHarness } from "./helpers/integrationHarness.ts";

const ROOT_MAILBOX_ENTRY = "pi-subagent:root-mailbox:v1";
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
const toolUse = (id: string, name: string, args: JsonObject): AssistantMessage => ({
  ...answer(""),
  content: [{ type: "toolCall", id, name, arguments: args }],
  stopReason: "toolUse",
});
const offlineAgent =
  "---\nname: offline\ndescription: Offline lifecycle worker\ntools:\n  allow: [agent_pause]\n---\nONLY OFFLINE CHILD\n";
const contextText = (manager: SessionManager, leafId?: string) =>
  JSON.stringify(buildSessionContext(manager.getEntries(), leafId).messages);
const rootNotifications = (manager: SessionManager) =>
  manager
    .buildSessionContext()
    .messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-subagent:update",
    );
const notificationCount = (manager: SessionManager, mailboxId: string) =>
  rootNotifications(manager).filter(
    (message) =>
      (((message as { details?: { mailboxId?: unknown } }).details ?? {}).mailboxId ?? null) ===
      mailboxId,
  ).length;
const assertMarkers = (text: string, present: string[], absent: string[] = []) => {
  for (const marker of present) assert.ok(text.includes(marker), `expected marker ${marker}`);
  for (const marker of absent) assert.ok(!text.includes(marker), `unexpected marker ${marker}`);
};
const sessionLeafId = (thread: SavedThread) => {
  assert.ok(typeof thread.view.sessionLeafId === "string");
  return thread.view.sessionLeafId;
};

// One lifecycle scenario using real SDK sessions, JSONL storage, and extension binding; no driver mocks.
test(
  "offline extension retains paused/completed child across parent reopen and isolates a fork",
  { timeout: 30000 },
  async () => {
    let unexpectedCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: { offline: offlineAgent },
        onRequest(request) {
          const isChild =
            request.path === "/root/worker" && request.system.includes("ONLY OFFLINE CHILD");
          if (!isChild) unexpectedCalls++;
          return isChild && request.pathCall === 1
            ? toolUse("pause-1", "agent_pause", { reason: "Need parent input" })
            : answer(`child answer ${request.pathCall}`);
        },
      },
      async ({ directory, cwd, errors, requests, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        root.appendMessage({
          role: "user",
          content: "Durable parent context",
          timestamp: Date.now(),
        });
        // Inherited context must not be billed to the child's metrics.
        const inherited = answer("Inherited parent answer");
        root.appendMessage({ ...inherited, usage: { ...inherited.usage, input: 1000 } });
        let session = await open(root);
        const paused = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "offline",
          task: "Pause until more input",
        });
        assert.equal(paused.state, "paused");
        assert.equal(paused.output, undefined, "pause must not hand back an answer");
        assert.equal(requests.length, 1, "pause stops before another provider turn");
        assert.equal(paused.inputTokens, 1);
        assert.equal(typeof paused.elapsedMs, "number");
        const childFile = paused.sessionFile!;
        assert.equal(path.dirname(childFile), root.getSessionDir());
        assert.equal(
          SessionManager.open(childFile).getHeader()?.parentSession,
          root.getSessionFile(),
        );
        const listedChild = (await SessionManager.list(cwd, root.getSessionDir())).find(
          (entry) => entry.path === childFile,
        );
        assert.equal(listedChild?.name, "offline /root/worker");
        assert.ok((await readFile(childFile, "utf8")).includes('"toolCallId":"pause-1"'));
        assert.equal(registry(root).rootSessionId, root.getSessionId());
        assert.equal(registry(root).threads[0].view.state, "paused");
        assert.equal(registry(root).threads[0].view.inputTokens, 1);
        const parentFile = root.getSessionFile()!;
        await close(session);

        const reopened = SessionManager.open(parentFile);
        session = await open(reopened);
        assert.equal(reopened.getSessionId(), root.getSessionId());
        const restored = await tool<ThreadView>(session, "agent_status", { path: "worker" });
        assert.equal(restored.state, "paused");
        assert.equal(restored.sessionFile, childFile);
        assert.equal(requests.length, 1, "binding/restoring does not invoke a model");
        await tool(session, "agent_steer", { path: "worker", message: "Resume paused child" });
        const completed = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(completed.state, "completed");
        assert.equal(completed.output, "child answer 2");
        assert.equal(completed.inputTokens, 2, "restored metrics accumulate new deltas");
        assert.ok(completed.elapsedMs! >= paused.elapsedMs!);
        assert.equal(completed.sessionFile, childFile);
        assert.ok(
          requests[1].messagesText.includes("pause-1"),
          "resume retains the previous tool result",
        );
        assert.ok(requests[1].messagesText.includes("Resume paused child"));
        await close(session);

        const again = SessionManager.open(parentFile);
        session = await open(again);
        assert.equal(
          (await tool<ThreadView>(session, "agent_status", { path: "worker" })).state,
          "completed",
        );
        await tool(session, "agent_steer", {
          path: "worker",
          message: "More work after completion",
        });
        const continued = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(continued.state, "completed");
        assert.equal(continued.output, "child answer 3");
        assert.equal(continued.sessionFile, childFile);
        assert.ok(requests[2].messagesText.includes("child answer 2"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 3, "notifications never auto-trigger the parent model");
        assert.equal(unexpectedCalls, 0);
        assert.equal(registry(again).threads[0].view.sessionFile, childFile);
        await close(session);
        const durable = SessionManager.open(parentFile);
        const notifications = rootNotifications(durable);
        assert.equal(
          notifications.length,
          3,
          "pause and both completions are durable parent messages",
        );
        assert.ok(JSON.stringify(notifications).includes("Need parent input"));
        assert.ok(JSON.stringify(notifications).includes("child answer 3"));

        const fork = SessionManager.forkFrom(parentFile, cwd, path.join(directory, "forks"));
        assert.notEqual(fork.getSessionId(), root.getSessionId());
        assert.equal(
          registry(fork).rootSessionId,
          root.getSessionId(),
          "fork initially copied the old registry",
        );
        session = await open(fork);
        assert.deepEqual(await tool(session, "agent_status", {}), []);
        assert.equal(registry(fork).rootSessionId, fork.getSessionId());
        assert.deepEqual(registry(fork).threads, []);
        assert.equal(
          registry(SessionManager.open(parentFile)).threads[0].view.sessionFile,
          childFile,
        );
        assert.equal(requests.length, 3);
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "offline extension restores nested root-scoped transcripts and spawns under an unopened lexical parent",
  { timeout: 30000 },
  async () => {
    const ROOT = "marker:root:ancestor";
    const ROOT_LATER = "marker:root:later-only";
    const TEAM = "marker:team";
    const REVIEWER = "marker:reviewer";
    const CHECKER = "marker:checker";
    const SIBLING = "marker:sibling";
    const CHILD_PATH = "/root/team/reviewer/drafter";
    const CHILD_OUTPUT = "nested child answer";
    const offline: AgentType = {
      name: "offline",
      description: "Offline lifecycle worker",
      tools: { allow: ["agent_pause"] },
      systemPrompt: "ONLY OFFLINE CHILD",
    };
    const nested: AgentType = {
      ...offline,
      name: "nested",
      model: "integration-test/offline-alt",
      thinkingLevel: "high",
    };

    await withOfflineHarness(
      {
        agentFiles: { offline: offlineAgent },
        managerSettings: { maxLevels: 4 },
        onRequest(request) {
          assert.equal(request.path, CHILD_PATH);
          return { ...answer(CHILD_OUTPUT), model: request.modelId };
        },
      },
      async ({ directory, cwd, errors, requests, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        root.appendMessage({ role: "user", content: ROOT, timestamp: Date.now() });
        const rootId = root.getSessionId();
        // Legacy layout: child transcripts live in a root-scoped directory.
        const rootScopedDir = path.join(directory, "subagents", rootId);
        await mkdir(rootScopedDir, { recursive: true });
        const transcript = (markers: string[], isNested: boolean) => {
          const manager = SessionManager.create(cwd, rootScopedDir);
          manager.appendMessage({ role: "user", content: markers[0]!, timestamp: Date.now() });
          if (isNested) {
            manager.appendModelChange("integration-test", "offline-alt");
            manager.appendThinkingLevelChange("high");
          }
          for (const content of markers.slice(1))
            manager.appendMessage({ role: "user", content, timestamp: Date.now() });
          return manager.getSessionFile()!;
        };
        const thread = (
          relative: string,
          state: ThreadView["state"],
          sessionFile: string,
          extra: Partial<ThreadView> = {},
        ): SavedThread => {
          const viewPath = `/root/${relative}`;
          const parent = viewPath.slice(0, viewPath.lastIndexOf("/"));
          return {
            view: {
              path: viewPath,
              parent,
              owner: parent,
              type: relative === "sibling" ? "offline" : "nested",
              state,
              task: relative,
              status: `${state} before reload`,
              createdAt: Date.now(),
              sessionFile,
              ...extra,
            },
            definition: relative === "sibling" ? offline : nested,
          };
        };
        const reviewerFile = transcript([ROOT, TEAM, REVIEWER], true);
        root.appendMessage({ role: "user", content: ROOT_LATER, timestamp: Date.now() });
        root.appendCustomEntry(REGISTRY_ENTRY, {
          version: 1,
          rootSessionId: rootId,
          threads: [
            thread("team", "running", transcript([ROOT, TEAM], true)),
            thread("team/reviewer", "starting", reviewerFile),
            thread(
              "team/reviewer/checker",
              "completed",
              transcript([ROOT, TEAM, REVIEWER, CHECKER], true),
              {
                output: "checked",
              },
            ),
            thread("sibling", "paused", transcript([ROOT, SIBLING], false), {
              status: "Need sibling input",
            }),
          ],
        });
        const parentFile = root.getSessionFile()!;

        const session = await open(root);
        const restored = new Map(
          (await tool<ThreadView[]>(session, "agent_status", {})).map((view) => [view.path, view]),
        );
        assert.equal(restored.size, 4);
        for (const interrupted of ["/root/team", "/root/team/reviewer"]) {
          assert.equal(restored.get(interrupted)?.state, "paused");
          assert.equal(
            restored.get(interrupted)?.status,
            "Interrupted by reload; send input to resume",
          );
        }
        assert.equal(restored.get("/root/team/reviewer/checker")?.output, "checked");
        assert.equal(restored.get("/root/sibling")?.status, "Need sibling input");
        assert.equal(requests.length, 0, "restore and status reads stay offline");

        const spawned = await tool<ThreadView>(session, "agent_spawn", {
          path: CHILD_PATH,
          type: "offline",
          task: "Draft a nested follow-up",
        });
        assert.equal(spawned.state, "completed");
        assert.equal(spawned.output, CHILD_OUTPUT);
        assert.equal(path.dirname(spawned.sessionFile!), root.getSessionDir());
        assert.equal(
          SessionManager.open(spawned.sessionFile!).getHeader()?.parentSession,
          reviewerFile,
        );
        assert.equal(requests.length, 1, "only the new child prompt uses the provider");
        assert.equal(requests[0].lexicalParent, "/root/team/reviewer");
        assert.equal(requests[0].modelId, "offline-alt", "inherits the lexical parent's model");
        assertMarkers(
          requests[0].messagesText,
          [ROOT, TEAM, REVIEWER],
          [ROOT_LATER, SIBLING, CHECKER],
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 1, "delivery into the parent transcript stays offline");
        await close(session);

        const durable = registry(SessionManager.open(parentFile));
        assert.equal(durable.rootSessionId, rootId);
        const byPath = new Map(durable.threads.map((saved) => [saved.view.path, saved.view]));
        assert.equal(byPath.size, 5);
        assert.equal(byPath.get("/root/team")?.state, "paused");
        assert.equal(byPath.get(CHILD_PATH)?.output, CHILD_OUTPUT);

        const mailboxEntries = SessionManager.open(reviewerFile)
          .getBranch()
          .filter(
            (entry) => entry.type === "custom_message" && entry.customType === "subagent-update",
          );
        assert.equal(mailboxEntries.length, 1, "actual parent transcript receives one update");
        assert.ok(
          JSON.stringify(mailboxEntries).includes(`Agent ${CHILD_PATH} completed. Final answer:`),
        );
        assert.ok(JSON.stringify(mailboxEntries).includes(CHILD_OUTPUT));

        const childContext = SessionManager.open(spawned.sessionFile!).buildSessionContext();
        assert.equal(childContext.model?.modelId, "offline-alt");
        assert.equal(childContext.thinkingLevel, "high", "inherits the lexical parent's thinking");
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "offline extension replays root mailbox once and restores per-branch child leaves when navigating",
  { timeout: 30000 },
  async () => {
    const ROOT_SEED = "root navigation seed";
    const SEEDED_MAILBOX_ID = "seeded-root-mailbox";
    const CHILD_PATH = "/root/worker";
    const replies = new Map([
      [1, "answer A"],
      [2, "answer B"],
      [3, "answer C"],
    ]);

    await withOfflineHarness(
      {
        agentFiles: { offline: offlineAgent },
        onRequest(request) {
          assert.equal(request.path, CHILD_PATH);
          const text = replies.get(request.pathCall);
          assert.ok(text, `unexpected request call ${request.pathCall}`);
          return answer(text);
        },
      },
      async ({ directory, cwd, errors, requests, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        root.appendMessage({ role: "user", content: ROOT_SEED, timestamp: Date.now() });
        root.appendCustomEntry(ROOT_MAILBOX_ENTRY, {
          rootSessionId: root.getSessionId(),
          content: "Seeded root mailbox replay",
          details: {
            mailboxId: SEEDED_MAILBOX_ID,
            path: "/root/seeded",
            state: "completed",
          },
        });
        const parentFile = root.getSessionFile()!;

        const fork = SessionManager.forkFrom(parentFile, cwd, path.join(directory, "forks"));
        assert.equal(notificationCount(fork, SEEDED_MAILBOX_ID), 0);
        let forkSession = await open(fork);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(notificationCount(fork, SEEDED_MAILBOX_ID), 0);
        assert.equal(requests.length, 0, "forked mailbox restore stays offline");
        await close(forkSession);

        let session = await open(root);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(notificationCount(root, SEEDED_MAILBOX_ID), 1);
        assert.equal(requests.length, 0, "mailbox replay does not invoke the provider");
        await close(session);

        const reopened = SessionManager.open(parentFile);
        session = await open(reopened);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(notificationCount(reopened, SEEDED_MAILBOX_ID), 1);
        assert.equal(requests.length, 0, "reopening does not duplicate seeded mailbox delivery");

        const first = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "offline",
          task: "Produce the first answer",
        });
        assert.equal(first.state, "completed");
        assert.equal(first.output, "answer A");
        const childFile = first.sessionFile!;
        const checkpointA = reopened.getLeafId()!;
        const savedA = registry(reopened, checkpointA).threads[0]!;
        const leafA = sessionLeafId(savedA);
        assertMarkers(
          contextText(SessionManager.open(childFile), leafA),
          [ROOT_SEED, "answer A"],
          ["answer B", "answer C"],
        );

        await tool(session, "agent_steer", { path: CHILD_PATH, message: "Continue to answer B" });
        const second = await tool<ThreadView>(session, "agent_wait", { path: CHILD_PATH });
        assert.equal(second.state, "completed");
        assert.equal(second.output, "answer B");
        const checkpointB = reopened.getLeafId()!;
        const savedB = registry(reopened, checkpointB).threads[0]!;
        const leafB = sessionLeafId(savedB);
        assert.notEqual(leafA, leafB);
        assertMarkers(
          contextText(SessionManager.open(childFile), leafB),
          [ROOT_SEED, "answer A", "answer B"],
          ["answer C"],
        );

        const navigatedA = await session.navigateTree(checkpointA, { summarize: false });
        assert.equal(navigatedA.cancelled, false);
        assert.equal(requests.length, 2, "restoring an older checkpoint stays offline");
        const restoredA = await tool<ThreadView>(session, "agent_status", { path: CHILD_PATH });
        assert.equal(restoredA.state, "completed");
        assert.equal(restoredA.output, "answer A");
        const restoredLeafA = sessionLeafId(registry(reopened).threads[0]!);
        assert.equal(restoredLeafA, leafA);

        await tool(session, "agent_steer", {
          path: CHILD_PATH,
          message: "Resume from checkpoint A with answer C",
        });
        const third = await tool<ThreadView>(session, "agent_wait", { path: CHILD_PATH });
        assert.equal(third.state, "completed");
        assert.equal(third.output, "answer C");
        assert.equal(requests.length, 3);
        assertMarkers(requests[2].messagesText, [ROOT_SEED, "answer A", "answer C"], ["answer B"]);

        const navigatedB = await session.navigateTree(checkpointB, { summarize: false });
        assert.equal(navigatedB.cancelled, false);
        assert.equal(requests.length, 3, "restoring the newer checkpoint also stays offline");
        const restoredB = await tool<ThreadView>(session, "agent_status", { path: CHILD_PATH });
        assert.equal(restoredB.state, "completed");
        assert.equal(restoredB.output, "answer B");
        const restoredLeafB = sessionLeafId(registry(reopened).threads[0]!);
        assert.equal(restoredLeafB, leafB);

        await close(session);
        assert.deepEqual(errors, []);
      },
    );
  },
);

