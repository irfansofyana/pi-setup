import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Message, Model, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai";

type CompleteSimple = <TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "btw", "config.json");
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface BtwConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxContextChars: number;
  maxHistoryTurns: number;
}

export interface BtwTurn {
  question: string;
  answer: string;
  timestamp: number;
}

interface BtwState {
  histories: Map<string, BtwTurn[]>;
}

interface ResolvedModel {
  model: Model<Api>;
  auth: AuthOptions;
  runtime?: PiModelRuntime;
}

const STATE_KEY = Symbol.for("pi-local-btw-state");
const DEFAULT_CONFIG: BtwConfig = {
  maxContextChars: 40_000,
  maxHistoryTurns: 8,
};

const SYSTEM_PROMPT = `You answer side questions for a coding-agent user.

Use the supplied main-session context as read-only background. Answer the side question directly and concisely. Do not claim to have changed files, run tools, queued work, or affected the main agent. If the context is insufficient, say what is unknown and what to check next.`;

interface AuthOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  baseUrl?: string;
}

interface RuntimeAuthResult {
  auth?: AuthOptions;
  env?: Record<string, string>;
}

interface PiModelRuntime {
  getAuth?: (model: Model<Api>) => Promise<RuntimeAuthResult | undefined>;
  completeSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
}

function getState(): BtwState {
  const globalState = globalThis as unknown as { [STATE_KEY]?: BtwState };
  if (!globalState[STATE_KEY]) globalState[STATE_KEY] = { histories: new Map() };
  return globalState[STATE_KEY];
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.() ?? "memory";
}

export function getHistory(ctx: ExtensionContext): BtwTurn[] {
  const key = sessionKey(ctx);
  const state = getState();
  let history = state.histories.get(key);
  if (!history) {
    history = [];
    state.histories.set(key, history);
  }
  return history;
}

function setHistory(ctx: ExtensionContext, history: BtwTurn[]): void {
  getState().histories.set(sessionKey(ctx), history);
}

export function clearHistory(ctx: ExtensionContext): void {
  setHistory(ctx, []);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseModelReference(reference: string): { provider: string; modelId: string } | undefined {
  if (!reference || /\s/.test(reference)) return undefined;
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return undefined;
  return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function normalizeConfig(input: unknown): BtwConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...DEFAULT_CONFIG };
  const raw = input as Record<string, unknown>;
  const model = typeof raw.model === "string" && parseModelReference(raw.model) ? raw.model : undefined;
  const thinkingLevel = isThinkingLevel(raw.thinkingLevel) ? raw.thinkingLevel : undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    maxContextChars: clampInteger(raw.maxContextChars, DEFAULT_CONFIG.maxContextChars, 1_000, 200_000),
    maxHistoryTurns: clampInteger(raw.maxHistoryTurns, DEFAULT_CONFIG.maxHistoryTurns, 0, 50),
  };
}

export function readConfig(path = CONFIG_PATH): BtwConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function messageText(message: Record<string, unknown>): string {
  const role = message.role;
  if (role === "branchSummary" && typeof message.summary === "string") {
    return `branch_summary: ${message.summary}`;
  }
  if (role === "compactionSummary" && typeof message.summary === "string") {
    return `compaction_summary: ${message.summary}`;
  }
  if (role === "bashExecution") {
    if (message.excludeFromContext === true) return "";
    const command = typeof message.command === "string" ? message.command : "";
    const output = typeof message.output === "string" ? message.output : "";
    return `bash: ${command}\n${output}`.trim();
  }
  const text = textFromContent(message.content).trim();
  return text ? `${String(role)}: ${text}` : "";
}

function entryText(entry: Record<string, unknown>): string {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    return messageText(entry.message as Record<string, unknown>);
  }
  if (entry.type === "custom_message") {
    const text = textFromContent(entry.content).trim();
    return text ? `custom: ${text}` : "";
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return `compaction_summary: ${entry.summary}`;
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return `branch_summary: ${entry.summary}`;
  }
  return "";
}

function trimFromEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars).trimStart();
}

export function buildConversationContext(items: unknown[], maxChars: number): string {
  const lines: string[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    const text = item.type ? entryText(item).trim() : messageText(item).trim();
    if (!text) continue;
    lines.push(text);
  }
  return trimFromEnd(lines.join("\n\n"), maxChars);
}

function readCompactionAwareContextItems(ctx: ExtensionCommandContext): unknown[] {
  const sessionManager = ctx.sessionManager as unknown as {
    buildSessionContext?: () => { messages?: unknown[] };
    buildContextEntries?: () => unknown[];
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
  };
  const sessionContext = sessionManager.buildSessionContext?.();
  if (Array.isArray(sessionContext?.messages)) return sessionContext.messages;
  const contextEntries = sessionManager.buildContextEntries?.();
  if (Array.isArray(contextEntries)) return contextEntries;
  return sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
}

export function buildHistoryContext(history: BtwTurn[], maxTurns: number): string {
  if (maxTurns <= 0 || history.length === 0) return "";
  return history
    .slice(-maxTurns)
    .map((turn, index) => [`Side turn ${index + 1}`, `User: ${turn.question}`, `Assistant: ${turn.answer}`].join("\n"))
    .join("\n\n");
}

export function buildUserPrompt(question: string, conversationContext: string, historyContext: string): string {
  return [
    "## Main Session Context",
    conversationContext || "(No main session context available.)",
    historyContext ? "## Previous /btw Side Thread" : "",
    historyContext,
    "## Side Question",
    question,
  ].filter(Boolean).join("\n\n");
}

async function loadCompleteSimple(importModule: (id: string) => Promise<unknown> = (id) => import(id)): Promise<CompleteSimple> {
  let lastError: unknown;
  for (const moduleId of ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"]) {
    try {
      const mod = await importModule(moduleId);
      const maybeComplete = (mod as { completeSimple?: unknown }).completeSimple;
      if (typeof maybeComplete === "function") return maybeComplete as CompleteSimple;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("@earendil-works/pi-ai completeSimple is unavailable", { cause: lastError });
}

function runtimeFromContext(ctx: ExtensionCommandContext): PiModelRuntime | undefined {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: PiModelRuntime }).runtime;
  return runtime && typeof runtime.getAuth === "function" ? runtime : undefined;
}

function cleanHeaders(headers: AuthOptions["headers"]): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== null && value !== undefined));
}

async function authModel(ctx: ExtensionCommandContext, model: Model<Api>): Promise<ResolvedModel | undefined> {
  const runtime = runtimeFromContext(ctx);
  const runtimeAuth = await runtime?.getAuth?.(model);
  if (runtimeAuth?.auth) {
    return {
      model: runtimeAuth.auth.baseUrl ? { ...model, baseUrl: runtimeAuth.auth.baseUrl } : model,
      auth: {
        apiKey: runtimeAuth.auth.apiKey,
        headers: cleanHeaders(runtimeAuth.auth.headers),
        env: runtimeAuth.env,
        baseUrl: runtimeAuth.auth.baseUrl,
      },
      runtime,
    };
  }

  const legacyAuth = await ctx.modelRegistry.getApiKeyAndHeaders?.(model);
  if (!legacyAuth?.ok) return undefined;
  return { model, auth: legacyAuth };
}

async function resolveModel(ctx: ExtensionCommandContext, config: BtwConfig): Promise<ResolvedModel | undefined> {
  const currentModel = ctx.model as Model<Api> | undefined;
  let model = currentModel;
  if (config.model) {
    const parsed = parseModelReference(config.model);
    const configured = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
    if (configured) {
      const configuredAuth = await authModel(ctx, configured);
      if (configuredAuth) return configuredAuth;
      ctx.ui.notify(`/btw model ${config.model} has no usable credentials; using current model.`, "warning");
    } else {
      ctx.ui.notify(`/btw model ${config.model} not found; using current model.`, "warning");
    }
  }
  if (!model) return undefined;

  const currentAuth = await authModel(ctx, model);
  if (!currentAuth) {
    ctx.ui.notify(`/btw model ${model.provider}/${model.id} has no usable credentials.`, "error");
    return undefined;
  }
  return currentAuth;
}

function assistantText(message: AssistantMessage): string {
  return textFromContent(message.content).trim();
}

export function buildStreamOptions(auth: AuthOptions, signal: AbortSignal | undefined, thinkingLevel: ThinkingLevel | undefined): SimpleStreamOptions {
  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
  };
  if (thinkingLevel && thinkingLevel !== "off") {
    (options as unknown as { reasoning: ThinkingLevel }).reasoning = thinkingLevel;
  }
  return options;
}

async function askBtw(question: string, ctx: ExtensionCommandContext, config: BtwConfig): Promise<string> {
  const selected = await resolveModel(ctx, config);
  if (!selected) return "No available model for /btw. Configure Pi with /login or set a valid ~/.pi/agent/btw/config.json model.";

  const history = getHistory(ctx);
  const conversationContext = buildConversationContext(readCompactionAwareContextItems(ctx), config.maxContextChars);
  const historyContext = buildHistoryContext(history, config.maxHistoryTurns);
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: buildUserPrompt(question, conversationContext, historyContext) }],
    timestamp: Date.now(),
  };
  const context = { systemPrompt: SYSTEM_PROMPT, messages: [userMessage as Message], tools: [] };
  const options = buildStreamOptions(selected.auth, ctx.signal, config.thinkingLevel);

  const response = selected.runtime?.completeSimple
    ? await selected.runtime.completeSimple(selected.model, context, options)
    : await (await loadCompleteSimple())(selected.model, context, options);
  if (response.stopReason === "aborted") return "Cancelled.";
  if (response.stopReason === "error") return response.errorMessage ? `Error: ${response.errorMessage}` : "Error: /btw model call failed.";
  const answer = assistantText(response) || "(No answer text returned.)";
  history.push({ question, answer, timestamp: Date.now() });
  setHistory(ctx, config.maxHistoryTurns > 0 ? history.slice(-config.maxHistoryTurns) : []);
  return answer;
}

function statusText(ctx: ExtensionContext, config: BtwConfig): string {
  return [
    `historyTurns=${getHistory(ctx).length}`,
    `model=${config.model ?? "current"}`,
    `thinkingLevel=${config.thinkingLevel ?? "current"}`,
    `maxContextChars=${config.maxContextChars}`,
    `maxHistoryTurns=${config.maxHistoryTurns}`,
    `config=${CONFIG_PATH}`,
  ].join("\n");
}

export default function btw(pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Ask a side question without adding it to the main conversation",
    getArgumentCompletions(prefix: string) {
      const items = ["status", "clear"].filter((item) => item.startsWith(prefix.trim().toLowerCase()));
      return items.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      const config = readConfig();

      if (input === "status") {
        ctx.ui.notify(statusText(ctx, config), "info");
        return;
      }
      if (input === "clear") {
        clearHistory(ctx);
        ctx.ui.notify("/btw side-thread history cleared.", "info");
        return;
      }
      if (!input) {
        ctx.ui.notify("Usage: /btw <side question> | /btw status | /btw clear", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive Pi mode.", "error");
        return;
      }

      ctx.ui.setStatus("btw", "btw...");
      try {
        const thinkingLevel = config.thinkingLevel ?? pi.getThinkingLevel();
        const answer = await askBtw(input, ctx, { ...config, thinkingLevel: thinkingLevel as ThinkingLevel });
        ctx.ui.notify(`/btw ${input}\n\n${answer}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/btw failed: ${message}`, "error");
      } finally {
        ctx.ui.setStatus("btw", undefined);
      }
    },
  });
}
