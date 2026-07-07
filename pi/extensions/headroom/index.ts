import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type StartupMode = "manual" | "auto" | "off";
export type ProxyOwner = "none" | "managed" | "external";
export type NotifyFailures = "once" | "always" | "never";

export interface HeadroomConfig {
  enabled: boolean;
  startup: StartupMode;
  proxyUrl: string;
  host: string;
  port: number;
  minChars: number;
  compressionTimeoutMs: number;
  fallbackToOriginal: boolean;
  notifyFailures: NotifyFailures;
  allowRemote: boolean;
  storeTtlHours: number;
  storeMaxEntries: number;
  storeMaxBytes: number;
  retrieveMaxBytes: number;
  retrieveContextLines: number;
  excludeTools: string[];
  excludePathPatterns: string[];
}

export interface SessionStats {
  compressions: number;
  bypasses: number;
  failures: number;
  retrievals: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  charsBefore: number;
  charsAfter: number;
}

export interface StoredOriginal {
  hash: string;
  toolName: string;
  createdAt: string;
  expiresAt: string;
  originalContent: string;
  compressedContent?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  tokensSaved?: number;
  transforms?: string[];
  proxyCcrHashes?: string[];
}

interface CompressResult {
  compressedText: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number;
  transforms: string[];
  proxyCcrHashes: string[];
}

const ROOT_DIR = join(homedir(), ".pi", "agent", "headroom");
const CONFIG_PATH = join(ROOT_DIR, "config.json");
const STORE_DIR = join(ROOT_DIR, "store");
const LOG_PATH = join(ROOT_DIR, "headroom-proxy.log");
const PID_PATH = join(ROOT_DIR, "headroom-proxy.pid");
const STATUS_ID = "headroom";

export const DEFAULT_CONFIG: HeadroomConfig = {
  enabled: true,
  startup: "manual",
  proxyUrl: "http://127.0.0.1:8787",
  host: "127.0.0.1",
  port: 8787,
  minChars: 500,
  compressionTimeoutMs: 10_000,
  fallbackToOriginal: true,
  notifyFailures: "once",
  allowRemote: false,
  storeTtlHours: 24,
  storeMaxEntries: 500,
  storeMaxBytes: 100 * 1024 * 1024,
  retrieveMaxBytes: 50 * 1024,
  retrieveContextLines: 5,
  excludeTools: ["edit", "write", "ask_user_question", "todo", "preview_export", "headroom_retrieve", "headroom_stats"],
  excludePathPatterns: [".env", ".env.", "secret", "credential", "token", "private_key", "id_rsa", "id_ed25519"],
};

const OPTIONAL_SCHEMA = Symbol("optional-schema");
type JsonSchema = Record<string, unknown> & { [OPTIONAL_SCHEMA]?: true };
const Schema = {
  Object(properties: Record<string, JsonSchema>): JsonSchema {
    const required = Object.entries(properties)
      .filter(([, schema]) => !schema[OPTIONAL_SCHEMA])
      .map(([name]) => name);
    const cleanProperties = Object.fromEntries(
      Object.entries(properties).map(([name, schema]) => {
        const { [OPTIONAL_SCHEMA]: _optional, ...cleanSchema } = schema;
        return [name, cleanSchema];
      }),
    );
    return { type: "object", ...(required.length ? { required } : {}), properties: cleanProperties };
  },
  String(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "string", ...options };
  },
  Optional(schema: JsonSchema): JsonSchema {
    return { ...schema, [OPTIONAL_SCHEMA]: true };
  },
};

function ensureDirs(): void {
  mkdirSync(ROOT_DIR, { recursive: true });
  mkdirSync(STORE_DIR, { recursive: true });
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function stringFrom(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArrayFrom(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function startupFrom(value: unknown, fallback: StartupMode): StartupMode {
  return value === "manual" || value === "auto" || value === "off" ? value : fallback;
}

function notifyFailuresFrom(value: unknown, fallback: NotifyFailures): NotifyFailures {
  return value === "once" || value === "always" || value === "never" ? value : fallback;
}

export function hasSupportedProxyProtocol(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function parseLocalProxyUrl(rawUrl: string): URL | undefined {
  try {
    const url = new URL(rawUrl);
    if (hasSupportedProxyProtocol(rawUrl) && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return url;
  } catch {}
  return undefined;
}

function hostFromProxyUrl(url: URL): string {
  return url.hostname === "[::1]" ? "::1" : url.hostname;
}

function portFromProxyUrl(url: URL): number | undefined {
  if (url.port) return Number(url.port);
  if (url.protocol === "http:") return 80;
  if (url.protocol === "https:") return 443;
  return undefined;
}

export function normalizeHeadroomConfig(raw: unknown): HeadroomConfig {
  const input = raw && typeof raw === "object" ? (raw as Partial<HeadroomConfig>) : {};
  const explicitHost = typeof input.host === "string" && input.host.trim() ? input.host.trim() : undefined;
  const explicitPort = typeof input.port === "number" && Number.isFinite(input.port)
    ? clampNumber(input.port, DEFAULT_CONFIG.port, 1, 65_535)
    : undefined;
  const rawProxyUrl = stringFrom(input.proxyUrl, "");
  const localProxyUrl = rawProxyUrl ? parseLocalProxyUrl(rawProxyUrl) : undefined;
  const host = explicitHost ?? (localProxyUrl ? hostFromProxyUrl(localProxyUrl) : DEFAULT_CONFIG.host);
  const port = explicitPort ?? (localProxyUrl ? portFromProxyUrl(localProxyUrl) ?? DEFAULT_CONFIG.port : DEFAULT_CONFIG.port);
  const proxyUrl = rawProxyUrl || `http://${host}:${port}`;
  return {
    enabled: input.enabled !== false,
    startup: startupFrom(input.startup, DEFAULT_CONFIG.startup),
    proxyUrl,
    host,
    port,
    minChars: clampNumber(input.minChars, DEFAULT_CONFIG.minChars, 1, 1_000_000),
    compressionTimeoutMs: clampNumber(input.compressionTimeoutMs, DEFAULT_CONFIG.compressionTimeoutMs, 500, 120_000),
    fallbackToOriginal: input.fallbackToOriginal !== false,
    notifyFailures: notifyFailuresFrom(input.notifyFailures, DEFAULT_CONFIG.notifyFailures),
    allowRemote: input.allowRemote === true,
    storeTtlHours: clampNumber(input.storeTtlHours, DEFAULT_CONFIG.storeTtlHours, 1, 24 * 30),
    storeMaxEntries: clampNumber(input.storeMaxEntries, DEFAULT_CONFIG.storeMaxEntries, 1, 100_000),
    storeMaxBytes: clampNumber(input.storeMaxBytes, DEFAULT_CONFIG.storeMaxBytes, 1024, 10 * 1024 * 1024 * 1024),
    retrieveMaxBytes: clampNumber(input.retrieveMaxBytes, DEFAULT_CONFIG.retrieveMaxBytes, 1024, 10 * 1024 * 1024),
    retrieveContextLines: clampNumber(input.retrieveContextLines, DEFAULT_CONFIG.retrieveContextLines, 0, 100),
    excludeTools: stringArrayFrom(input.excludeTools, DEFAULT_CONFIG.excludeTools),
    excludePathPatterns: stringArrayFrom(input.excludePathPatterns, DEFAULT_CONFIG.excludePathPatterns),
  };
}

function readConfig(): HeadroomConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    return normalizeHeadroomConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfig(config: HeadroomConfig): void {
  ensureDirs();
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function initialStats(): SessionStats {
  return {
    compressions: 0,
    bypasses: 0,
    failures: 0,
    retrievals: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    charsBefore: 0,
    charsAfter: 0,
  };
}

export function formatCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function savingsPercent(stats: SessionStats): number {
  if (stats.tokensBefore > 0) return Math.round((stats.tokensSaved / stats.tokensBefore) * 100);
  if (stats.charsBefore > 0) return Math.round(((stats.charsBefore - stats.charsAfter) / stats.charsBefore) * 100);
  return 0;
}

export function statusText(enabled: boolean, owner: ProxyOwner, stats: SessionStats): string {
  if (!enabled) return "headroom off";
  const ownerText = owner === "managed" ? "managed" : owner === "external" ? "external" : "proxy?";
  return `headroom ${ownerText} · saved ${formatCount(stats.tokensSaved)} tok · ${savingsPercent(stats)}% ↓`;
}

function updateStatus(ctx: ExtensionContext, enabled: boolean, owner: ProxyOwner, stats: SessionStats): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_ID, statusText(enabled, owner, stats));
}

export function textFromContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("\n");
}

export function contentWithText(content: Array<{ type: string; text?: string; [key: string]: unknown }>, text: string) {
  const firstTextIndex = content.findIndex((item) => item.type === "text");
  if (firstTextIndex === -1) return [{ type: "text", text }];
  return content.flatMap((item, index) => {
    if (index === firstTextIndex) return [{ ...item, text }];
    if (item.type === "text") return [];
    return [item];
  });
}

export function hasExcludedTool(toolName: string, config: HeadroomConfig): boolean {
  return config.excludeTools.some((name) => name === toolName);
}

export function argsLookSensitive(input: unknown, patterns = DEFAULT_CONFIG.excludePathPatterns): boolean {
  const text = JSON.stringify(input ?? {}).toLowerCase();
  return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
}

export function outputLooksSensitive(text: string): boolean {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]+\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"'\s]{8,}/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function shouldCompressToolResult(toolName: string, input: unknown, text: string, config: HeadroomConfig): boolean {
  if (!config.enabled || config.startup === "off") return false;
  if (hasExcludedTool(toolName, config)) return false;
  if (text.length < config.minChars) return false;
  if (argsLookSensitive(input, config.excludePathPatterns)) return false;
  if (outputLooksSensitive(text)) return false;
  return true;
}

class HttpStatusError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new HttpStatusError(response.status);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function statusReady(status: string): boolean | undefined {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["healthy", "ready", "ok", "up"].includes(normalized)) return true;
  if (["unhealthy", "not_ready", "starting", "initializing", "down", "error"].includes(normalized)) return false;
  return undefined;
}

export function headroomReadyFromPayload(payload: unknown): boolean | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.ready === "boolean") return payload.ready;
  if (typeof payload.status === "string") {
    const ready = statusReady(payload.status);
    if (ready !== undefined) return ready;
  }
  if (isRecord(payload.checks)) {
    const checkReadiness = Object.values(payload.checks)
      .map((check) => isRecord(check) && typeof check.ready === "boolean" ? check.ready : undefined)
      .filter((ready): ready is boolean => typeof ready === "boolean");
    if (checkReadiness.length > 0) return checkReadiness.every(Boolean);
  }
  return undefined;
}

async function endpointReady(url: string, timeoutMs: number): Promise<boolean> {
  const payload = await fetchJson(url, { method: "GET" }, timeoutMs);
  return headroomReadyFromPayload(payload) ?? true;
}

export function isLocalProxyUrl(rawUrl: string): boolean {
  return parseLocalProxyUrl(rawUrl) !== undefined;
}

export function initialRuntimeEnabled(config: Pick<HeadroomConfig, "enabled" | "startup">): boolean {
  return config.enabled && config.startup === "auto";
}

export function isRemoteBlocked(config: Pick<HeadroomConfig, "proxyUrl" | "allowRemote">): boolean {
  return !config.allowRemote && !isLocalProxyUrl(config.proxyUrl);
}

export function enableRuntimeDecision(
  config: Pick<HeadroomConfig, "startup">,
  proxyHealthy: boolean,
  owner: ProxyOwner,
  managedProcessRunning = false,
): { runtimeEnabled: boolean; owner: ProxyOwner; reason?: "startup-off" | "proxy-unavailable" } {
  if (config.startup === "off") return { runtimeEnabled: false, owner, reason: "startup-off" };
  if (!proxyHealthy) return { runtimeEnabled: false, owner: managedProcessRunning ? "managed" : "none", reason: "proxy-unavailable" };
  return { runtimeEnabled: true, owner: owner === "none" ? (managedProcessRunning ? "managed" : "external") : owner };
}

export function canStartRuntime(config: Pick<HeadroomConfig, "startup">): boolean {
  return config.startup !== "off";
}

export async function health(config: HeadroomConfig): Promise<boolean> {
  if (!hasSupportedProxyProtocol(config.proxyUrl) || isRemoteBlocked(config)) return false;
  try {
    return await endpointReady(`${config.proxyUrl}/readyz`, 2_000);
  } catch (error) {
    if (!(error instanceof HttpStatusError) || (error.status !== 404 && error.status !== 405)) return false;
  }

  try {
    return await endpointReady(`${config.proxyUrl}/health`, 2_000);
  } catch {
    return false;
  }
}

function modelId(ctx: ExtensionContext): string {
  return ctx.model?.id ?? "gpt-4o";
}

export function buildCompressRequest(text: string, toolName: string, model: string) {
  const prefix = `Tool output from ${toolName}:\n\n`;
  return {
    model,
    protect_recent: 0,
    messages: [
      { role: "tool", tool_call_id: "call_headroom_tool_output", content: `${prefix}${text}` },
    ],
  };
}

async function compressViaProxy(text: string, toolName: string, ctx: ExtensionContext, config: HeadroomConfig): Promise<CompressResult> {
  if (!hasSupportedProxyProtocol(config.proxyUrl)) throw new Error("Headroom proxyUrl must use http or https.");
  if (isRemoteBlocked(config)) throw new Error("Headroom remote proxy blocked by allowRemote=false.");
  const body = buildCompressRequest(text, toolName, modelId(ctx));
  const json = (await fetchJson(
    `${config.proxyUrl}/v1/compress`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    config.compressionTimeoutMs,
  )) as Record<string, unknown>;

  const messages = Array.isArray(json.messages) ? (json.messages as Array<Record<string, unknown>>) : [];
  if (messages.length !== 1) throw new Error("Headroom changed message count; refusing compressed output.");
  const first = messages[0] ?? {};
  if (first.role !== "tool" || first.tool_call_id !== "call_headroom_tool_output") {
    throw new Error("Headroom changed tool message identity; refusing compressed output.");
  }
  const content = typeof first.content === "string" ? first.content : text;
  const prefix = `Tool output from ${toolName}:\n\n`;
  const compressedText = content.startsWith(prefix) ? content.slice(prefix.length) : content;

  return {
    compressedText,
    tokensBefore: typeof json.tokens_before === "number" ? json.tokens_before : 0,
    tokensAfter: typeof json.tokens_after === "number" ? json.tokens_after : 0,
    tokensSaved: typeof json.tokens_saved === "number" ? json.tokens_saved : 0,
    compressionRatio: typeof json.compression_ratio === "number" ? json.compression_ratio : 1,
    transforms: Array.isArray(json.transforms_applied) ? json.transforms_applied.filter((x): x is string => typeof x === "string") : [],
    proxyCcrHashes: Array.isArray(json.ccr_hashes) ? json.ccr_hashes.filter((x): x is string => typeof x === "string") : [],
  };
}

function makeHash(): string {
  return `hr_${randomUUID()}`;
}

function storePath(hash: string): string {
  return join(STORE_DIR, `${basename(hash)}.json`);
}

export function storedOriginalBytes(entry: StoredOriginal): number {
  return Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
}

export function canRetainOriginal(entry: StoredOriginal, config: Pick<HeadroomConfig, "storeMaxBytes" | "storeMaxEntries">): boolean {
  return config.storeMaxEntries > 0 && storedOriginalBytes(entry) <= config.storeMaxBytes;
}

function saveOriginal(entry: StoredOriginal): void {
  ensureDirs();
  writeFileSync(storePath(entry.hash), `${JSON.stringify(entry)}\n`, "utf8");
}

function loadOriginal(hash: string): StoredOriginal | undefined {
  const path = storePath(hash);
  if (!existsSync(path)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as StoredOriginal;
    if (Date.parse(entry.expiresAt) < Date.now()) {
      unlinkSync(path);
      return undefined;
    }
    return entry;
  } catch {
    return undefined;
  }
}

function storeFiles(): Array<{ path: string; mtimeMs: number; size: number }> {
  if (!existsSync(STORE_DIR)) return [];
  return readdirSync(STORE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(STORE_DIR, name);
      const stat = statSync(path);
      return { path, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function cleanupStore(config: HeadroomConfig): void {
  ensureDirs();
  const now = Date.now();
  for (const file of storeFiles()) {
    try {
      const entry = JSON.parse(readFileSync(file.path, "utf8")) as StoredOriginal;
      if (Date.parse(entry.expiresAt) < now) unlinkSync(file.path);
    } catch {
      unlinkSync(file.path);
    }
  }

  let files = storeFiles();
  while (files.length > config.storeMaxEntries) {
    const file = files.shift();
    if (file) unlinkSync(file.path);
  }

  let total = files.reduce((sum, file) => sum + file.size, 0);
  while (total > config.storeMaxBytes && files.length) {
    const file = files.shift()!;
    unlinkSync(file.path);
    total -= file.size;
  }
}

export function truncateText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n\n[Headroom: retrieval truncated to ${formatCount(maxBytes)} bytes.]`;
}

export function retrieveWithQuery(content: string, query: string | undefined, contextLines: number, maxBytes: number): string {
  const trimmed = query?.trim();
  if (!trimmed) return truncateText(content, maxBytes);

  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const lines = content.split("\n");
  const matches = new Set<number>();
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (terms.some((term) => lower.includes(term))) {
      for (let i = Math.max(0, index - contextLines); i <= Math.min(lines.length - 1, index + contextLines); i++) matches.add(i);
    }
  });

  if (matches.size > 0) {
    const selected = [...matches].sort((a, b) => a - b).map((index) => `${index + 1}: ${lines[index]}`).join("\n");
    return truncateText(`[Headroom: query matches for "${trimmed}"]\n${selected}`, maxBytes);
  }

  const lower = content.toLowerCase();
  const firstTerm = terms[0] ?? "";
  const idx = firstTerm ? lower.indexOf(firstTerm) : -1;
  if (idx >= 0) {
    const start = Math.max(0, idx - Math.floor(maxBytes / 2));
    const end = Math.min(content.length, idx + Math.floor(maxBytes / 2));
    return truncateText(`[Headroom: substring match for "${trimmed}"]\n${content.slice(start, end)}`, maxBytes);
  }

  return `[Headroom: no matches for "${trimmed}" in stored original ${formatCount(content.length)} chars.]`;
}

export function buildMarker(hash: string, result: CompressResult): string {
  const saved = result.tokensSaved > 0 ? `${formatCount(result.tokensSaved)} tokens` : `${formatCount(Math.max(0, result.compressedText.length))} chars`;
  const pct = result.tokensBefore > 0 ? Math.round((result.tokensSaved / result.tokensBefore) * 100) : Math.round((1 - result.compressionRatio) * 100);
  const transforms = result.transforms.length ? ` Transforms: ${result.transforms.join(", ")}.` : "";
  return `[Headroom: compressed tool output. Saved ${saved}${pct > 0 ? ` (${pct}%)` : ""}.${transforms} Original available via headroom_retrieve hash="${hash}"; pass query for focused retrieval.]`;
}

function appendMarker(text: string, marker: string): string {
  return `${text.trimEnd()}\n\n${marker}`;
}

export function headroomFailureText(config: Pick<HeadroomConfig, "fallbackToOriginal">, reason: string): string | undefined {
  if (config.fallbackToOriginal) return undefined;
  return `[Headroom: ${reason} Original tool output suppressed because fallbackToOriginal=false.]`;
}

function headroomFailureResult(
  event: { content: Array<{ type: string; text?: string; [key: string]: unknown }>; details?: unknown },
  config: Pick<HeadroomConfig, "fallbackToOriginal">,
  reason: string,
) {
  const text = headroomFailureText(config, reason);
  if (!text) return undefined;
  return {
    content: contentWithText(event.content, text),
    details: {
      ...(event.details && typeof event.details === "object" ? event.details : {}),
      headroom: { failed: true, reason, originalSuppressed: true },
    },
  };
}

function commandAvailable(): boolean {
  try {
    execFileSync("headroom", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function commandVersion(): string | undefined {
  try {
    return execFileSync("headroom", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function readLogTail(lines = 80): string {
  if (!existsSync(LOG_PATH)) return "No Headroom proxy log yet.";
  const content = readFileSync(LOG_PATH, "utf8");
  return content.split("\n").slice(-lines).join("\n").trim() || "Headroom proxy log empty.";
}

function clearLog(): void {
  ensureDirs();
  writeFileSync(LOG_PATH, "", "utf8");
}

export default function headroom(pi: ExtensionAPI) {
  ensureDirs();
  let config = readConfig();
  let runtimeEnabled = initialRuntimeEnabled(config);
  let owner: ProxyOwner = "none";
  let managedProcess: ChildProcess | undefined;
  let logStream: ReturnType<typeof createWriteStream> | undefined;
  let failureNotified = false;
  const stats = initialStats();

  const notifyFailure = (ctx: ExtensionContext, message: string): void => {
    stats.failures++;
    if (!ctx.hasUI || config.notifyFailures === "never") return;
    if (config.notifyFailures === "once" && failureNotified) return;
    failureNotified = true;
    ctx.ui.notify(message, "warning");
  };

  const startManagedProxy = async (ctx: ExtensionContext): Promise<void> => {
    ensureDirs();
    if (!canStartRuntime(config)) {
      runtimeEnabled = false;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify("Headroom startup is off. Change config startup before starting compression.", "warning");
      return;
    }
    if (!hasSupportedProxyProtocol(config.proxyUrl)) {
      owner = "none";
      runtimeEnabled = false;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify(`Headroom proxyUrl must use http or https: ${config.proxyUrl}.`, "warning");
      return;
    }
    if (isRemoteBlocked(config)) {
      owner = "none";
      runtimeEnabled = false;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify(`Headroom remote proxy blocked: ${config.proxyUrl}. Set allowRemote=true only for a trusted proxy.`, "warning");
      return;
    }
    if (await health(config)) {
      owner = managedProcess ? "managed" : "external";
      runtimeEnabled = config.enabled;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify(`Headroom proxy already running (${owner}).`, "info");
      return;
    }
    if (!isLocalProxyUrl(config.proxyUrl)) {
      runtimeEnabled = false;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify(`Headroom remote proxy unavailable: ${config.proxyUrl}.`, "warning");
      return;
    }

    if (!commandAvailable()) {
      owner = "none";
      runtimeEnabled = false;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify('Headroom CLI missing. Run /headroom doctor for install commands.', "error");
      return;
    }

    const log = logStream = createWriteStream(LOG_PATH, { flags: "a" });
    managedProcess = spawn("headroom", ["proxy", "--host", config.host, "--port", String(config.port)], {
      env: { ...process.env, HEADROOM_TELEMETRY: "off" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    managedProcess.stdout.pipe(log, { end: false });
    managedProcess.stderr.pipe(log, { end: false });
    managedProcess.on("exit", () => {
      if (owner === "managed") {
        try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
      }
      managedProcess = undefined;
      owner = owner === "managed" ? "none" : owner;
    });
    if (managedProcess.pid) writeFileSync(PID_PATH, `${managedProcess.pid}\n`, "utf8");

    for (let i = 0; i < 30; i++) {
      if (await health(config)) {
        owner = "managed";
        runtimeEnabled = config.enabled;
        updateStatus(ctx, runtimeEnabled, owner, stats);
        if (ctx.hasUI) ctx.ui.notify("Headroom proxy started.", "info");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (managedProcess) {
      managedProcess.kill("SIGTERM");
      managedProcess = undefined;
    }
    owner = "none";
    runtimeEnabled = false;
    try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
    if (logStream) { try { logStream.end(); } catch {} logStream = undefined; }
    updateStatus(ctx, runtimeEnabled, owner, stats);
    notifyFailure(ctx, "Headroom proxy did not become healthy; bypassing compression.");
  };

  const stopManagedProxy = (ctx: ExtensionContext): void => {
    runtimeEnabled = false;
    if (managedProcess) {
      managedProcess.kill("SIGTERM");
      managedProcess = undefined;
      owner = "none";
      try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
      if (logStream) { try { logStream.end(); } catch {} logStream = undefined; }
      if (ctx.hasUI) ctx.ui.notify("Headroom managed proxy stopped. Compression disabled.", "info");
    } else {
      const wasExternal = owner === "external";
      owner = wasExternal ? "external" : "none";
      if (ctx.hasUI) ctx.ui.notify(wasExternal ? "Compression disabled. External proxy left running." : "Compression disabled.", "info");
    }
    updateStatus(ctx, runtimeEnabled, owner, stats);
  };

  const statsSummary = (): string => [
    `enabled: ${runtimeEnabled}`,
    `proxyOwner: ${owner}`,
    `proxyUrl: ${config.proxyUrl}`,
    `allowRemote: ${config.allowRemote}`,
    `remoteBlocked: ${isRemoteBlocked(config)}`,
    `compressions: ${stats.compressions}`,
    `bypasses: ${stats.bypasses}`,
    `failures: ${stats.failures}`,
    `retrievals: ${stats.retrievals}`,
    `tokensSaved: ${stats.tokensSaved}`,
    `savingsPercent: ${savingsPercent(stats)}%`,
  ].join("\n");

  pi.on("session_start", async (_event, ctx) => {
    cleanupStore(config);
    if (config.startup === "auto") await startManagedProxy(ctx);
    else updateStatus(ctx, runtimeEnabled, owner, stats);
  });

  pi.on("session_shutdown", async () => {
    if (managedProcess) {
      managedProcess.kill("SIGTERM");
      managedProcess = undefined;
    }
    if (logStream) { try { logStream.end(); } catch {} logStream = undefined; }
  });

  pi.on("tool_result", async (event, ctx) => {
    updateStatus(ctx, runtimeEnabled, owner, stats);
    const runConfig = config;
    if (!runtimeEnabled) return;

    const text = textFromContent(event.content as Array<{ type: string; text?: string }>);
    if (!shouldCompressToolResult(event.toolName, event.input, text, runConfig)) {
      stats.bypasses++;
      return;
    }

    if (!(await health(runConfig))) {
      notifyFailure(ctx, "Headroom proxy unavailable; bypassing compression.");
      return headroomFailureResult(event as any, runConfig, "proxy unavailable.");
    }
    if (owner === "none") owner = "external";

    let result: CompressResult;
    try {
      result = await compressViaProxy(text, event.toolName, ctx, runConfig);
    } catch (error) {
      notifyFailure(ctx, `Headroom compression failed; bypassing compression. ${error instanceof Error ? error.message : ""}`.trim());
      return headroomFailureResult(event as any, runConfig, "compression failed.");
    }

    if (!result.compressedText || result.compressedText.trim() === text.trim() || (result.tokensSaved <= 0 && result.compressedText.length >= text.length)) {
      stats.bypasses++;
      return;
    }

    try {
      // ponytail: store failure returns original unless fallbackToOriginal=false suppresses it
      const hash = makeHash();
      const now = new Date();
      const expires = new Date(now.getTime() + runConfig.storeTtlHours * 60 * 60 * 1000);
      const entry: StoredOriginal = {
        hash,
        toolName: event.toolName,
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
        originalContent: text,
        compressedContent: result.compressedText,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        tokensSaved: result.tokensSaved,
        transforms: result.transforms,
        proxyCcrHashes: result.proxyCcrHashes,
      };
      if (!canRetainOriginal(entry, runConfig)) throw new Error("stored original exceeds retention limits");
      saveOriginal(entry);
      cleanupStore(runConfig);
      if (!loadOriginal(hash)) throw new Error("stored original was removed by retention limits");

      stats.compressions++;
      stats.tokensBefore += result.tokensBefore;
      stats.tokensAfter += result.tokensAfter;
      stats.tokensSaved += result.tokensSaved;
      stats.charsBefore += text.length;
      stats.charsAfter += result.compressedText.length;
      updateStatus(ctx, runtimeEnabled, owner, stats);

      return {
        content: contentWithText(event.content as Array<{ type: string; text?: string; [key: string]: unknown }>, appendMarker(result.compressedText, buildMarker(hash, result))),
        details: {
          ...(event.details && typeof event.details === "object" ? event.details : {}),
          headroom: {
            hash,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            tokensSaved: result.tokensSaved,
            compressionRatio: result.compressionRatio,
            transforms: result.transforms,
            proxyCcrHashes: result.proxyCcrHashes,
          },
        },
      };
    } catch (error) {
      notifyFailure(ctx, `Headroom post-compress store failed; bypassing compression. ${error instanceof Error ? error.message : ""}`.trim());
      stats.bypasses++;
      return headroomFailureResult(event as any, runConfig, "local store failed.");
    }
  });

  pi.registerTool({
    name: "headroom_retrieve",
    label: "Headroom Retrieve",
    description: "Retrieve original local Pi tool output compressed by Headroom.",
    promptSnippet: "Retrieve original Headroom-compressed tool output by hash, optionally filtered by query.",
    promptGuidelines: [
      "Use headroom_retrieve when a Headroom marker says original output is needed; pass query for focused retrieval when possible.",
    ],
    parameters: Schema.Object({
      hash: Schema.String({ description: "Headroom local hash from compressed output marker, e.g. hr_..." }),
      query: Schema.Optional(Schema.String({ description: "Optional search query to retrieve focused lines/chunks." })),
    }),
    async execute(_toolCallId, params) {
      const entry = loadOriginal((params as { hash: string }).hash);
      if (!entry) throw new Error("Headroom original not found or expired.");
      stats.retrievals++;
      const query = (params as { query?: string }).query;
      const text = retrieveWithQuery(entry.originalContent, query, config.retrieveContextLines, config.retrieveMaxBytes);
      return {
        content: [{ type: "text", text }],
        details: { hash: entry.hash, toolName: entry.toolName, createdAt: entry.createdAt, expiresAt: entry.expiresAt, query },
      };
    },
  });

  pi.registerTool({
    name: "headroom_stats",
    label: "Headroom Stats",
    description: "Show Pi Headroom adapter session stats.",
    promptSnippet: "Inspect Headroom compression savings and local retrieval stats.",
    parameters: Schema.Object({}),
    async execute() {
      return { content: [{ type: "text", text: statsSummary() }], details: { ...stats, enabled: runtimeEnabled, proxyOwner: owner } };
    },
  });

  pi.registerCommand("headroom", {
    description: "Manage local Headroom proxy and Pi compression adapter",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [command = "status", ...rest] = trimmed.split(/\s+/);
      const value = rest.join(" ").trim();

      if (command === "start") {
        await startManagedProxy(ctx);
        return;
      }
      if (command === "stop") {
        stopManagedProxy(ctx);
        return;
      }
      if (command === "restart") {
        stopManagedProxy(ctx);
        await startManagedProxy(ctx);
        return;
      }
      if (command === "enable") {
        const proxyUrlSupported = hasSupportedProxyProtocol(config.proxyUrl);
        const decision = enableRuntimeDecision(config, config.startup !== "off" && proxyUrlSupported && await health(config), owner, managedProcess !== undefined);
        runtimeEnabled = decision.runtimeEnabled;
        owner = decision.owner;
        updateStatus(ctx, runtimeEnabled, owner, stats);
        if (decision.reason === "startup-off") {
          ctx.ui.notify("Headroom startup is off. Change config startup before enabling compression.", "warning");
          return;
        }
        if (decision.reason === "proxy-unavailable") {
          ctx.ui.notify(
            proxyUrlSupported
              ? `Headroom proxy unavailable at ${config.proxyUrl}. Run /headroom start or start proxy before /headroom enable.`
              : `Headroom proxyUrl must use http or https: ${config.proxyUrl}.`,
            "warning",
          );
          return;
        }
        config = { ...config, enabled: true };
        ctx.ui.notify("Headroom compression enabled for this session.", "info");
        return;
      }
      if (command === "disable") {
        runtimeEnabled = false;
        updateStatus(ctx, runtimeEnabled, owner, stats);
        ctx.ui.notify("Headroom compression disabled for this session.", "info");
        return;
      }
      if (command === "stats" || command === "status") {
        const healthy = await health(config);
        if (healthy && owner === "none") owner = "external";
        updateStatus(ctx, runtimeEnabled, owner, stats);
        ctx.ui.notify(`${statsSummary()}\nproxyHealthy: ${healthy}`, healthy ? "info" : "warning");
        return;
      }
      if (command === "doctor") {
        const version = commandVersion();
        const healthy = await health(config);
        const text = [
          `headroomCli: ${version ?? "missing"}`,
          `proxyHealthy: ${healthy}`,
          `proxyUrl: ${config.proxyUrl}`,
          `remoteBlocked: ${isRemoteBlocked(config)}`,
          "",
          "Install commands if missing:",
          'pipx install "headroom-ai[proxy]"',
          '# or',
          'uv tool install "headroom-ai[proxy]"',
        ].join("\n");
        ctx.ui.notify(text, version && healthy ? "info" : "warning");
        return;
      }
      if (command === "logs") {
        if (value === "clear") {
          clearLog();
          ctx.ui.notify("Headroom proxy log cleared.", "info");
          return;
        }
        ctx.ui.notify(readLogTail(), "info");
        return;
      }
      if (command === "cleanup") {
        cleanupStore(config);
        ctx.ui.notify("Headroom local store cleaned.", "info");
        return;
      }
      if (command === "config") {
        if (value === "show") {
          ctx.ui.notify(JSON.stringify(config, null, 2), "info");
          return;
        }
        if (value === "save") {
          writeConfig({ ...config, enabled: runtimeEnabled });
          ctx.ui.notify(`Headroom config saved to ${CONFIG_PATH}`, "info");
          return;
        }
        if (value === "reset") {
          config = DEFAULT_CONFIG;
          runtimeEnabled = initialRuntimeEnabled(config);
          updateStatus(ctx, runtimeEnabled, owner, stats);
          ctx.ui.notify("Headroom runtime config reset to defaults. Use /headroom config save to persist.", "info");
          return;
        }
      }

      ctx.ui.notify(
        "Usage: /headroom start|stop|restart|enable|disable|status|stats|doctor|logs [clear]|cleanup|config show|config save|config reset",
        "warning",
      );
    },
  });
}
