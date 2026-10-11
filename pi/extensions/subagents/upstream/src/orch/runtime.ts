import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BOOTSTRAP_MESSAGE,
  buildBootstrapMessage,
  buildQueuedUserMessage,
  buildUpdateDetails,
  DurableMailbox,
} from "./mailbox.ts";
import { selectTools } from "../prefs/config.ts";
import { TranscriptChannel } from "./transcript.ts";
import type { InheritedToolSource } from "./inherited-tools.ts";
import type { ModelSelectionMode, ToolFilteringMode } from "../prefs/settings.ts";
import {
  modelIdentity,
  getModelPreferences,
  selectPreferredModel,
  ModelPreferenceError,
} from "../prefs/models.ts";
import {
  THINKING_LEVELS,
  type AgentType,
  type ResolvedAgentSettings,
  type DriverFactory,
  type DriverOptions,
  type ThinkingLevel,
} from "../types.ts";

const BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
/** Persisted before transcript messages so older-leaf restores still carry ownership. */
const THREAD_OWNERSHIP_TYPE = "pi-subagent:thread:v1";
const SESSION_FILE_ERROR =
  "Subagent sessionFile must be a JSONL file inside this root's session directory";
type ScopedModel = ExtensionContext["scopedModels"][number];
interface ThreadOwnership {
  rootId: string;
  threadPath: string;
}

function parseModelIdentity(identity: string): { provider: string; id: string } {
  const slash = identity.indexOf("/");
  return { provider: identity.slice(0, slash), id: identity.slice(slash + 1) };
}

function scopedModelsKey(scopedModels: readonly ScopedModel[]): string {
  return scopedModels
    .map(({ model, thinkingLevel }) => `${modelIdentity(model)}\0${thinkingLevel ?? ""}`)
    .join("\n");
}

function isJsonlWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    !!relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative) &&
    file.endsWith(".jsonl")
  );
}

async function tryRealpath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function ownershipFromTranscript(content: string): ThreadOwnership | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== THREAD_OWNERSHIP_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data !== "object") return undefined;
    const { rootId, threadPath } = data as { rootId?: unknown; threadPath?: unknown };
    if (typeof rootId !== "string" || typeof threadPath !== "string") return undefined;
    return { rootId, threadPath };
  }
  return undefined;
}

/** Orchestrator file for /root and independent roots; nested parents supply their own file. */
function resolveParentSession(
  options: DriverOptions,
  rootSessionFile: string | undefined,
): string | undefined {
  if (options.parentSessionFile) return options.parentSessionFile;
  if (!options.parentPath || options.parentPath === "/root") return rootSessionFile;
  return undefined;
}

async function assertAcceptedSessionFile(
  sessionFile: string,
  sessionDir: string,
  legacyDir: string,
  rootId: string,
  threadPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const sharedDir = await realpath(sessionDir);
  signal.throwIfAborted();
  const file = await tryRealpath(sessionFile);
  signal.throwIfAborted();
  const legacyDirReal = await tryRealpath(legacyDir);
  signal.throwIfAborted();
  // Legacy root-scoped transcripts stay valid, including files nested under that directory.
  if (file && legacyDirReal && isJsonlWithin(legacyDirReal, file)) return;
  if (!file || path.dirname(file) !== sharedDir || !file.endsWith(".jsonl")) {
    throw new Error(SESSION_FILE_ERROR);
  }
  const ownership = ownershipFromTranscript(await readFile(file, { encoding: "utf8", signal }));
  signal.throwIfAborted();
  if (!ownership || ownership.rootId !== rootId || ownership.threadPath !== threadPath) {
    throw new Error(
      "Subagent sessionFile ownership metadata does not match this rootId and thread path",
    );
  }
}

/** Isolated SDK sessions with filtered root tool bridges, not reloaded root extensions. */
export function createDriverFactory(
  getRootContext: () => ExtensionContext,
  getModelSelection: () => ModelSelectionMode = () => "pick-first-scoped",
  getToolFiltering: () => ToolFilteringMode = () => "allowed",
  getInheritedTools: () => InheritedToolSource = () => ({ tools: [], activeNames: [] }),
): DriverFactory & {
  resolveAgentSettings(type: AgentType, parentPath: string): ResolvedAgentSettings;
} {
  // Keep resolved settings even after disposal: descendants inherit settings, not the caller's history.
  const resolved = new Map<string, { provider: string; id: string; thinking: ThinkingLevel }>();
  const normalizeScopedModels = (
    scopedModels: ExtensionContext["scopedModels"] | null | undefined,
  ): readonly ScopedModel[] => scopedModels ?? [];
  const availableModelCandidates = () =>
    getRootContext()
      .modelRegistry.getAvailable()
      .map((model) => ({ model }));
  const availableScopedModels = (scopedModels: readonly ScopedModel[]) => {
    const available = new Set(availableModelCandidates().map(({ model }) => modelIdentity(model)));
    return scopedModels.filter(({ model }) => available.has(modelIdentity(model)));
  };
  const selectTypeModelPreference = (
    type: AgentType,
    candidates: readonly { model: { provider: string; id: string } }[],
    filtering: boolean,
  ) => {
    try {
      return selectPreferredModel(type, candidates, filtering);
    } catch (error) {
      if (
        filtering &&
        candidates.length === 0 &&
        error instanceof Error &&
        !error.message.includes("[]")
      ) {
        const message = `${error.message} Current /scoped-models scope: [].`;
        throw error instanceof ModelPreferenceError
          ? new ModelPreferenceError(message, error.scopedModelFiltering)
          : new Error(message);
      }
      throw error;
    }
  };
  // Discovery and new/restored drivers share model selection and thinking inheritance.
  const resolveInitialSettings = (
    type: AgentType,
    parentPath?: string | null,
    restored?: ReturnType<SessionManager["buildSessionContext"]>,
  ) => {
    const ctx = getRootContext();
    const parent = parentPath
      ? resolved.get(`${ctx.sessionManager.getSessionId()}:${parentPath}`)
      : undefined;
    const mode = getModelSelection();
    const preferences = mode === "use-current" ? undefined : getModelPreferences(type);
    let provider = parent?.provider ?? ctx.model?.provider;
    let id = parent?.id ?? ctx.model?.id;
    if (mode === "use-current") {
      provider = ctx.model?.provider;
      id = ctx.model?.id;
    } else if (preferences !== undefined) {
      const filtering = mode === "pick-first-scoped";
      const candidates = filtering
        ? availableScopedModels(normalizeScopedModels(ctx.scopedModels))
        : availableModelCandidates();
      ({ provider, id } = parseModelIdentity(
        selectTypeModelPreference(type, candidates, filtering)!,
      ));
    } else if (restored?.model) {
      provider = restored.model.provider;
      id = restored.model.modelId;
    }
    const savedThinking =
      restored && THINKING_LEVELS.includes(restored.thinkingLevel as ThinkingLevel)
        ? (restored.thinkingLevel as ThinkingLevel)
        : undefined;
    const thinkingLevel =
      savedThinking ?? type.thinkingLevel ?? parent?.thinking ?? ctx.thinkingLevel ?? "off";
    return { provider, id, thinkingLevel };
  };
  const resolveAgentSettings = (type: AgentType, parentPath: string): ResolvedAgentSettings => {
    const ctx = getRootContext();
    const { provider, id, thinkingLevel } = resolveInitialSettings(type, parentPath);
    const model =
      normalizeScopedModels(ctx.scopedModels).find(
        ({ model }) => model.provider === provider && model.id === id,
      )?.model ?? (provider && id ? ctx.modelRegistry.find(provider, id) : undefined);
    if (!model)
      throw new Error(
        `Subagent model ${provider ?? "(unset)"}/${id ?? "(unset)"} is unavailable; select a physical model in the root or agent type`,
      );
    if (model.api === "pi-virtual")
      throw new Error(
        `Virtual model ${provider}/${id} cannot be reproduced through the public registry API. Set this agent type's model to a physical provider/model-id.`,
      );
    return { model: modelIdentity(model), thinkingLevel: clampThinkingLevel(model, thinkingLevel) };
  };
  const createDriver: DriverFactory = async (options) => {
    options.signal.throwIfAborted();
    const ctx = getRootContext();
    // Tool policy is a startup snapshot; retained live sessions keep their selected set.
    const toolFiltering = getToolFiltering();
    const rootId = ctx.sessionManager.getSessionId();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rootId))
      throw new Error("Unsafe root session id for subagent storage");
    const agentDir = getAgentDir();
    const sessionDir = ctx.sessionManager.getSessionDir();
    const legacyDir = path.join(agentDir, "subagents", rootId);
    options.signal.throwIfAborted();
    await mkdir(sessionDir, { recursive: true });
    options.signal.throwIfAborted();
    let sessionManager: SessionManager;
    if (options.sessionFile) {
      await assertAcceptedSessionFile(
        options.sessionFile,
        sessionDir,
        legacyDir,
        rootId,
        options.path,
        options.signal,
      );
      // Open the caller path, not its realpath, so retained sessionFile identity is stable.
      sessionManager = SessionManager.open(path.resolve(options.sessionFile), sessionDir, ctx.cwd);
      if (options.sessionLeafId !== undefined) {
        if (options.sessionLeafId === null) sessionManager.resetLeaf();
        else sessionManager.branch(options.sessionLeafId);
      }
    } else {
      const parentSession = resolveParentSession(options, ctx.sessionManager.getSessionFile());
      sessionManager = SessionManager.create(
        ctx.cwd,
        sessionDir,
        parentSession ? { parentSession } : undefined,
      );
      // Before transcript messages so an older restored leaf still has name and ownership as ancestors.
      sessionManager.appendSessionInfo(`${options.type.name} ${options.path}`);
      sessionManager.appendCustomEntry(THREAD_OWNERSHIP_TYPE, {
        rootId,
        threadPath: options.path,
        inheritedCount: options.inherited.length,
      });
      for (const message of options.inherited) {
        // Summary messages are projections, not appendable SDK session entries.
        if (message.role === "compactionSummary" || message.role === "branchSummary") {
          sessionManager.appendMessage({
            role: "user",
            content: message.summary,
            timestamp: message.timestamp,
          });
        } else if (message.role === "custom") {
          sessionManager.appendCustomMessageEntry(
            message.customType,
            message.content,
            message.display,
            message.details,
          );
        } else if (
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "toolResult" ||
          message.role === "bashExecution"
        ) {
          sessionManager.appendMessage(message);
        }
      }
    }
    const restored = options.sessionFile ? sessionManager.buildSessionContext() : undefined;
    const modelSelection = getModelSelection();
    // Use Current ignores definition preferences, including for restored/nested sessions.
    const modelPreferences =
      modelSelection === "use-current" ? undefined : getModelPreferences(options.type);
    const filteringEnabled = () => getModelSelection() === "pick-first-scoped";
    const selectModelPreference = (
      candidates: readonly { model: { provider: string; id: string } }[],
      filtering = filteringEnabled(),
    ) => selectTypeModelPreference(options.type, candidates, filtering);
    const initialScopedModels = normalizeScopedModels(ctx.scopedModels);
    const { provider, id, thinkingLevel } = resolveInitialSettings(
      options.type,
      options.parentPath,
      restored,
    );
    options.signal.throwIfAborted();
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"),
      allowModelNetwork: false,
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
      const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
      const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
      if (native) runtime.registerNativeProvider(native);
      if (config) runtime.registerProvider(providerId, config);
    }
    const mirrorRuntimeAuth = async (providerId: string) => {
      options.signal.throwIfAborted();
      if (ctx.modelRegistry.getProviderAuthStatus(providerId).source !== "runtime") return;
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
      options.signal.throwIfAborted();
      if (apiKey !== undefined)
        await runtime.setRuntimeApiKey(providerId, apiKey, { signal: options.signal });
      options.signal.throwIfAborted();
    };
    const resolveRuntimeModel = async (
      providerId: string | undefined,
      modelId: string | undefined,
      scopedModels: readonly ScopedModel[],
    ) => {
      if (!providerId || !modelId)
        throw new Error(
          `Subagent model ${providerId ?? "(unset)"}/${modelId ?? "(unset)"} is unavailable; select a physical model in the root or agent type`,
        );
      await mirrorRuntimeAuth(providerId);
      const sourceModel =
        scopedModels.find(({ model }) => model.provider === providerId && model.id === modelId)
          ?.model ?? ctx.modelRegistry.find(providerId, modelId);
      if (sourceModel?.api === "pi-virtual") {
        throw new Error(
          `Virtual model ${providerId}/${modelId} cannot be reproduced through the public registry API. Set this agent type's model to a physical provider/model-id.`,
        );
      }
      const runtimeModel = runtime.getModel(providerId, modelId);
      if (!runtimeModel)
        throw new Error(
          `Subagent model ${providerId}/${modelId} is unavailable; select a physical model in the root or agent type`,
        );
      return runtimeModel;
    };
    const model = await resolveRuntimeModel(provider, id, initialScopedModels);
    const inherited = getInheritedTools();
    const localNames = new Set([...BUILTINS, ...options.tools.map((tool) => tool.name)]);
    const externalTools = inherited.tools.filter((tool) => !localNames.has(tool.name));
    const toolNames = selectTools(
      options.type.tools,
      [...localNames, ...externalTools.map((tool) => tool.name)],
      toolFiltering,
    );
    const allowed = new Set(toolNames);
    const rootActive = new Set(inherited.activeNames);
    // Preserve deferred/codemode exposure rather than flooding model declarations with MCP tools.
    const activeToolNames = toolNames.filter(
      (name) =>
        localNames.has(name) ||
        rootActive.has(name) ||
        (options.type.tools?.allow?.includes(name) && toolFiltering === "allowed"),
    );
    const customTools = [...options.tools, ...externalTools].filter(
      (tool) => allowed.has(tool.name) && tool.name !== "codemode" && tool.name !== "tool_search",
    );
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
    let parkQueue = () => {};
    const pauseBoundary = () => {
      if (!options.shouldPause()) return undefined;
      parkQueue();
      return { continue: false };
    };
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
      systemPrompt: [
        options.type.systemPrompt,
        `Your thread path is ${options.path}.`,
        options.parentPath
          ? `Your lexical parent is ${options.parentPath}; inherited conversation comes only from that parent.`
          : "You are an independent root thread with no inherited history.",
        "When finished, give your final answer normally so it can be handed back. To retain unfinished work without a final answer, call agent_pause (if available), then stop; resume only when instructed.",
        ...(allowed.has("agent_spawn") && allowed.has("agent_wait")
          ? [
              "Name child paths with concise task-based kebab-case slugs (e.g. /root/controller-security-research), independent of type.",
              "For independent parallel work, launch all siblings with agent_spawn wait:false before calling agent_wait. Children share the main conversation's depth and concurrency limits; waiting parents count as active. Do not delegate work beyond your assigned scope.",
            ]
          : []),
      ].join("\n\n"),
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        // These orchestrators must see the CHILD loadout. Forwarding root codemode would
        // let scripts discover/call tools outside the child's allow/block policy.
        ...(allowed.has("codemode") ? [createCodemodeExtension()] : []),
        ...(allowed.has("tool_search") ? [createToolSearchExtension()] : []),
        (pi) => {
          pi.on("turn_end", pauseBoundary);
          pi.on("agent_before_settle", pauseBoundary);
          pi.on("tool_call", (event) =>
            allowed.has(event.toolName)
              ? undefined
              : { block: true, reason: "Tool is not allowed by this agent type" },
          );
        },
      ],
    });
    options.signal.throwIfAborted();
    await loader.reload();
    options.signal.throwIfAborted();
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel,
      scopedModels: [...initialScopedModels],
      settingsManager,
      resourceLoader: loader,
      sessionManager,
      // SDK `tools` is both a registry allowlist and an initial active list.
      // Register every permitted deferred tool, then narrow declarations after bind.
      tools: toolNames,
      customTools,
    });
    let lastScopedModelsKey = "";
    const updateResolved = () => {
      const currentModel = session.model;
      if (!currentModel) throw new Error(`Subagent ${options.path} has no selected model`);
      resolved.set(`${rootId}:${options.path}`, {
        provider: currentModel.provider,
        id: currentModel.id,
        thinking: session.thinkingLevel,
      });
      options.onEvent({
        kind: "settings",
        model: modelIdentity(currentModel),
        thinkingLevel: session.thinkingLevel,
      });
    };
    const assertScopedRequestAuthorized = (
      currentIdentity: string | undefined,
      liveScopedModels: readonly ScopedModel[],
    ) => {
      if (!filteringEnabled() || modelPreferences === undefined) return;
      const preferredIdentity = selectModelPreference(
        availableScopedModels(liveScopedModels),
        true,
      );
      if (!preferredIdentity) return;
      if (!currentIdentity) throw new Error(`Subagent ${options.path} has no selected model`);
      if (currentIdentity !== preferredIdentity) {
        throw new Error(
          `Agent type ${JSON.stringify(options.type.name)} scope changed for subagent ${JSON.stringify(options.path)}: current model is ${currentIdentity} but preferred is ${preferredIdentity}; resume agent to use ${preferredIdentity}.`,
        );
      }
    };
    const assertCurrentModelAuthorized = () => {
      const currentModel = session.model;
      assertScopedRequestAuthorized(
        currentModel ? modelIdentity(currentModel) : undefined,
        normalizeScopedModels(getRootContext().scopedModels),
      );
    };
    const enforceScopedModelPolicy = async () => {
      const liveScopedModels = normalizeScopedModels(getRootContext().scopedModels);
      const key = scopedModelsKey(liveScopedModels);
      if (key !== lastScopedModelsKey) {
        session.setScopedModels([...liveScopedModels]);
        lastScopedModelsKey = key;
      }
      if (!filteringEnabled() || modelPreferences === undefined) {
        updateResolved();
        return;
      }
      const preferredIdentity = selectModelPreference(
        availableScopedModels(liveScopedModels),
        true,
      );
      if (!preferredIdentity) {
        updateResolved();
        return;
      }
      const currentModel = session.model;
      if (!currentModel || modelIdentity(currentModel) !== preferredIdentity) {
        const { provider: preferredProvider, id: preferredId } =
          parseModelIdentity(preferredIdentity);
        await session.setModel(
          await resolveRuntimeModel(preferredProvider, preferredId, liveScopedModels),
        );
      }
      updateResolved();
    };
    try {
      await enforceScopedModelPolicy();
      options.signal.throwIfAborted();
      await session.bindExtensions({ mode: "print" });
      session.setActiveToolsByName(activeToolNames);
      options.signal.throwIfAborted();
    } catch (error) {
      session.dispose();
      throw error;
    }
    const streamFunction = session.agent.streamFunction;
    session.agent.streamFunction = async (requestModel, context, streamOptions) => {
      assertScopedRequestAuthorized(
        modelIdentity(requestModel),
        normalizeScopedModels(getRootContext().scopedModels),
      );
      return streamFunction(requestModel, context, streamOptions);
    };
    const mailbox = new DurableMailbox(sessionManager);
    const emitCheckpoint = () =>
      options.onEvent({
        kind: "checkpoint",
        text: "",
        sessionFile: session.sessionFile,
        sessionLeafId: sessionManager.getLeafId(),
      });
    const restoreAppends = mailbox.wrapAppends(emitCheckpoint);
    const ensurePersistedSession = () => {
      if (session.sessionFile && existsSync(session.sessionFile)) return;
      sessionManager.appendMessage(buildBootstrapMessage());
      emit("activity", BOOTSTRAP_MESSAGE);
    };
    const queueAccepted = async (kind: "steer" | "followUp", content: string) => {
      assertCurrentModelAuthorized();
      ensurePersistedSession();
      const accepted = mailbox.accept(kind, content);
      emitCheckpoint();
      if (kind === "followUp") session.agent.followUp(buildQueuedUserMessage(accepted));
      else session.agent.steer(buildQueuedUserMessage(accepted));
      mailbox.markEnqueued(accepted.id);
    };
    const resumePending = async () => {
      for (const accepted of mailbox.replayablePending()) {
        if (accepted.kind === "update") {
          await session.sendCustomMessage(
            {
              customType: "subagent-update",
              content: accepted.content,
              display: true,
              details: buildUpdateDetails(accepted),
            },
            { triggerTurn: false },
          );
          mailbox.markEnqueued(accepted.id);
          continue;
        }
        if (accepted.kind === "followUp") session.agent.followUp(buildQueuedUserMessage(accepted));
        else session.agent.steer(buildQueuedUserMessage(accepted));
        mailbox.markEnqueued(accepted.id);
      }
    };
    const clearPromptQueues = () => {
      session.clearQueue();
      mailbox.clearQueuedInputs();
    };
    // In 0.99.2 a boundary's continue:false only declines EXTRA continuation;
    // the public core hook is needed to stop automatic tool/steering continuation.
    parkQueue = clearPromptQueues;
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (options.shouldPause()) {
        clearPromptQueues();
        return { action: "end" };
      }
      return decision || undefined;
    };
    updateResolved();
    let disposed = false;
    let running = false;
    let aborted = false;
    let baseline = session.messages.length;
    // Subscribe after inherited/restored history is loaded; only new assistant events are counted.
    let settledInput = 0;
    let settledOutput = 0;
    let settledCost: number | undefined;
    const countedUsage = new WeakSet<object>();
    let finalOutput = "";
    let abortPromise: Promise<void> | undefined;
    const emit = (kind: "activity" | "error", text: string) =>
      options.onEvent({ kind, text: text.slice(0, 1000) });
    const assistantUsage = (message: AssistantMessage) => {
      const usage = message.usage;
      const input = usage.input + usage.cacheRead + usage.cacheWrite;
      const output = usage.output;
      if (!Number.isFinite(input) || !Number.isFinite(output)) return;
      const total = usage.cost?.total;
      const costUsd = Number.isFinite(total) && total >= 0 ? total : undefined;
      return {
        input,
        output,
        costUsd,
        reported: input + output + usage.totalTokens > 0 || (costUsd ?? 0) > 0,
      };
    };

    const ownership = sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === THREAD_OWNERSHIP_TYPE);
    const inheritedMetadata =
      ownership?.type === "custom"
        ? (ownership.data as { inheritedCount?: unknown })?.inheritedCount
        : undefined;
    const inheritedCount =
      typeof inheritedMetadata === "number" &&
      Number.isInteger(inheritedMetadata) &&
      inheritedMetadata >= 0
        ? inheritedMetadata
        : options.inherited.length;
    const transcript = new TranscriptChannel(
      () => session.messages,
      // A restored compaction has replaced the original inherited prefix.
      session.messages.some((message) => message.role === "compactionSummary") ? 0 : inheritedCount,
    );
    const unsubscribe = session.subscribe((event) => {
      transcript.accept(event);
      if (event.type === "tool_execution_start") emit("activity", `Tool: ${event.toolName}`);
      if (event.type === "tool_execution_end")
        emit(
          event.isError ? "error" : "activity",
          `Tool ${event.toolName}: ${event.isError ? "failed" : "finished"}`,
        );
      if (
        (event.type === "message_update" || event.type === "message_end") &&
        event.message.role === "assistant" &&
        !countedUsage.has(event.message)
      ) {
        const usage = assistantUsage(event.message);
        if (event.type === "message_update") {
          if (usage?.reported)
            options.onEvent({
              kind: "usage",
              inputTokens: settledInput + usage.input,
              outputTokens: settledOutput + usage.output,
              costUsd:
                usage.costUsd === undefined ? settledCost : (settledCost ?? 0) + usage.costUsd,
              partial: true,
            });
        } else {
          countedUsage.add(event.message);
          if (usage) {
            settledInput += usage.input;
            settledOutput += usage.output;
            if (usage.costUsd !== undefined) settledCost = (settledCost ?? 0) + usage.costUsd;
          }
          options.onEvent({
            kind: "usage",
            inputTokens: settledInput,
            outputTokens: settledOutput,
            costUsd: settledCost,
          });
          const text = event.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          if (text) emit("activity", text);
        }
      }
    });
    const assertOpen = () => {
      if (disposed) throw new Error("Subagent driver is disposed");
    };
    return {
      get sessionFile() {
        const file = session.sessionFile;
        return file && existsSync(file) ? file : undefined;
      },
      get sessionLeafId() {
        return sessionManager.getLeafId();
      },
      async prompt(message) {
        assertOpen();
        if (running) throw new Error("Subagent is already running; use steer instead");
        running = true;
        aborted = false;
        baseline = session.messages.length;
        finalOutput = "";
        try {
          await enforceScopedModelPolicy();
          await resumePending();
          await session.prompt(message, { expandPromptTemplates: false });
          await session.waitForIdle();
          const last = session.messages
            .slice(baseline)
            .filter((msg) => msg.role === "assistant")
            .at(-1);
          if (aborted || last?.stopReason === "aborted") throw new Error("Subagent run aborted");
          if (last?.stopReason === "error")
            throw new Error(last.errorMessage || "Subagent model failed");
          if (last && !options.shouldPause())
            finalOutput = last.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("");
        } catch (error) {
          emit("error", error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          updateResolved();
          running = false;
        }
      },
      async steer(message) {
        assertOpen();
        await queueAccepted("steer", message);
      },
      snapshot() {
        return structuredClone(session.messages);
      },
      observeTranscript(listener) {
        assertOpen();
        return transcript.observe(listener);
      },
      output() {
        return finalOutput;
      },
      async abort() {
        if (disposed) return;
        if (running) aborted = true;
        clearPromptQueues();
        if (!abortPromise)
          abortPromise = session.abort().finally(() => {
            abortPromise = undefined;
          });
        await abortPromise;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        aborted = true;
        restoreAppends();
        transcript.dispose();
        unsubscribe();
        session.dispose();
      },
      async sendUpdate(content) {
        assertOpen();
        try {
          ensurePersistedSession();
          const accepted = mailbox.accept("update", content);
          emitCheckpoint();
          // SDK session method is sendCustomMessage (ExtensionAPI calls it sendMessage).
          await session.sendCustomMessage(
            {
              customType: "subagent-update",
              content,
              display: true,
              details: buildUpdateDetails(accepted),
            },
            { triggerTurn: false },
          );
          mailbox.markEnqueued(accepted.id);
          transcript.reconcile();
        } catch (error) {
          emit("error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    };
  };
  return Object.assign(createDriver, { resolveAgentSettings });
}

