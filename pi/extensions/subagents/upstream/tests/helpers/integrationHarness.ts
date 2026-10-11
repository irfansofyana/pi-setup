import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionError,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import piSubagent from "../../src/index.ts";
import type { SavedThread } from "../../src/types.ts";
import type { ManagerSettings } from "../../src/prefs/settings.ts";

export const REGISTRY_ENTRY = "pi-subagent:registry:v1";

export type LoggedRequest = {
  call: number;
  pathCall: number;
  provider: string;
  modelId: string;
  path: string | null;
  lexicalParent: string | null;
  system: string;
  messagesText: string;
  toolNames: string[];
};
export type OfflineHarness = {
  directory: string;
  cwd: string;
  errors: ExtensionError[];
  requests: LoggedRequest[];
  open(manager: SessionManager): Promise<AgentSession>;
  close(session: AgentSession): Promise<void>;
  tool<T>(session: AgentSession, name: string, args: Record<string, unknown>): Promise<T>;
};

export const registry = (manager: SessionManager, fromId?: string) => {
  const entry = [...manager.getBranch(fromId)]
    .reverse()
    .find((item) => item.type === "custom" && item.customType === REGISTRY_ENTRY);
  assert.ok(entry?.type === "custom", "durable registry entry exists");
  return entry.data as { version: number; rootSessionId: string; threads: SavedThread[] };
};

export async function withOfflineHarness(
  options: {
    agentFiles: Record<string, string>;
    onRequest(request: LoggedRequest): AssistantMessage | Promise<AssistantMessage>;
    scopedModels?: string[];
    managerSettings?: Partial<ManagerSettings>;
    builtinTools?: boolean;
    extensionFactories?: ExtensionFactory[];
  },
  body: (harness: OfflineHarness) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const sessions = new Set<AgentSession>();
  const errors: ExtensionError[] = [];
  const requests: LoggedRequest[] = [];
  const byPath = new Map<string, number>();
  try {
    const cwd = path.join(directory, "workspace");
    await mkdir(cwd);
    if (options.managerSettings) {
      await mkdir(path.join(directory, "subagent-manager"));
      await writeFile(
        path.join(directory, "subagent-manager", "settings.json"),
        JSON.stringify(options.managerSettings),
      );
    }
    const agentsDir = path.join(directory, "subagent-manager", "agents");
    await mkdir(agentsDir, { recursive: true });
    for (const [name, content] of Object.entries(options.agentFiles)) {
      await writeFile(path.join(agentsDir, `${name}.md`), content);
    }
    const loaded = await discoverAndLoadExtensions(
      [fileURLToPath(new URL("../../src/index.ts", import.meta.url))],
      cwd,
      directory,
    );
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.extensions.some((extension) => extension.tools.has("agent_spawn")));

    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider("integration-test", {
      api: "openai-completions",
      baseUrl: "http://invalid.local",
      models: [
        {
          id: "offline",
          name: "Offline",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        },
        {
          id: "offline-alt",
          name: "Offline Alt",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        },
      ],
      streamSimple(model, context) {
        const system = JSON.stringify(getCurrentSystemPrompt(context.messages));
        const pathKey =
          system.match(/Your thread path is (\/root(?:\/[A-Za-z0-9_-]+)*)\./)?.[1] ?? system;
        const request: LoggedRequest = {
          call: requests.length + 1,
          pathCall: (byPath.get(pathKey) ?? 0) + 1,
          provider: model.provider,
          modelId: model.id,
          path: typeof pathKey === "string" && pathKey.startsWith("/root") ? pathKey : null,
          lexicalParent:
            system.match(/Your lexical parent is (\/root(?:\/[A-Za-z0-9_-]+)*);/)?.[1] ?? null,
          system,
          messagesText: JSON.stringify(context.messages),
          toolNames: getCurrentTools(context.messages).map((tool) => tool.name),
        };
        byPath.set(pathKey, request.pathCall);
        requests.push(request);
        const reply = options.onRequest(request);
        const stream = createAssistantMessageEventStream();
        void Promise.resolve()
          .then(async () => {
            const message = await reply;
            stream.push({ type: "start", partial: message });
            stream.push({
              type: "done",
              reason: message.stopReason as "stop" | "toolUse",
              message,
            });
            stream.end(message);
          })
          .catch((error: unknown) => {
            const message: AssistantMessage = {
              role: "assistant",
              content: [],
              provider: model.provider,
              model: model.id,
              api: model.api,
              stopReason: "error",
              errorMessage: String(error),
              timestamp: Date.now(),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
            stream.push({ type: "error", reason: "error", error: message });
            stream.end(message);
          });
        return stream;
      },
    });
    await runtime.setRuntimeApiKey("integration-test", "offline-runtime-key");
    const scopedModels = (
      options.scopedModels ?? ["integration-test/offline", "integration-test/offline-alt"]
    ).map((identity) => {
      const slash = identity.indexOf("/");
      return { model: runtime.getModel(identity.slice(0, slash), identity.slice(slash + 1))! };
    });

    const open = async (manager: SessionManager) => {
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "OFFLINE PARENT",
        appendSystemPrompt: [],
        extensionFactories: [piSubagent, ...(options.extensionFactories ?? [])],
      });
      await resourceLoader.reload();
      const { session, extensionsResult } = await createAgentSession({
        cwd,
        agentDir: directory,
        modelRuntime: runtime,
        model: runtime.getModel("integration-test", "offline"),
        scopedModels,
        sessionManager: manager,
        settingsManager,
        resourceLoader,
        noTools: options.builtinTools ? undefined : "builtin",
        thinkingLevel: "off",
      });
      sessions.add(session);
      assert.deepEqual(extensionsResult.errors, []);
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      const enabled = options.managerSettings?.subagentMode !== "off";
      assert.equal(session.getActiveToolNames().includes("agent_spawn"), enabled);
      assert.equal(
        session.getAllTools().some((tool) => tool.name === "agent_steer" && tool.exposure !== "hidden"),
        enabled,
      );
      return session;
    };
    const close = async (session: AgentSession) => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      sessions.delete(session);
    };
    const tool = async <T>(
      session: AgentSession,
      name: string,
      args: Record<string, unknown>,
    ): Promise<T> => {
      const definition = session.getToolDefinition(name);
      assert.ok(definition, `${name} registered by extension`);
      const id = `integration-${name}`;
      const result = await definition.execute(
        id,
        args,
        undefined,
        undefined,
        session.extensionRunner.createToolContext(id, undefined),
      );
      return result.details as T;
    };

    await body({ directory, cwd, errors, requests, open, close, tool });
  } finally {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

