import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  BOOTSTRAP_MESSAGE,
  DurableMailbox,
  LEGACY_QUEUE_TYPE,
  MAILBOX_FIELD,
} from "../src/orch/mailbox.ts";
import { createDriverFactory } from "../src/orch/runtime.ts";
import type { AgentDriver, DriverEvent, DriverOptions, TranscriptSnapshot } from "../src/types.ts";
import type { ModelSelectionMode, ToolFilteringMode } from "../src/prefs/settings.ts";

const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "runtime-test",
  model: "model/with/slashes",
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

const messageText = (message: unknown): string => {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const { content } = message as { content: unknown };
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } => !!block && typeof block === "object",
    )
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
};

const countMessages = (messages: unknown[], role: string, text: string): number =>
  messages.filter(
    (message) =>
      !!message &&
      typeof message === "object" &&
      (message as { role?: string }).role === role &&
      messageText(message) === text,
  ).length;

const countTextMessages = (messages: unknown[], text: string): number =>
  messages.filter((message) => messageText(message) === text).length;

test("isolated real SDK driver without credentials", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const drivers: AgentDriver[] = [];
  try {
    const cwd = path.join(directory, "workspace");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "extensions", "bad.ts"),
      'throw new Error("External extension loaded")',
    );
    await writeFile(path.join(cwd, "AGENTS.md"), "PARENT CONTEXT MUST NOT LOAD");
    await writeFile(path.join(directory, "APPEND_SYSTEM.md"), "PARENT APPEND MUST NOT LOAD");
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    let calls = 0;
    let next = answer("child answer");
    let beforeDone: Promise<void> | undefined;
    let scripted:
      ((stream: ReturnType<typeof createAssistantMessageEventStream>) => void) | undefined;
    const requests: {
      system: string;
      model: Model<any>;
      messages: unknown[];
      toolNames: string[];
      apiKey?: string;
    }[] = [];
    const registerProvider = (provider: string, ids: string[], reasoning = true) =>
      registry.registerProvider(provider, {
        api: "openai-completions",
        baseUrl: "http://invalid.local",
        models: ids.map((id) => ({
          id,
          name: `${provider}/${id}`,
          reasoning,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        })),
        streamSimple(model, context, streamOptions) {
          calls++;
          requests.push({
            system: JSON.stringify(context.messages.filter((msg) => msg.role === "system")),
            model,
            messages: context.messages,
            toolNames: getCurrentTools(context.messages).map((tool) => tool.name),
            apiKey: streamOptions?.apiKey,
          });
          const stream = createAssistantMessageEventStream();
          if (scripted) {
            const run = scripted;
            scripted = undefined;
            run(stream);
            return stream;
          }
          const reply = {
            ...structuredClone(next),
            provider: model.provider,
            model: model.id,
          };
          void (async () => {
            await Promise.resolve();
            stream.push({ type: "start", partial: reply });
            if (beforeDone) await beforeDone;
            if (reply.stopReason === "error" || reply.stopReason === "aborted")
              stream.push({ type: "error", reason: reply.stopReason, error: reply });
            else
              stream.push({
                type: "done",
                reason: reply.stopReason as "stop" | "length" | "toolUse",
                message: reply,
              });
            stream.end(reply);
          })();
          return stream;
        },
      });
    registerProvider("runtime-test", ["model/with/slashes", "fallback"]);
    registerProvider("runtime-other", ["backup"]);
    await runtime.setRuntimeApiKey("runtime-test", "fake-runtime-only-key");
    await runtime.setRuntimeApiKey("runtime-other", "other-runtime-only-key");
    await registry.refresh({ allowNetwork: false });
    assert.equal(registry.getProviderAuthStatus("runtime-test").source, "runtime");
    assert.equal(registry.getProviderAuthStatus("runtime-other").source, "runtime");
    const root = SessionManager.create(cwd, path.join(directory, "root"));
    let scopedModels = [
      { model: registry.find("runtime-test", "model/with/slashes")! },
      { model: registry.find("runtime-other", "backup")! },
    ];
    const ctx = {
      cwd,
      sessionManager: root,
      modelRegistry: registry,
      model: registry.find("runtime-test", "model/with/slashes"),
      get scopedModels() {
        return scopedModels;
      },
      thinkingLevel: "low",
    } as unknown as ExtensionContext;
    const setScopedModels = (...identities: string[]) => {
      scopedModels = identities.map((identity) => {
        const slash = identity.indexOf("/");
        return { model: registry.find(identity.slice(0, slash), identity.slice(slash + 1))! };
      });
    };
    const setRootModel = (identity: string) => {
      const slash = identity.indexOf("/");
      ctx.model = registry.find(identity.slice(0, slash), identity.slice(slash + 1))!;
    };
    const apiKeys: Record<string, string> = {
      "runtime-test": "fake-runtime-only-key",
      "runtime-other": "other-runtime-only-key",
    };
    const assertModel = (identity: string) => {
      const request = requests.at(-1)!;
      assert.equal(`${request.model.provider}/${request.model.id}`, identity);
      assert.equal(request.apiKey, apiKeys[request.model.provider]);
    };
    const toolCall = (id: string, name: string): AssistantMessage => ({
      ...answer(""),
      content: [{ type: "toolCall", id, name, arguments: {} }],
      stopReason: "toolUse",
    });
    // A tool that blocks until released, so tests can act while a tool call is in flight.
    const gatedTool = (name: string, onRelease?: () => void) => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const tool: ToolDefinition = {
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        async execute() {
          entered();
          await gate;
          onRelease?.();
          return { content: [{ type: "text", text: "done" }], details: undefined };
        },
      };
      return { tool, started, release };
    };
    let modelSelection: ModelSelectionMode = "pick-first-scoped";
    let toolFiltering: ToolFilteringMode = "allowed";
    const factory = createDriverFactory(
      () => ctx,
      () => modelSelection,
      () => toolFiltering,
    );
    const events: DriverEvent[] = [];
    let pause = false;
    const options = (overrides: Partial<DriverOptions> = {}): DriverOptions => ({
      path: "/root/child",
      parentPath: "/root",
      type: {
        name: "worker",
        description: "Test",
        systemPrompt: "ONLY CHILD PROMPT",
        tools: { allow: [] },
      },
      inherited: [answer("inherited answer")],
      tools: [],
      onEvent: (event) => events.push(event),
      shouldPause: () => pause,
      signal: new AbortController().signal,
      ...overrides,
    });
    const modelOptions = (path: string, models: string[], overrides: Partial<DriverOptions> = {}) =>
      options({ path, ...overrides, type: { ...options().type, models } });
    const toolOptions = (path: string, tool: ToolDefinition, models?: string[]) =>
      options({
        path,
        tools: [tool],
        type: { ...options().type, ...(models && { models }), tools: { allow: [tool.name] } },
      });
    const create = async (opts: DriverOptions) => {
      const driver = await factory(opts);
      drivers.push(driver);
      return driver;
    };
    const restoreScope = () => {
      modelSelection = "pick-first-scoped";
      setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
      setRootModel("runtime-test/model/with/slashes");
    };

    await t.test(
      "discovery resolves the same model and effective thinking as new drivers",
      async () => {
        const assertSpawnMatches = async (type: DriverOptions["type"], parentPath = "/root") => {
          const preview = factory.resolveAgentSettings(type, parentPath);
          const threadPath = `${parentPath}/discovery-${drivers.length}`;
          const driver = await create(options({ path: threadPath, type, parentPath }));
          await driver.prompt("Verify discovery settings");
          const actual = requests.at(-1)!.model;
          const saved = SessionManager.open(
            driver.sessionFile!,
            ctx.sessionManager.getSessionDir(),
            cwd,
          ).buildSessionContext();
          assert.deepEqual(preview, {
            model: `${actual.provider}/${actual.id}`,
            thinkingLevel: saved.thinkingLevel,
          });
          return threadPath;
        };
        const plain = { name: "discovery", description: "Discover", systemPrompt: "Work" };
        try {
          assert.deepEqual(
            factory.resolveAgentSettings({ ...plain, modelSuggestions: ["Missing"] }, "/root"),
            {
              model: "runtime-test/model/with/slashes",
              thinkingLevel: "low",
            },
          );
          await assertSpawnMatches(plain);
          const preferred = {
            ...plain,
            models: ["runtime-other/backup", "runtime-test/fallback"],
            thinkingLevel: "high" as const,
          };
          setScopedModels("runtime-test/fallback");
          assert.equal(
            factory.resolveAgentSettings(preferred, "/root").model,
            "runtime-test/fallback",
          );
          await assertSpawnMatches(preferred);
          setScopedModels("runtime-other/backup");
          assert.equal(
            factory.resolveAgentSettings(preferred, "/root").model,
            "runtime-other/backup",
          );
          await assertSpawnMatches(preferred);
          setScopedModels();
          assert.throws(() => factory.resolveAgentSettings(preferred, "/root"), /scoped-models/);
          modelSelection = "pick-first-available";
          const parent = await assertSpawnMatches(preferred);
          assert.deepEqual(factory.resolveAgentSettings(plain, parent), {
            model: "runtime-other/backup",
            thinkingLevel: "high",
          });
          await assertSpawnMatches(plain, parent);
          modelSelection = "use-current";
          assert.equal(
            factory.resolveAgentSettings(preferred, parent).model,
            "runtime-test/model/with/slashes",
          );
          await assertSpawnMatches(preferred, parent);
          modelSelection = "pick-first-available";
          assert.equal(
            factory.resolveAgentSettings({ ...plain, model: "runtime-other/backup" }, "/root")
              .model,
            "runtime-other/backup",
          );
          assert.throws(
            () => factory.resolveAgentSettings({ ...plain, model: "missing/model" }, "/root"),
            /none are available/,
          );
          registerProvider("runtime-plain", ["non-reasoning"], false);
          await runtime.setRuntimeApiKey("runtime-plain", "runtime-test-key");
          const nonReasoning = {
            ...plain,
            model: "runtime-plain/non-reasoning",
            thinkingLevel: "high" as const,
          };
          assert.equal(factory.resolveAgentSettings(nonReasoning, "/root").thinkingLevel, "off");
          await assertSpawnMatches(nonReasoning);
          ctx.model = undefined;
          assert.throws(() => factory.resolveAgentSettings(plain, "/root"), /unavailable/);
        } finally {
          restoreScope();
        }
      },
    );

    await t.test(
      "read-only observation attaches mid-assistant stream and retains inherited metadata",
      async () => {
        const driver = await create(options({ path: "/root/watch-assistant" }));
        const partial = { ...answer("live partial"), stopReason: "pending" as const };
        const final = answer("live final");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let sawPartial!: () => void;
        const streamed = new Promise<void>((resolve) => (sawPartial = resolve));
        const updates: TranscriptSnapshot[] = [];
        const initial = driver.observeTranscript!((snapshot) => {
          updates.push(snapshot);
          if (messageText(snapshot.assistant) === "live partial") sawPartial();
        });
        assert.equal(initial.snapshot.inheritedCount, 1);
        assert.equal(initial.snapshot.assistant, null);
        scripted = (stream) => {
          void (async () => {
            stream.push({ type: "start", partial });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "live partial", partial });
            await gate;
            stream.push({ type: "done", reason: "stop", message: final });
            stream.end(final);
          })();
        };
        const turn = driver.prompt("watch me");
        try {
          await streamed;
          const attached = driver.observeTranscript!(() => {});
          assert.equal(messageText(attached.snapshot.assistant), "live partial");
          assert.equal(countTextMessages([...attached.snapshot.messages], "live partial"), 0);
          assert.throws(() => (attached.snapshot.messages as unknown[]).push("bad"));
          attached.unsubscribe();
        } finally {
          release();
        }
        await turn;
        assert.equal(updates.at(-1)?.assistant, null);
        assert.equal(countTextMessages([...updates.at(-1)!.messages], "live final"), 1);
        assert.equal(countTextMessages(driver.snapshot(), "bad"), 0);
        initial.unsubscribe();
        const file = driver.sessionFile!;
        driver.dispose();
        const restored = await create(
          options({ path: "/root/watch-assistant", sessionFile: file, inherited: [] }),
        );
        const history = restored.observeTranscript!(() => {});
        assert.equal(
          history.snapshot.inheritedCount,
          1,
          "persisted ownership retains inherited prefix count",
        );
        assert.equal(countTextMessages([...history.snapshot.messages], "live final"), 1);
        history.unsubscribe();
      },
    );

    await t.test(
      "read-only observation captures a running tool and its partial/error result",
      async () => {
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        const tool: ToolDefinition = {
          name: "watch_tool",
          label: "watch_tool",
          description: "watch_tool",
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, onUpdate) {
            onUpdate?.({ content: [{ type: "text", text: "partial output" }], details: undefined });
            entered();
            await gate;
            next = answer("after failed tool");
            throw new Error("expected tool failure");
          },
        };
        const driver = await create(toolOptions("/root/watch-tool", tool));
        next = toolCall("watch-call", tool.name);
        const turn = driver.prompt("watch tool");
        await started;
        // onUpdate's SDK event dispatch is asynchronous; tool entry alone is not its completion.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const updates: TranscriptSnapshot[] = [];
        const observation = driver.observeTranscript!((snapshot) => updates.push(snapshot));
        try {
          assert.equal(observation.snapshot.tools[0]?.toolCallId, "watch-call");
          assert.equal(observation.snapshot.tools[0]?.state, "running");
          assert.match(JSON.stringify(observation.snapshot.tools[0]?.result), /partial output/);
        } finally {
          release();
        }
        await turn;
        assert.ok(updates.some((snapshot) => snapshot.tools.some((item) => item.isError)));
        const latest = updates.at(-1)!;
        assert.equal(
          latest.tools.length,
          0,
          "finalized results are rendered from history, not duplicated as active tools",
        );
        assert.equal(
          latest.messages.filter(
            (message) => message.role === "toolResult" && message.toolCallId === "watch-call",
          ).length,
          1,
        );
        observation.unsubscribe();
      },
    );

    await t.test(
      "tool filtering selects actual builtin/custom declarations and delegation guidance",
      async () => {
        let executions = 0;
        const makeTool = (name: string): ToolDefinition => ({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          async execute() {
            executions++;
            next = answer("tool completed");
            return { content: [{ type: "text", text: "done" }], details: undefined };
          },
        });
        const custom = [makeTool("probe"), makeTool("agent_spawn"), makeTool("agent_wait")];
        const allNames = [
          "read",
          "bash",
          "powershell",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
          ...custom.map((tool) => tool.name),
        ];
        try {
          for (const mode of ["allowed", "all-except-blocked", "all"] as const) {
            toolFiltering = mode;
            next = answer("declarations");
            const driver = await create(
              options({
                path: `/root/filter-${mode}`,
                tools: custom,
                type: {
                  ...options().type,
                  tools: { allow: ["read", "probe", "agent_spawn"], block: ["read", "probe"] },
                },
              }),
            );
            await driver.prompt("Inspect selected tools");
            const expected =
              mode === "allowed"
                ? ["agent_spawn"]
                : mode === "all"
                  ? allNames
                  : allNames.filter((name) => name !== "read" && name !== "probe");
            assert.deepEqual([...requests.at(-1)!.toolNames].sort(), [...expected].sort());
            if (mode === "all") {
              next = toolCall("allowed-probe", "probe");
              await driver.prompt("Call formerly blocked custom tool");
              assert.equal(executions, 1);
              assert.ok(
                driver
                  .snapshot()
                  .some(
                    (msg) =>
                      msg.role === "toolResult" &&
                      msg.toolCallId === "allowed-probe" &&
                      !msg.isError,
                  ),
              );
            }
          }
          // Broader modes ignore unavailable names in the lists they bypass.
          for (const mode of ["all-except-blocked", "all"] as const) {
            toolFiltering = mode;
            const driver = await create(
              options({
                path: `/root/filter-ignored-${mode}`,
                type: {
                  ...options().type,
                  tools: { allow: ["missing"], block: mode === "all" ? ["missing"] : [] },
                },
              }),
            );
            next = answer("ignored lists");
            await driver.prompt("Use builtins");
            assert.deepEqual(
              [...requests.at(-1)!.toolNames].sort(),
              allNames.filter((name) => !custom.some((tool) => tool.name === name)).sort(),
            );
          }
        } finally {
          toolFiltering = "allowed";
          next = answer("child answer");
        }
      },
    );

    await t.test(
      "blocked builtin/custom calls fail without executing in both restricting modes",
      async () => {
        let executions = 0;
        const probe: ToolDefinition = {
          name: "probe",
          label: "Probe",
          description: "Probe",
          parameters: Type.Object({}),
          async execute() {
            executions++;
            return { content: [{ type: "text", text: "must not execute" }], details: undefined };
          },
        };
        try {
          for (const mode of ["allowed", "all-except-blocked"] as const) {
            toolFiltering = mode;
            const driver = await create(
              options({
                path: `/root/filter-denied-${mode}`,
                tools: [probe],
                type: {
                  ...options().type,
                  tools: { allow: ["read", "probe"], block: ["read", "probe"] },
                },
              }),
            );
            for (const name of ["read", "probe"]) {
              const id = `blocked-${mode}-${name}`;
              const reply = toolCall(id, name);
              scripted = (stream) => {
                stream.push({ type: "start", partial: reply });
                stream.push({ type: "done", reason: "toolUse", message: reply });
                stream.end(reply);
              };
              next = answer("after rejected call");
              await driver.prompt(`Try blocked ${name}`);
              assert.ok(!requests.at(-1)!.toolNames.includes(name));
              assert.ok(
                driver
                  .snapshot()
                  .some((msg) => msg.role === "toolResult" && msg.toolCallId === id && msg.isError),
              );
              assert.equal(executions, 0);
            }
          }
        } finally {
          scripted = undefined;
          toolFiltering = "allowed";
          next = answer("child answer");
        }
      },
    );

    await t.test(
      "tool filtering getter applies at driver creation, not future requests of live sessions",
      async () => {
        try {
          next = answer("filter snapshot");
          toolFiltering = "allowed";
          const strict = await create(options({ path: "/root/filter-old-strict" }));
          toolFiltering = "all";
          await strict.prompt("Keep startup tools");
          assert.deepEqual(requests.at(-1)!.toolNames, []);
          const wide = await create(options({ path: "/root/filter-new-wide" }));
          await wide.prompt("Widen empty allow list");
          assert.ok(requests.at(-1)!.toolNames.includes("read"));
          toolFiltering = "allowed";
          await wide.prompt("Keep wider startup tools");
          assert.ok(requests.at(-1)!.toolNames.includes("read"));
          const newStrict = await create(options({ path: "/root/filter-new-strict" }));
          await newStrict.prompt("New startup snapshot");
          assert.deepEqual(requests.at(-1)!.toolNames, []);
        } finally {
          toolFiltering = "allowed";
          next = answer("child answer");
        }
      },
    );

    await t.test(
      "system/history isolation, first-slash model parsing, output baseline and mailbox",
      async () => {
        const driver = await create(
          options({
            type: { ...options().type, model: "runtime-test/model/with/slashes" },
            inherited: [
              answer("inherited answer"),
              {
                role: "custom",
                customType: "parent-note",
                content: "Inherited extension context",
                display: false,
                timestamp: Date.now(),
              },
              {
                role: "bashExecution",
                command: "echo inherited",
                output: "Inherited shell context",
                exitCode: 0,
                cancelled: false,
                truncated: false,
                timestamp: Date.now(),
              },
            ],
          }),
        );
        assert.equal(driver.output(), "", "inherited answers are not this agent's output");
        assert.equal(path.dirname(driver.sessionFile!), root.getSessionDir());
        await driver.prompt("task");
        assert.equal(driver.output(), "child answer");
        assertModel("runtime-test/model/with/slashes");
        assert.ok(
          events.some(
            (event) =>
              event.kind === "settings" && event.model === "runtime-test/model/with/slashes",
          ),
        );
        const system = requests.at(-1)!.system;
        for (const marker of [
          "ONLY CHILD PROMPT",
          "Your thread path is /root/child",
          "Your lexical parent is /root",
          "agent_pause",
        ])
          assert.ok(system.includes(marker), marker);
        assert.ok(!system.includes("PARENT CONTEXT") && !system.includes("PARENT APPEND"));
        assert.equal(countMessages(driver.snapshot(), "custom", "Inherited extension context"), 1);
        assert.ok(
          driver
            .snapshot()
            .some(
              (msg) => msg.role === "bashExecution" && msg.output === "Inherited shell context",
            ),
        );
        const count = calls;
        await driver.sendUpdate("mailbox update");
        assert.equal(calls, count);
        next = answer("second run");
        await driver.prompt("again");
        assert.equal(countMessages(driver.snapshot(), "custom", "mailbox update"), 1);
        assert.equal(driver.output(), "second run");
        const file = driver.sessionFile!;
        driver.dispose();
        const reopened = await create(options({ sessionFile: file }));
        assert.equal(reopened.sessionFile, file);
        assert.equal(reopened.snapshot().filter((msg) => msg.role === "assistant").length, 3);
        assert.equal(reopened.output(), "");
        await reopened.prompt("resume");
        assert.equal(reopened.output(), "second run");
        const independent = await create(
          options({ path: "/independent", parentPath: null, inherited: [] }),
        );
        assert.equal(typeof independent.sessionFile, "undefined");
        const independentCalls = calls;
        await independent.sendUpdate("independent mailbox");
        await independent.steer("queued before prompt");
        assert.equal(calls, independentCalls, "updates and steering before a prompt stay offline");
        assert.equal(countMessages(independent.snapshot(), "user", BOOTSTRAP_MESSAGE), 1);
        assert.equal(countMessages(independent.snapshot(), "custom", "independent mailbox"), 1);
        await independent.prompt("independent task");
        assert.equal(countMessages(requests.at(-1)!.messages, "user", "queued before prompt"), 1);
        const independentFile = independent.sessionFile!;
        assert.equal(path.dirname(independentFile), root.getSessionDir());
        assert.equal(
          SessionManager.open(independentFile).getHeader()?.parentSession,
          root.getSessionFile(),
        );
      },
    );

    await t.test("pause settles after tools, then dispose/reopen same JSONL resumes", async () => {
      pause = false;
      const { tool, started, release } = gatedTool("agent_pause", () => {
        pause = true;
      });
      next = toolCall("pause-1", "agent_pause");
      const pauseOptions = toolOptions("/root/pause", tool);
      const driver = await create(pauseOptions);
      await driver.sendUpdate("queued mailbox");
      const count = calls;
      const run = driver.prompt("pause task");
      await started;
      await driver.steer("queued refinement");
      release();
      await run;
      assert.equal(calls, count + 1);
      assert.equal(driver.output(), "");
      assert.ok(
        driver.snapshot().some((msg) => msg.role === "toolResult" && msg.toolCallId === "pause-1"),
      );
      await driver.sendUpdate("paused mailbox");
      assert.equal(calls, count + 1);
      assert.equal(countMessages(driver.snapshot(), "custom", "paused mailbox"), 1);
      const file = driver.sessionFile!;
      driver.dispose();
      const reopened = await create({ ...pauseOptions, sessionFile: file });
      assert.equal(reopened.sessionFile, file);
      assert.equal(countMessages(reopened.snapshot(), "custom", "paused mailbox"), 1);
      const resumeRequests = requests.length;
      pause = false;
      next = answer("resumed");
      await reopened.prompt("resume");
      assert.equal(reopened.output(), "resumed");
      assert.ok(
        requests
          .slice(resumeRequests)
          .some((request) => JSON.stringify(request.messages).includes("queued refinement")),
      );
    });

    await t.test(
      "durable queued steering and running updates replay once after reopening a selected leaf",
      async () => {
        let releaseDone!: () => void;
        beforeDone = new Promise<void>((resolve) => {
          releaseDone = resolve;
        });
        next = answer("delayed original");
        const driver = await create(options({ path: "/root/durable" }));
        const run = driver.prompt("initial task");
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(driver.sessionFile);
        await driver.steer("same steer");
        await driver.steer("same steer");
        await driver.sendUpdate("running progress");
        const file = driver.sessionFile!;
        const pendingLeaf = driver.sessionLeafId;
        driver.dispose();
        releaseDone();
        await run.catch(() => undefined);
        beforeDone = undefined;
        SessionManager.open(file).appendCustomMessageEntry(
          "branch-probe",
          "future-only history",
          false,
        );
        await assert.rejects(
          create(options({ path: "/root/durable", sessionFile: file, sessionLeafId: "missing" })),
          /not found/,
        );
        const reopenCalls = calls;
        const reopened = await create(
          options({ path: "/root/durable", sessionFile: file, sessionLeafId: pendingLeaf }),
        );
        assert.equal(calls, reopenCalls);
        // The selected leaf restores only its branch.
        assert.equal(countMessages(reopened.snapshot(), "custom", "future-only history"), 0);
        assert.equal(countMessages(reopened.snapshot(), "user", "same steer"), 0);
        assert.equal(countMessages(reopened.snapshot(), "custom", "running progress"), 0);
        next = answer("after resume");
        const requestCount = requests.length;
        await reopened.prompt("resume after crash");
        assert.equal(reopened.output(), "after resume");
        const resumedRequests = requests.slice(requestCount);
        assert.ok(
          resumedRequests.some(
            (request) => countMessages(request.messages, "user", "same steer") >= 1,
          ),
        );
        assert.ok(
          resumedRequests.some(
            (request) => countTextMessages(request.messages, "running progress") >= 1,
          ),
        );
        assert.equal(countMessages(reopened.snapshot(), "user", "same steer"), 2);
        assert.equal(countMessages(reopened.snapshot(), "custom", "running progress"), 1);
      },
    );

    await t.test(
      "queued steering rechecks scoped preferences; out-of-scope steering is rejected",
      async () => {
        setScopedModels("runtime-test/model/with/slashes");
        setRootModel("runtime-test/model/with/slashes");
        events.length = 0;
        let releaseDone!: () => void;
        beforeDone = new Promise<void>((resolve) => {
          releaseDone = resolve;
        });
        next = answer("first explicit turn");
        const driver = await create(
          modelOptions("/root/queued-scope-revoked", ["runtime-test/model/with/slashes"]),
        );
        const beforeCalls = calls;
        const run = assert.rejects(driver.prompt("start explicit run"), (error: unknown) => {
          assert.match(String(error), /\/scoped-models/);
          return true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        await driver.steer("queued after acceptance");
        const sessionFile = driver.sessionFile!;
        setScopedModels();
        releaseDone();
        await run;
        beforeDone = undefined;
        assert.equal(calls, beforeCalls + 1);
        assert.ok(
          events.some((event) => event.kind === "error" && /\/scoped-models/.test(event.text)),
        );
        assert.equal(countMessages(driver.snapshot(), "user", "queued after acceptance"), 1);
        // Later steering while out of scope is rejected before it reaches the durable mailbox.
        await assert.rejects(driver.steer("blocked before mailbox"), /\/scoped-models/);
        assert.equal(countMessages(driver.snapshot(), "user", "blocked before mailbox"), 0);
        assert.deepEqual(new DurableMailbox(SessionManager.open(sessionFile)).pending(), []);
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
      },
    );

    await t.test(
      "transcript UUIDs reconcile missing consumed markers without duplicating updates",
      async () => {
        const driver = await create(options({ path: "/root/reconcile" }));
        await driver.sendUpdate("checkpointed update");
        const file = driver.sessionFile!;
        const branch = SessionManager.open(file, root.getSessionDir(), cwd)
          .getBranch()
          .find(
            (entry) =>
              entry.type === "custom_message" &&
              messageText({ content: entry.content }) === "checkpointed update" &&
              !!(entry.details as Record<string, unknown> | undefined)?.[MAILBOX_FIELD],
          );
        assert.ok(branch && branch.type === "custom_message");
        const reopenCalls = calls;
        const reopened = await create(
          options({ path: "/root/reconcile", sessionFile: file, sessionLeafId: branch.id }),
        );
        assert.equal(calls, reopenCalls);
        next = answer("reconciled");
        await reopened.prompt("continue");
        const request = requests.at(-1)!;
        assert.equal(countTextMessages(request.messages, "checkpointed update"), 1);
        assert.equal(countMessages(reopened.snapshot(), "custom", "checkpointed update"), 1);
      },
    );

    await t.test("partial legacy queue migration preserves each occurrence across reopen", () => {
      const legacy = SessionManager.create(cwd, path.join(directory, "legacy"));
      legacy.appendMessage(answer("legacy history"));
      legacy.appendCustomEntry(LEGACY_QUEUE_TYPE, {
        steering: ["same", "same"],
        followUp: ["later"],
      });
      const first = new DurableMailbox(legacy).pending();
      const interrupted = legacy
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom" &&
            (entry.data as { id?: string } | undefined)?.id === first[0].id,
        );
      assert.ok(interrupted);
      const reopened = SessionManager.open(legacy.getSessionFile()!);
      reopened.branch(interrupted.id); // Simulate exit after only the first acceptance persisted.
      const recovered = new DurableMailbox(reopened).pending();
      assert.deepEqual(
        recovered.map((entry) => entry.content),
        ["same", "same", "later"],
      );
      assert.equal(new Set(recovered.map((entry) => entry.id)).size, 3);
      assert.deepEqual(
        recovered.map((entry) => entry.id),
        first.map((entry) => entry.id),
      );
      assert.deepEqual(new DurableMailbox(reopened).pending(), recovered);
    });

    await t.test(
      "explicit scoped preferences are ordered, fail closed, and cached drivers reselect after scope changes",
      async () => {
        const baselineCalls = calls;
        setScopedModels();
        await assert.rejects(
          create(
            options({
              path: "/root/no-scope",
              type: {
                ...options().type,
                name: "empty-scope",
                models: ["runtime-test/model/with/slashes"],
              },
            }),
          ),
          (error: unknown) => {
            assert.match(String(error), /empty-scope/);
            assert.match(String(error), /runtime-test\/model\/with\/slashes/);
            assert.match(String(error), /\/scoped-models/);
            assert.match(String(error), /\[\]/);
            return true;
          },
        );
        assert.equal(calls, baselineCalls);
        setScopedModels("runtime-other/backup", "runtime-test/model/with/slashes");
        next = answer("saved backup model");
        const initial = await create(
          modelOptions("/root/restored-policy", ["runtime-other/backup"]),
        );
        await initial.prompt("save transcript on backup");
        const savedFile = initial.sessionFile!;
        const savedContext = SessionManager.open(savedFile).buildSessionContext();
        assert.equal(savedContext.model?.provider, "runtime-other");
        assert.equal(savedContext.model?.modelId, "backup");
        initial.dispose();

        next = answer("restored obeyed policy");
        const restoredDriver = await create(
          modelOptions("/root/restored-policy", ["runtime-test/model/with/slashes"], {
            sessionFile: savedFile,
          }),
        );
        await restoredDriver.prompt("resume with explicit policy");
        assertModel("runtime-test/model/with/slashes");

        // Preference order beats scope order and missing entries are skipped.
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        next = answer("cached backup");
        const cached = await create(
          modelOptions("/root/cached-scope", [
            "runtime-other/missing",
            "runtime-other/backup",
            "runtime-test/model/with/slashes",
          ]),
        );
        await cached.prompt("first cached run");
        assertModel("runtime-other/backup");

        setScopedModels();
        const rejectedCalls = calls;
        await assert.rejects(cached.prompt("scope lost"), /\/scoped-models/);
        assert.equal(calls, rejectedCalls);

        setScopedModels("runtime-test/model/with/slashes");
        next = answer("cached switched");
        await cached.prompt("scope regained");
        assertModel("runtime-test/model/with/slashes");
      },
    );

    await t.test(
      "tool continuation stops on scope drift until a resumed prompt reselects the preferred model",
      async () => {
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
        const { tool, started, release } = gatedTool("scope_gate");
        next = toolCall("scope-gate-1", "scope_gate");
        const driver = await create(
          toolOptions("/root/tool-scope-change", tool, [
            "runtime-test/model/with/slashes",
            "runtime-other/backup",
          ]),
        );
        const beforeCalls = calls;
        const run = assert.rejects(driver.prompt("tool turn"), (error: unknown) => {
          assert.match(String(error), /scope changed/);
          assert.match(String(error), /preferred is runtime-other\/backup/);
          assert.match(String(error), /resume agent to use runtime-other\/backup/);
          return true;
        });
        await started;
        setScopedModels("runtime-other/backup");
        setRootModel("runtime-other/backup");
        release();
        await run;
        assert.equal(calls, beforeCalls + 1);

        next = answer("resumed on backup");
        await driver.prompt("resume on backup");
        assertModel("runtime-other/backup");
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
      },
    );

    await t.test(
      "omitted model drivers preserve cached and restored selections across scope changes",
      async () => {
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
        next = answer("omitted initial");
        const driver = await create(options({ path: "/root/omitted-policy" }));
        await driver.prompt("first omitted run");
        assertModel("runtime-test/model/with/slashes");
        const savedFile = driver.sessionFile!;

        setScopedModels("runtime-other/backup", "runtime-test/model/with/slashes");
        setRootModel("runtime-other/backup");
        next = answer("omitted cached");
        await driver.prompt("second omitted run");
        assertModel("runtime-test/model/with/slashes");

        driver.dispose();
        next = answer("omitted restored");
        const restored = await create(
          options({ path: "/root/omitted-policy", sessionFile: savedFile }),
        );
        await restored.prompt("restored omitted run");
        assertModel("runtime-test/model/with/slashes");
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
      },
    );

    await t.test("assistant errors and cancellation reject, cleanup is idempotent", async () => {
      next = { ...answer(""), stopReason: "error", errorMessage: "terminal fake failure" };
      const driver = await create(options({ path: "/root/error" }));
      await assert.rejects(driver.prompt("fail"), /terminal fake failure/);
      assert.equal(driver.output(), "");
      next = { ...answer(""), stopReason: "aborted" };
      await assert.rejects(driver.prompt("cancel"), /aborted/);
      await Promise.all([driver.abort(), driver.abort()]);
      driver.dispose();
      driver.dispose();
      await driver.abort();
      await assert.rejects(driver.prompt("closed"), /disposed/);
      assert.ok(events.some((event) => event.kind === "error"));
      assert.ok(
        events.every(
          (event) =>
            event.kind === "settings" ||
            event.kind === "usage" ||
            event.kind === "checkpoint" ||
            event.text.length <= 1000,
        ),
      );
    });

    await t.test("abort interrupts an active tool without blocking cleanup", async () => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const tool: ToolDefinition = {
        name: "wait_signal",
        label: "Wait",
        description: "Wait",
        parameters: Type.Object({}),
        async execute(_id, _args, signal) {
          entered();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(new Error("cancelled"));
            else
              signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
          });
          return { content: [], details: undefined };
        },
      };
      next = toolCall("wait-1", "wait_signal");
      const driver = await create(toolOptions("/root/abort", tool));
      const run = driver.prompt("wait");
      const rejected = assert.rejects(run, /aborted/);
      await started;
      await Promise.all([driver.abort(), driver.abort()]);
      await rejected;
      driver.dispose();
    });

    await t.test("startup cancellation rejects before allocation and during setup", async () => {
      const controller = new AbortController();
      controller.abort(new Error("startup cancelled"));
      const count = calls;
      await assert.rejects(factory(options({ signal: controller.signal })), /startup cancelled/);
      const duringSetup = new AbortController();
      const registeredIds = registry.getRegisteredProviderIds.bind(registry);
      registry.getRegisteredProviderIds = () => {
        duringSetup.abort(new Error("setup cancelled"));
        return registeredIds();
      };
      try {
        await assert.rejects(factory(options({ signal: duringSetup.signal })), /setup cancelled/);
      } finally {
        registry.getRegisteredProviderIds = registeredIds;
      }
      assert.equal(calls, count);
    });

    await t.test("shared session directory enforces root and thread ownership", async () => {
      next = answer("owned answer");
      const driver = await create(options({ path: "/root/owned" }));
      await driver.prompt("owned task");
      const file = driver.sessionFile!;
      await assert.rejects(
        factory(options({ path: "/root/wrong-thread", sessionFile: file })),
        /inside this root|ownership|thread/i,
      );
      const otherRoot = SessionManager.create(cwd, root.getSessionDir());
      const otherFactory = createDriverFactory(() => ({ ...ctx, sessionManager: otherRoot }));
      await assert.rejects(
        otherFactory(options({ path: "/root/owned", sessionFile: file })),
        /inside this root|ownership|thread/i,
      );
      root.appendMessage(answer("root transcript"));
      await assert.rejects(
        factory(options({ sessionFile: root.getSessionFile()! })),
        /inside this root|ownership|thread/i,
      );
      const foreign = SessionManager.create(cwd, path.join(directory, "foreign"));
      foreign.appendMessage(answer("foreign transcript"));
      const linked = path.join(root.getSessionDir(), "foreign-link.jsonl");
      await symlink(foreign.getSessionFile()!, linked);
      await assert.rejects(factory(options({ sessionFile: linked })), /inside this root/i);
    });

    await t.test("usage counts only this agent's assistant messages", async () => {
      const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: (input + output + cacheRead + cacheWrite) / 1000,
        },
      });
      const assistant = (
        tokens: AssistantMessage["usage"],
        stopReason: AssistantMessage["stopReason"] = "stop",
      ): AssistantMessage => ({
        ...answer("metrics"),
        stopReason,
        usage: tokens,
        errorMessage: stopReason === "error" ? "model failed" : undefined,
      });
      type StreamEvent = Parameters<
        ReturnType<typeof createAssistantMessageEventStream>["push"]
      >[0];
      const script = (final: AssistantMessage, ...events: StreamEvent[]) => {
        scripted = (stream) => {
          void Promise.resolve().then(() => {
            for (const event of events) stream.push(event);
            stream.end(final);
          });
        };
      };
      let rows: [number, number, boolean][] = [];
      let costs: number[] = [];
      const metricsOptions = (overrides: Partial<DriverOptions>) =>
        options({
          path: "/root/metrics",
          onEvent: (event) => {
            if (event.kind === "usage") {
              rows.push([event.inputTokens, event.outputTokens, event.partial ?? false]);
              costs.push(Number(event.costUsd?.toFixed(3)));
            }
          },
          ...overrides,
        });
      // Inherited assistant usage must never be billed to the child.
      const driver = await create(
        metricsOptions({ inherited: [assistant(usage(500, 500, 20, 20))] }),
      );
      const partial = assistant(usage(4, 1, 1, 0), "pending");
      const grown = assistant(usage(4, 2, 1, 2), "pending");
      const finalMessage = assistant(usage(6, 4, 2, 3));
      script(
        finalMessage,
        { type: "start", partial },
        { type: "text_delta", contentIndex: 0, delta: "x", partial },
        { type: "text_delta", contentIndex: 0, delta: "y", partial: grown },
        { type: "done", reason: "stop", message: finalMessage },
      );
      await driver.prompt("count me");
      assert.deepEqual(rows, [
        [5, 1, true],
        [7, 2, true],
        [11, 4, false],
      ]);
      assert.deepEqual(costs, [0.006, 0.009, 0.015]);

      rows = [];
      costs = [];
      const failed = assistant(usage(2, 1, 1, 0), "error");
      script(failed, { type: "error", reason: "error", error: failed });
      await assert.rejects(driver.prompt("fail"), /model failed/);
      assert.deepEqual(rows, [[14, 5, false]]);
      assert.deepEqual(costs, [0.019]);

      // A reopened driver reports only usage produced after reopening.
      const file = driver.sessionFile!;
      driver.dispose();
      rows = [];
      costs = [];
      const reopened = await create(metricsOptions({ sessionFile: file, inherited: [] }));
      const resumed = assistant(usage(3, 2));
      script(resumed, { type: "done", reason: "stop", message: resumed });
      await reopened.prompt("resume");
      assert.deepEqual(rows, [[3, 2, false]]);
      assert.deepEqual(costs, [0.005]);
    });

    await t.test(
      "pick-first modes skip unconfigured providers and ignore suggestions",
      async () => {
        registerProvider("runtime-no-auth", ["missing-key"]);
        await registry.refresh({ allowNetwork: false });
        assert.ok(registry.find("runtime-no-auth", "missing-key"));
        assert.ok(!registry.getAvailable().some((model) => model.provider === "runtime-no-auth"));
        try {
          for (const mode of ["pick-first-available", "pick-first-scoped"] as const) {
            modelSelection = mode;
            setScopedModels(
              "runtime-no-auth/missing-key",
              "runtime-other/backup",
              "runtime-test/fallback",
            );
            const driver = await create(
              options({
                path: `/root/${mode}-without-auth`,
                type: {
                  ...options().type,
                  models: [
                    "runtime-no-auth/missing-key",
                    "missing-provider/missing-model",
                    "runtime-test/fallback",
                    "runtime-other/backup",
                  ],
                  modelSuggestions: ["backup", "model/with/slashes"],
                  thinkingLevel: "high",
                },
              }),
            );
            await driver.prompt("skip missing credentials");
            assertModel("runtime-test/fallback");
            assert.equal(
              SessionManager.open(driver.sessionFile!).buildSessionContext().thinkingLevel,
              "high",
            );
            await assert.rejects(
              create(modelOptions(`/root/${mode}-unavailable`, ["runtime-no-auth/missing-key"])),
              /none are available/,
            );
          }
        } finally {
          registry.unregisterProvider("runtime-no-auth");
          restoreScope();
        }
      },
    );

    await t.test(
      "pick-first scoped intersects availability and scope in preference order",
      async () => {
        try {
          setScopedModels("runtime-other/backup", "runtime-test/model/with/slashes");
          for (const [mode, expected] of [
            ["pick-first-available", "runtime-test/fallback"],
            ["pick-first-scoped", "runtime-other/backup"],
          ] as const) {
            modelSelection = mode;
            const driver = await create(
              modelOptions(`/root/${mode}-ordered`, [
                "runtime-test/fallback",
                "runtime-other/backup",
                "runtime-test/model/with/slashes",
              ]),
            );
            await driver.prompt("respect definition order");
            assertModel(expected);
          }
        } finally {
          restoreScope();
        }
      },
    );

    await t.test("Use Current ignores preferences and keeps each agent's thinking", async () => {
      modelSelection = "use-current";
      setScopedModels("runtime-test/fallback");
      setRootModel("runtime-other/backup");
      try {
        let index = 0;
        for (const preferences of [
          { models: ["missing-provider/missing-model", "runtime-test/fallback"] },
          { model: "runtime-test/fallback" },
          {},
        ]) {
          for (const thinkingLevel of ["off", "low", "high"] as const) {
            const driver = await create(
              options({
                path: `/root/current-${index++}`,
                type: {
                  ...options().type,
                  ...preferences,
                  thinkingLevel,
                  modelSuggestions: ["fallback"],
                },
              }),
            );
            await driver.prompt("use main model");
            assertModel("runtime-other/backup");
            assert.equal(
              SessionManager.open(driver.sessionFile!).buildSessionContext().thinkingLevel,
              thinkingLevel,
            );
          }
        }
      } finally {
        restoreScope();
      }
    });

    await t.test("Use Current ignores parent and restored models", async () => {
      try {
        modelSelection = "pick-first-available";
        const parent = await create(
          modelOptions("/root/current-parent", ["runtime-test/fallback"]),
        );
        await parent.prompt("persist parent model");
        const sessionFile = parent.sessionFile!;
        await parent.dispose();
        setRootModel("runtime-other/backup");
        setScopedModels();
        modelSelection = "use-current";
        const child = await create(
          options({
            path: "/root/current-parent/child",
            parentPath: "/root/current-parent",
            type: { ...options().type, thinkingLevel: "high" },
          }),
        );
        await child.prompt("ignore parent model");
        assertModel("runtime-other/backup");
        assert.equal(
          SessionManager.open(child.sessionFile!).buildSessionContext().thinkingLevel,
          "high",
        );
        const reopened = await create(
          modelOptions("/root/current-parent", ["runtime-test/fallback"], { sessionFile }),
        );
        await reopened.prompt("ignore restored model");
        assertModel("runtime-other/backup");
      } finally {
        restoreScope();
      }
    });

    await t.test(
      "disabled filtering picks the first available preference, even outside or without a scope",
      async () => {
        // Re-setting keys refreshes the registry's available-model list.
        await runtime.setRuntimeApiKey("runtime-test", apiKeys["runtime-test"]);
        modelSelection = "pick-first-available";
        setScopedModels("runtime-other/backup");
        setRootModel("runtime-other/backup");
        try {
          next = answer("unscoped fallback");
          const driver = await create(
            modelOptions("/root/unscoped-ordered", [
              "runtime-test/missing",
              "runtime-test/fallback",
              "runtime-other/backup",
            ]),
          );
          await driver.prompt("prefer first available");
          assertModel("runtime-test/fallback");
          setScopedModels();
          await assert.rejects(
            create(modelOptions("/root/disabled-missing", ["runtime-test/missing"])),
            (error: unknown) => {
              assert.match(String(error), /available models/i);
              assert.doesNotMatch(String(error), /\/scoped-models/);
              return true;
            },
          );
        } finally {
          restoreScope();
        }
      },
    );

    await t.test(
      "omitted models inherit the root model despite unmatched suggestions or disabled filtering",
      async () => {
        modelSelection = "pick-first-available";
        setScopedModels();
        setRootModel("runtime-other/backup");
        try {
          next = answer("inherited despite suggestions");
          const driver = await create(
            options({
              path: "/root/suggestion-inherit",
              type: {
                ...options().type,
                modelSuggestions: ["Missing Display Name", "runtime-test/not-in-scope"],
              },
            }),
          );
          await driver.prompt("inherit with unmatched suggestions");
          assertModel("runtime-other/backup");
          assert.equal(
            events.some(
              (event) =>
                event.kind === "error" &&
                /Missing Display|not-in-scope|modelSuggestions/.test(event.text),
            ),
            false,
          );
        } finally {
          restoreScope();
        }
      },
    );

    await t.test(
      "disabling scoped filtering stops scope-drift rejection without reselection",
      async () => {
        modelSelection = "pick-first-scoped";
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
        const { tool, started, release } = gatedTool("filter_gate");
        try {
          next = toolCall("filter-gate-1", "filter_gate");
          const driver = await create(
            toolOptions("/root/filter-toggle", tool, [
              "runtime-test/model/with/slashes",
              "runtime-other/backup",
            ]),
          );
          const beforeCalls = calls;
          const run = driver.prompt("tool turn");
          await started;
          setScopedModels();
          modelSelection = "pick-first-available";
          await driver.steer("steer while scope drifted");
          next = answer("continued on original");
          release();
          await run;
          assert.equal(calls, beforeCalls + 2);
          assertModel("runtime-test/model/with/slashes");
          assert.equal(driver.output(), "continued on original");
          assert.equal(countMessages(driver.snapshot(), "user", "steer while scope drifted"), 1);

          next = answer("request while disabled");
          await driver.prompt("later request");
          assertModel("runtime-test/model/with/slashes");

          modelSelection = "pick-first-scoped";
          setScopedModels("runtime-other/backup");
          next = answer("reselected backup");
          await driver.prompt("scope restored");
          assertModel("runtime-other/backup");
        } finally {
          release();
          restoreScope();
        }
      },
    );

    await t.test("invalid model/tool/storage policies fail closed", async () => {
      await assert.rejects(
        factory(options({ type: { ...options().type, model: "bad" } })),
        /provider\/model-id/,
      );
      await assert.rejects(
        factory(options({ type: { ...options().type, tools: { allow: ["missing"] } } })),
        /Unavailable tool/,
      );
      ctx.model = { ...ctx.model!, api: "pi-virtual", id: "virtual" };
      const find = registry.find.bind(registry);
      registry.find = (provider, id) => (id === "virtual" ? ctx.model : find(provider, id));
      await assert.rejects(factory(options()), /Virtual model.*physical/);
    });
  } finally {
    for (const driver of drivers) driver.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

