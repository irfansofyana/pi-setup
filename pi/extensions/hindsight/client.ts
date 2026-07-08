import { execFile } from "node:child_process";
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

export interface BankScope {
  bankId: string;
  tags?: string[];
  tagsMatch?: "any" | "all" | "any_strict" | "all_strict" | "exact";
}

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

export function defaultHindsightConfig(env: NodeJS.ProcessEnv = process.env): HindsightConfig {
  return {
    apiUrl: env.HINDSIGHT_API_URL || "http://127.0.0.1:8888",
    apiToken: env.HINDSIGHT_API_TOKEN || env.HINDSIGHT_API_KEY || undefined,
    bankId: env.HINDSIGHT_BANK_ID || "pi",
    scoping: (env.HINDSIGHT_SCOPING as HindsightScoping) || "per-project-tagged",
    autoRecall: env.HINDSIGHT_AUTO_RECALL !== "false",
    autoRetain: env.HINDSIGHT_AUTO_RETAIN !== "false",
    autoStartDaemon: env.HINDSIGHT_AUTO_START_DAEMON === "true",
    memoryBackend: env.HINDSIGHT_MEMORY_BACKEND !== "false",
    retainMode: env.HINDSIGHT_RETAIN_MODE === "last-turn" ? "last-turn" : "full-session",
    recallBudget: (env.HINDSIGHT_RECALL_BUDGET as HindsightBudget) || "mid",
    recallMaxTokens: Number(env.HINDSIGHT_RECALL_MAX_TOKENS) || 1024,
    requestTimeoutMs: Number(env.HINDSIGHT_REQUEST_TIMEOUT_MS) || 30_000,
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

export function formatRecallResponse(response: RecallResponse): string {
  const results = response.results ?? [];
  if (!results.length) return "";
  const lines = [
    "Relevant memories from past conversations (prioritize recent when conflicting).",
    "Only use memories directly useful for this task; ignore the rest:",
  ];
  for (const result of results) {
    const date = result.mentioned_at || result.occurred_start || "undated";
    const kind = result.type || "memory";
    const text = (result.text || "").trim();
    if (!text) continue;
    lines.push(`- [${kind} @ ${date.slice(0, 10)}] ${text}`);
  }
  return lines.join("\n").slice(0, 6000);
}

export function formatReflectResponse(response: ReflectResponse): string {
  return response.text?.trim() || "No hindsight reflection returned.";
}

export async function runHindsightEmbed(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync("uvx", ["hindsight-embed", ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

export class HindsightHttpClient {
  constructor(private readonly config: Pick<HindsightConfig, "apiUrl" | "apiToken" | "autoStartDaemon"> & Partial<Pick<HindsightConfig, "requestTimeoutMs">>, private readonly fetchImpl: typeof fetch = fetch) {}

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
