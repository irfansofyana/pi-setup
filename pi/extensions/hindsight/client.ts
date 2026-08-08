import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { projectKey, redactSecrets } from "./store.ts";

const execFileAsync = promisify(execFile);

export type HindsightScoping = "global" | "per-project" | "per-project-tagged";
export type HindsightBudget = "low" | "mid" | "high";

export interface HindsightConfig {
  apiUrl: string;
  apiToken?: string;
  bankId: string;
  scoping: HindsightScoping;
  autoRecall: boolean;
  autoRetain: boolean;
  autoStartDaemon: boolean;
  memoryBackend: boolean;
  retainMode: "full-session" | "last-turn";
  recallBudget: HindsightBudget;
  recallMaxTokens: number;
  requestTimeoutMs: number;
}

export type HindsightConfigFile = Partial<Pick<
  HindsightConfig,
  "apiUrl" | "bankId" | "scoping" | "autoRecall" | "autoRetain" | "autoStartDaemon" | "memoryBackend" | "retainMode" | "recallBudget" | "recallMaxTokens" | "requestTimeoutMs"
>>;

export const HINDSIGHT_CONFIG_PATH = join(homedir(), ".pi", "agent", "hindsight", "config.json");

export interface BankScope {
  bankId: string;
  tags?: string[];
  tagsMatch?: "any" | "all" | "any_strict" | "all_strict" | "exact";
}

export type MemoryScope = "project" | "global" | "all";

export interface RetainItem {
  content: string;
  context?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  document_id?: string;
  timestamp?: string;
}

export interface RecallResult {
  id?: string;
  text?: string;
  type?: string | null;
  context?: string | null;
  mentioned_at?: string | null;
  occurred_start?: string | null;
  metadata?: Record<string, string> | null;
}

export interface RecallResponse {
  results?: RecallResult[];
}

export interface ReflectResponse {
  text?: string;
}

export function readHindsightConfigFile(env: NodeJS.ProcessEnv = process.env): HindsightConfigFile {
  const path = env.HINDSIGHT_CONFIG_PATH || HINDSIGHT_CONFIG_PATH;
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as HindsightConfigFile : {};
  } catch {
    return {};
  }
}

export function writeHindsightConfigFile(config: HindsightConfigFile, env: NodeJS.ProcessEnv = process.env): string {
  const path = env.HINDSIGHT_CONFIG_PATH || HINDSIGHT_CONFIG_PATH;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

function stringValue(envValue: string | undefined, configValue: unknown, fallback: string): string {
  if (envValue) return envValue;
  return typeof configValue === "string" && configValue ? configValue : fallback;
}

function boolValue(envValue: string | undefined, configValue: unknown, fallback: boolean): boolean {
  if (envValue !== undefined && envValue !== "") return envValue !== "false";
  if (typeof configValue === "boolean") return configValue;
  if (typeof configValue === "string" && configValue !== "") return configValue !== "false";
  return fallback;
}

function numberValue(envValue: string | undefined, configValue: unknown, fallback: number): number {
  if (envValue !== undefined && envValue !== "") {
    const value = Number(envValue);
    if (!Number.isNaN(value)) return value;
  }
  if (typeof configValue === "number" && !Number.isNaN(configValue)) return configValue;
  if (typeof configValue === "string" && configValue !== "") {
    const value = Number(configValue);
    if (!Number.isNaN(value)) return value;
  }
  return fallback;
}

function enumValue<T extends string>(envValue: string | undefined, configValue: unknown, fallback: T, allowed: readonly T[]): T {
  const value = envValue || (typeof configValue === "string" ? configValue : "");
  return allowed.includes(value as T) ? value as T : fallback;
}

export function defaultHindsightConfig(env: NodeJS.ProcessEnv = process.env): HindsightConfig {
  const fileConfig = readHindsightConfigFile(env);
  return {
    apiUrl: stringValue(env.HINDSIGHT_API_URL, fileConfig.apiUrl, "http://127.0.0.1:8888"),
    apiToken: env.HINDSIGHT_API_TOKEN || env.HINDSIGHT_API_KEY || undefined,
    bankId: stringValue(env.HINDSIGHT_BANK_ID, fileConfig.bankId, "coding-agent"),
    scoping: enumValue(env.HINDSIGHT_SCOPING, fileConfig.scoping, "per-project-tagged", ["global", "per-project", "per-project-tagged"] as const),
    autoRecall: boolValue(env.HINDSIGHT_AUTO_RECALL, fileConfig.autoRecall, true),
    autoRetain: boolValue(env.HINDSIGHT_AUTO_RETAIN, fileConfig.autoRetain, true),
    autoStartDaemon: boolValue(env.HINDSIGHT_AUTO_START_DAEMON, fileConfig.autoStartDaemon, false),
    memoryBackend: boolValue(env.HINDSIGHT_MEMORY_BACKEND, fileConfig.memoryBackend, true),
    retainMode: enumValue(env.HINDSIGHT_RETAIN_MODE, fileConfig.retainMode, "full-session", ["full-session", "last-turn"] as const),
    recallBudget: enumValue(env.HINDSIGHT_RECALL_BUDGET, fileConfig.recallBudget, "mid", ["low", "mid", "high"] as const),
    recallMaxTokens: numberValue(env.HINDSIGHT_RECALL_MAX_TOKENS, fileConfig.recallMaxTokens, 1024),
    requestTimeoutMs: numberValue(env.HINDSIGHT_REQUEST_TIMEOUT_MS, fileConfig.requestTimeoutMs, 30_000),
  };
}

function safeBankPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function projectTag(cwd: string): string {
  return `project:${projectKey(cwd)}`;
}

export function computeBankScope(config: Pick<HindsightConfig, "bankId" | "scoping">, cwd: string): BankScope {
  if (config.scoping === "global") return { bankId: config.bankId };
  if (config.scoping === "per-project") return { bankId: `${safeBankPart(config.bankId)}-${safeBankPart(projectKey(cwd))}` };
  return { bankId: config.bankId, tags: [projectTag(cwd)], tagsMatch: "any" };
}

export function computeMemoryScope(
  config: Pick<HindsightConfig, "bankId" | "scoping">,
  cwd: string,
  scope: MemoryScope,
): BankScope {
  if (config.scoping === "per-project-tagged") {
    if (scope === "project") return { bankId: config.bankId, tags: [projectTag(cwd)], tagsMatch: "exact" };
    if (scope === "global") return { bankId: config.bankId, tags: [], tagsMatch: "exact" };
    return { bankId: config.bankId, tags: [projectTag(cwd)], tagsMatch: "any" };
  }
  if (config.scoping === "per-project" && scope === "all") {
    throw new Error("per-project scope 'all' spans two banks; use computeMemoryScopes()");
  }
  if (config.scoping === "per-project" && scope === "global") {
    return { bankId: config.bankId, tags: [], tagsMatch: "exact" };
  }
  if (config.scoping === "global" && scope === "global") {
    return { bankId: config.bankId, tags: [], tagsMatch: "exact" };
  }
  return computeBankScope(config, cwd);
}

export function computeMemoryScopes(
  config: Pick<HindsightConfig, "bankId" | "scoping">,
  cwd: string,
  scope: MemoryScope,
): BankScope[] {
  if (config.scoping === "per-project" && scope === "all") {
    return [
      computeMemoryScope(config, cwd, "project"),
      computeMemoryScope(config, cwd, "global"),
    ];
  }
  return [computeMemoryScope(config, cwd, scope)];
}

const RECALL_OUTPUT_LIMIT = 6_000;
const RECALL_HEADER_LINES = [
  "Relevant memories from past conversations (prioritize recent when conflicting).",
  "Only use memories directly useful for this task; ignore the rest:",
];

function recallResultKey(result: RecallResult): string {
  return result.id
    ? `id:${result.id}`
    : `text:${result.text ?? ""}\u0000${result.type ?? ""}\u0000${result.mentioned_at ?? result.occurred_start ?? ""}`;
}

function renderRecallLine(result: RecallResult): string {
  const date = (result.mentioned_at || result.occurred_start || "undated").slice(0, 10);
  const rawKind = (result.type || "memory").trim() || "memory";
  const kind = rawKind.length > 80 ? `${rawKind.slice(0, 79)}…` : rawKind;
  return `- [${kind} @ ${date}] ${(result.text || "").trim()}`;
}

function fitRecallResultToLine(result: RecallResult, maxLineLength: number): RecallResult {
  const text = (result.text || "").trim();
  let date = (result.mentioned_at || result.occurred_start || "undated").slice(0, 10);
  const rawKind = (result.type || "memory").trim() || "memory";
  const textReserve = Math.min(text.length, Math.max(1, Math.min(32, Math.floor(maxLineLength / 2))));
  let fixedPrefixLength = `- [ @ ${date}] `.length;
  if (maxLineLength - fixedPrefixLength - textReserve < 1) {
    date = "u";
    fixedPrefixLength = `- [ @ ${date}] `.length;
  }
  const kindLimit = Math.max(1, maxLineLength - fixedPrefixLength - textReserve);
  const kind = rawKind.length > kindLimit
    ? (kindLimit === 1 ? rawKind.slice(0, 1) : `${rawKind.slice(0, kindLimit - 1)}…`)
    : rawKind;
  const fitted = { ...result, type: kind, mentioned_at: date, occurred_start: undefined };
  const withoutText = renderRecallLine({ ...fitted, text: "" });
  const textLimit = Math.max(1, maxLineLength - withoutText.length);
  return {
    ...fitted,
    text: text.length > textLimit ? `${text.slice(0, Math.max(0, textLimit - 1))}…` : text,
  };
}

export function mergeRecallResponses(responses: RecallResponse[]): RecallResponse {
  // Earlier scopes keep duplicate ownership (project before global), but unique
  // renderable results are emitted round-robin. The first result from every
  // active scope is sized against the formatter's shared output budget.
  const owningScope = new Map<string, number>();
  responses.forEach((response, scopeIndex) => {
    for (const result of response.results ?? []) {
      if (!(result.text || "").trim()) continue;
      const key = recallResultKey(result);
      if (!owningScope.has(key)) owningScope.set(key, scopeIndex);
    }
  });

  const queues = responses.map((response, scopeIndex) => {
    const seen = new Set<string>();
    return (response.results ?? []).filter((result) => {
      if (!(result.text || "").trim()) return false;
      const key = recallResultKey(result);
      if (owningScope.get(key) !== scopeIndex || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  const activeScopeCount = queues.filter((queue) => queue.length > 0).length;
  const headerLength = RECALL_HEADER_LINES.join("\n").length;
  const firstLineBudget = activeScopeCount > 0
    ? Math.max(1, Math.floor((RECALL_OUTPUT_LIMIT - headerLength - activeScopeCount) / activeScopeCount))
    : RECALL_OUTPUT_LIMIT;

  const results: RecallResult[] = [];
  const positions = queues.map(() => 0);
  let added = true;
  while (added) {
    added = false;
    queues.forEach((queue, scopeIndex) => {
      const position = positions[scopeIndex];
      if (position >= queue.length) return;
      const result = queue[position];
      results.push(position === 0 ? fitRecallResultToLine(result, firstLineBudget) : result);
      positions[scopeIndex]++;
      added = true;
    });
  }
  return { results };
}

export function mergeReflectResponses(responses: ReflectResponse[]): ReflectResponse {
  const texts = [...new Set(responses.map((response) => response.text?.trim()).filter((text): text is string => Boolean(text)))];
  return { text: texts.join("\n\n") };
}

export function formatRecallResponse(response: RecallResponse): string {
  const results = response.results ?? [];
  if (!results.length) return "";
  const lines = [...RECALL_HEADER_LINES];
  let currentLength = lines.join("\n").length;
  for (const result of results) {
    if (!(result.text || "").trim()) continue;
    const remaining = RECALL_OUTPUT_LIMIT - currentLength - 1;
    if (remaining <= 0) break;
    const line = renderRecallLine(fitRecallResultToLine(result, remaining));
    lines.push(line.slice(0, remaining));
    currentLength += 1 + Math.min(line.length, remaining);
  }
  return lines.join("\n");
}

export function formatReflectResponse(response: ReflectResponse): string {
  return response.text?.trim() || "No hindsight reflection returned.";
}

export async function runHindsightEmbed(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync("uvx", ["hindsight-embed", ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

export class HindsightHttpClient {
  private readonly config: Pick<HindsightConfig, "apiUrl" | "apiToken" | "autoStartDaemon"> & Partial<Pick<HindsightConfig, "requestTimeoutMs">>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Pick<HindsightConfig, "apiUrl" | "apiToken" | "autoStartDaemon"> & Partial<Pick<HindsightConfig, "requestTimeoutMs">>, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async health(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/health", undefined, signal, false);
  }

  async retain(scope: BankScope, items: RetainItem[], options: { async?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    return this.request("POST", `/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories`, {
      items: items.map((item) => ({ ...item, content: redactSecrets(item.content), tags: item.tags ?? scope.tags })),
      async: options.async ?? true,
    }, options.signal);
  }

  async recall(scope: BankScope, query: string, options: { budget?: HindsightBudget; maxTokens?: number; signal?: AbortSignal } = {}): Promise<RecallResponse> {
    return this.request("POST", `/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories/recall`, {
      query,
      budget: options.budget || "mid",
      max_tokens: options.maxTokens,
      tags: scope.tags,
      tags_match: scope.tagsMatch,
    }, options.signal) as Promise<RecallResponse>;
  }

  async reflect(scope: BankScope, query: string, options: { context?: string; budget?: HindsightBudget; signal?: AbortSignal } = {}): Promise<ReflectResponse> {
    return this.request("POST", `/v1/default/banks/${encodeURIComponent(scope.bankId)}/reflect`, {
      query,
      context: options.context,
      budget: options.budget || "low",
      tags: scope.tags,
      tags_match: scope.tagsMatch,
    }, options.signal) as Promise<ReflectResponse>;
  }

  async clearMemories(scope: BankScope, signal?: AbortSignal): Promise<unknown> {
    return this.request("DELETE", `/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories`, undefined, signal);
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal, retry = true): Promise<unknown> {
    const url = `${this.config.apiUrl.replace(/\/$/, "")}${path}`;
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const requestSignal = signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);
    try {
      const response = await this.fetchImpl(url, {
        method,
        signal: requestSignal,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Hindsight ${method} ${path} failed (${response.status}): ${text}`);
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (error) {
      if (retry && this.config.autoStartDaemon && this.config.apiUrl.includes("127.0.0.1")) {
        await runHindsightEmbed(["daemon", "start"], 60_000).catch(() => undefined);
        return this.request(method, path, body, signal, false);
      }
      throw error;
    }
  }
}
