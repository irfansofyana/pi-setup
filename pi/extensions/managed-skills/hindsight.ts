import { createHash } from "node:crypto";
import { basename, resolve, sep } from "node:path";

import { DEFAULT_MAX_LEARN_MEMORY_CHARS, HINDSIGHT_CONFIG_PATH } from "./config.ts";
import { readRegularFileSync } from "./filesystem.ts";
import type { BankScope, HindsightRetainConfig, HindsightScoping } from "./types.ts";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b\s*[:=]\s*["']?[^"'\s]{4,}/gi,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xoxb-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result;
}

export function sanitizeLearnText(text: string, maxChars = DEFAULT_MAX_LEARN_MEMORY_CHARS): string {
  const sanitized = redactSecrets(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) throw new Error("Lesson was empty after sanitization; nothing stored.");
  if (sanitized.length > maxChars) throw new Error(`Lesson is ${sanitized.length} chars; the limit is ${maxChars}. Trim the memory.`);
  return sanitized;
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readRegularFileSync(path, { label: "Hindsight config", maxBytes: 1_000_000 }));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringValue(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
  }
  return undefined;
}

function enumValue<T extends string>(allowed: readonly T[], ...values: unknown[]): T | undefined {
  for (const value of values) {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  }
  return undefined;
}

export function readHindsightRetainConfig(env: NodeJS.ProcessEnv = process.env): HindsightRetainConfig {
  const fileConfig = readJsonObject(env.HINDSIGHT_CONFIG_PATH || HINDSIGHT_CONFIG_PATH);
  return {
    apiUrl: stringValue(env.HINDSIGHT_API_URL, fileConfig.apiUrl, "http://127.0.0.1:8888"),
    apiToken: stringValue(env.HINDSIGHT_API_TOKEN, env.HINDSIGHT_API_KEY) || undefined,
    bankId: stringValue(env.HINDSIGHT_BANK_ID, fileConfig.bankId, "coding-agent"),
    scoping: enumValue<HindsightScoping>(
      ["global", "per-project", "per-project-tagged"],
      env.HINDSIGHT_SCOPING,
      fileConfig.scoping,
    ) ?? "per-project-tagged",
    requestTimeoutMs: numberValue(env.HINDSIGHT_REQUEST_TIMEOUT_MS, fileConfig.requestTimeoutMs) ?? 30_000,
  };
}

function projectBasename(cwd: string): string {
  const name = basename(resolve(cwd));
  if (!name || name === "." || name === ".." || name.includes(sep) || name.includes("/")) return "root";
  return name;
}

export function projectKey(cwd: string): string {
  const resolved = resolve(cwd);
  const base = projectBasename(cwd).replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeBase = !base || base === "." || base === ".." ? "root" : base;
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${safeBase}-${hash}`;
}

function safeBankPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function projectTag(cwd: string): string {
  return `project:${projectKey(cwd)}`;
}

export function computeHindsightScope(
  config: Pick<HindsightRetainConfig, "bankId" | "scoping">,
  cwd: string,
): BankScope {
  if (config.scoping === "global") return { bankId: config.bankId };
  if (config.scoping === "per-project") return { bankId: `${safeBankPart(config.bankId)}-${safeBankPart(projectKey(cwd))}` };
  return { bankId: config.bankId, tags: [projectTag(cwd)], tagsMatch: "any" };
}

export async function retainHindsightLesson(input: {
  cwd: string;
  memory: string;
  context?: string;
  config?: HindsightRetainConfig;
  maxMemoryChars?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ bankId: string; tags?: string[] }> {
  const config = input.config ?? readHindsightRetainConfig();
  const scope = computeHindsightScope(config, input.cwd);
  const memory = sanitizeLearnText(input.memory, input.maxMemoryChars ?? DEFAULT_MAX_LEARN_MEMORY_CHARS);
  const context = input.context ? sanitizeLearnText(input.context, input.maxMemoryChars ?? DEFAULT_MAX_LEARN_MEMORY_CHARS) : undefined;
  const timeoutSignal = config.requestTimeoutMs > 0 ? AbortSignal.timeout(config.requestTimeoutMs) : undefined;
  const signal = input.signal && timeoutSignal ? AbortSignal.any([input.signal, timeoutSignal]) : (input.signal ?? timeoutSignal);
  const response = await (input.fetchImpl ?? fetch)(
    `${config.apiUrl.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories`,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
      },
      body: JSON.stringify({
        items: [{
          content: memory,
          context,
          tags: scope.tags,
          metadata: { source: "managed-skills-learn", cwd: resolve(input.cwd), tool: "learn" },
        }],
        async: true,
      }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Hindsight retain failed (${response.status}): ${text}`);
  return { bankId: scope.bankId, tags: scope.tags };
}
