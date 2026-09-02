import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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
export type HeadroomFailureKind = "compression" | "lifecycle";

export interface HeadroomConfig {
  enabled: boolean;
  localToolResultCompression: boolean;
  startup: StartupMode;
  proxyUrl: string;
  host: string;
  port: number;
  minChars: number;
  compressionTimeoutMs: number;
  startupHealthTimeoutMs: number;
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

export interface HeadroomRouteModel {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
}

export interface HeadroomProviderRoutePlan {
  providers: Map<string, string>;
  upstreamByModel: Map<string, string>;
}

interface HeadroomProxyRegistration extends HeadroomProviderRoutePlan {
  registeredProviders: string[];
}

interface SharedHeadroomRoutingState {
  runtime: object;
  registration: HeadroomProxyRegistration;
  canonicalModels: HeadroomRouteModel[];
  proxyUrl: string;
  excludedProviderIds: Set<string>;
  references: number;
  generation: number;
  invalidatedReferences: number;
  adoptable: boolean;
  stopping: boolean;
  managedProcess?: ChildProcess;
  releaseManagedProcess?: () => Promise<boolean>;
  unregisterProvider?: (name: string) => void;
}

interface ActiveHeadroomProxyRegistration extends HeadroomProxyRegistration {
  sharedState?: SharedHeadroomRoutingState;
  leaseGeneration?: number;
}

// Subagent extension instances share ModelRuntime with parent, but not extension-local state.
const SHARED_ROUTING_STATE_KEY = Symbol.for("pi-headroom-routing-state");

function sharedRoutingStates(): WeakMap<object, SharedHeadroomRoutingState> {
  const globalState = globalThis as typeof globalThis & Record<symbol, unknown>;
  let states = globalState[SHARED_ROUTING_STATE_KEY] as WeakMap<object, SharedHeadroomRoutingState> | undefined;
  if (!states) {
    states = new WeakMap<object, SharedHeadroomRoutingState>();
    globalState[SHARED_ROUTING_STATE_KEY] = states;
  }
  return states;
}

export interface ProxyHistorySummary {
  lifetime?: Record<string, unknown>;
  displaySession?: Record<string, unknown>;
  historySummary?: Record<string, unknown>;
  error?: string;
}

export interface SessionStats {
  compressions: number;
  proxyRequests: number;
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
const MODELS_CONFIG_PATH = join(homedir(), ".pi", "agent", "models.json");
const STORE_DIR = join(ROOT_DIR, "store");
const LOG_PATH = join(ROOT_DIR, "headroom-proxy.log");
const PID_PATH = join(ROOT_DIR, "headroom-proxy.pid");
const STATUS_ID = "headroom";

export const DEFAULT_CONFIG: HeadroomConfig = {
  enabled: true,
  localToolResultCompression: false,
  startup: "auto",
  proxyUrl: "http://127.0.0.1:8787",
  host: "127.0.0.1",
  port: 8787,
  minChars: 500,
  compressionTimeoutMs: 10_000,
  startupHealthTimeoutMs: 30_000,
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

/** Build a proxy endpoint while keeping a configured base URL's path intact. */
export function proxyEndpoint(rawUrl: string, path: string): string {
  const url = new URL(rawUrl);
  const base = url.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${base}${suffix}` || "/";
  return url.toString().replace(/\/$/, "");
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
    localToolResultCompression: input.localToolResultCompression === true,
    startup: startupFrom(input.startup, DEFAULT_CONFIG.startup),
    proxyUrl,
    host,
    port,
    minChars: clampNumber(input.minChars, DEFAULT_CONFIG.minChars, 1, 1_000_000),
    compressionTimeoutMs: clampNumber(input.compressionTimeoutMs, DEFAULT_CONFIG.compressionTimeoutMs, 500, 120_000),
    startupHealthTimeoutMs: clampNumber(input.startupHealthTimeoutMs, DEFAULT_CONFIG.startupHealthTimeoutMs, 5_000, 120_000),
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
    proxyRequests: 0,
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
  if (!enabled) return "hr off";
  const ownerText = owner === "managed" ? "m" : owner === "external" ? "x" : "?";
  return `hr ${ownerText} ${formatCount(stats.tokensSaved)} ↓${savingsPercent(stats)}%`;
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

function getContextSignal(ctx: ExtensionContext | undefined): AbortSignal | undefined {
  return (ctx as { signal?: AbortSignal } | undefined)?.signal;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const signals = [init.signal, externalSignal].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
  const listeners = signals.map((signal) => {
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return { signal, abort };
  });
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error(`Headroom request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new HttpStatusError(response.status);
    return await response.json();
  } finally {
    clearTimeout(timeout);
    for (const { signal, abort } of listeners) signal.removeEventListener("abort", abort);
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

export function headroomCompressionReadyFromPayload(payload: unknown): boolean | undefined {
  if (!isRecord(payload) || payload.service !== "headroom-proxy") return undefined;
  const aggregateReady = headroomReadyFromPayload(payload);
  if (aggregateReady === true) return true;
  if (!isRecord(payload.checks)) return aggregateReady;

  const checks = payload.checks;
  const startup = checks.startup;
  if (!isRecord(startup) || startup.ready !== true) return aggregateReady;

  for (const [name, check] of Object.entries(checks)) {
    if (name === "upstream") continue;
    if (!isRecord(check)) continue;
    if (check.enabled === false || check.status === "disabled") continue;
    if (typeof check.ready === "boolean" && !check.ready) return aggregateReady;
  }

  return true;
}

export function headroomRoutingReadyFromPayload(payload: unknown): boolean | undefined {
  if (!isRecord(payload) || payload.service !== "headroom-proxy") return undefined;
  if (typeof payload.ready === "boolean") {
    const upstream = isRecord(payload.checks) ? payload.checks.upstream : undefined;
    if (payload.ready && isRecord(upstream) && upstream.ready === false) return false;
    return payload.ready;
  }
  const compressionReady = headroomCompressionReadyFromPayload(payload);
  if (compressionReady !== true || !isRecord(payload.checks)) return false;
  const upstream = payload.checks.upstream;
  return isRecord(upstream) && upstream.ready === true;
}

async function endpointReady(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  readiness: (payload: unknown) => boolean | undefined = headroomCompressionReadyFromPayload,
): Promise<boolean> {
  const payload = await fetchJson(url, { method: "GET" }, timeoutMs, signal);
  return readiness(payload) ?? false;
}

async function proxyHistory(config: HeadroomConfig, signal?: AbortSignal): Promise<ProxyHistorySummary> {
  if (!hasSupportedProxyProtocol(config.proxyUrl)) return { error: `unsupported proxyUrl: ${config.proxyUrl}` };
  if (isRemoteBlocked(config)) return { error: `remote proxy blocked: ${config.proxyUrl}` };
  try {
    const payload = await fetchJson(proxyEndpoint(config.proxyUrl, "/stats-history"), { method: "GET" }, 2_000, signal);
    if (!isRecord(payload)) return { error: "invalid stats-history response" };
    return {
      lifetime: isRecord(payload.lifetime) ? payload.lifetime : undefined,
      displaySession: isRecord(payload.display_session) ? payload.display_session : undefined,
      historySummary: isRecord(payload.history_summary) ? payload.history_summary : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function waitForHealth(
  config: HeadroomConfig,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  const deadline = performance.now() + Math.max(0, timeoutMs);
  while (!signal?.aborted && shouldContinue()) {
    if (performance.now() >= deadline) return false;
    const healthy = await health(config, signal);
    if (healthy) return performance.now() < deadline;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return false;
    const retryDelayMs = Math.min(500, remainingMs);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    // A timeout scheduled for the exact remaining budget can wake fractionally early.
    // Do not start another probe when this sleep was intended to reach the deadline.
    if (retryDelayMs === remainingMs) return false;
  }
  return false;
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

export interface ManagedProxyLifecycleNotice {
  kind: "spawn-error" | "startup-exit" | "startup-timeout" | "unexpected-exit";
  message: string;
}

export function createManagedProxyLifecycle() {
  let ready = false;
  let stopping = false;
  let terminalHandled = false;

  return {
    markReady(): void {
      ready = true;
    },
    markStopping(): void {
      stopping = true;
    },
    markActive(): void {
      stopping = false;
    },
    handleSpawnError(error: unknown): ManagedProxyLifecycleNotice | undefined {
      if (stopping || terminalHandled) return undefined;
      terminalHandled = true;
      const detail = error instanceof Error ? error.message : String(error);
      return {
        kind: "spawn-error",
        message: `Headroom proxy failed to start: ${detail}. Bypassing compression. Run /headroom doctor or check /headroom logs.`,
      };
    },
    handleTimeout(timeoutMs: number): ManagedProxyLifecycleNotice | undefined {
      if (stopping || terminalHandled) return undefined;
      terminalHandled = true;
      return {
        kind: "startup-timeout",
        message: `Headroom proxy did not become healthy within ${timeoutMs}ms; bypassing compression. Check /headroom logs.`,
      };
    },
    handleExit(code: number | null, signal: string | null): ManagedProxyLifecycleNotice | undefined {
      if (stopping || terminalHandled) return undefined;
      terminalHandled = true;
      const detail = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
      if (!ready) {
        return {
          kind: "startup-exit",
          message: `Headroom proxy exited before becoming ready (${detail}); bypassing compression. Check /headroom logs.`,
        };
      }
      return {
        kind: "unexpected-exit",
        message: `Headroom managed proxy exited unexpectedly (${detail}); compression disabled. Check /headroom logs.`,
      };
    },
  };
}

export interface HeadroomStartAttempt {
  isCurrent(): boolean;
}

export function createStartCoordinator<TArgs extends unknown[]>(
  task: (attempt: HeadroomStartAttempt, ...args: TArgs) => Promise<void>,
) {
  let generation = 0;
  let inFlight: Promise<void> | undefined;

  const start = (...args: TArgs): Promise<void> => {
    if (inFlight) return inFlight;
    const ownGeneration = ++generation;
    const attempt: HeadroomStartAttempt = { isCurrent: () => generation === ownGeneration };
    const current = task(attempt, ...args);
    const settled = current.finally(() => {
      if (inFlight === settled) inFlight = undefined;
    });
    inFlight = settled;
    return settled;
  };

  const cancel = (): void => {
    generation++;
  };

  const restart = async (...args: TArgs): Promise<void> => {
    cancel();
    const previous = inFlight;
    if (previous) {
      try { await previous; } catch {}
    }
    return start(...args);
  };

  return { start, cancel, restart, isStarting: () => inFlight !== undefined };
}

function childHasExited(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode != null || child.signalCode != null;
}

export async function terminateChildProcess(child: ChildProcess, graceMs = 1_000): Promise<boolean> {
  if (childHasExited(child)) return true;

  const waitForExit = (): Promise<boolean> => new Promise((resolve) => {
    if (childHasExited(child)) {
      resolve(true);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(childHasExited(child)), Math.max(1, graceMs));
  });

  const signal = (value: NodeJS.Signals): boolean => {
    try { return child.kill(value); } catch { return false; }
  };

  if (signal("SIGTERM") && await waitForExit()) return true;
  if (childHasExited(child)) return true;
  if (!signal("SIGKILL")) return false;
  return waitForExit();
}

export function shouldNotifyHeadroomFailure(
  kind: HeadroomFailureKind,
  hasUI: boolean,
  policy: NotifyFailures,
  alreadyNotified: boolean,
): boolean {
  if (!hasUI) return false;
  if (kind === "lifecycle") return true;
  if (policy === "never") return false;
  return policy === "always" || !alreadyNotified;
}

export async function health(config: HeadroomConfig, signal?: AbortSignal): Promise<boolean> {
  if (!hasSupportedProxyProtocol(config.proxyUrl) || isRemoteBlocked(config)) return false;
  const readiness = config.localToolResultCompression ? headroomCompressionReadyFromPayload : headroomRoutingReadyFromPayload;
  try {
    return await endpointReady(proxyEndpoint(config.proxyUrl, "/readyz"), 2_000, signal, readiness);
  } catch (error) {
    if (!(error instanceof HttpStatusError) || (error.status !== 404 && error.status !== 405)) return false;
  }

  try {
    return await endpointReady(proxyEndpoint(config.proxyUrl, "/health"), 2_000, signal, readiness);
  } catch {
    return false;
  }
}

function modelId(ctx: ExtensionContext): string {
  return ctx.model?.id ?? "gpt-4o";
}

export function proxyProviderBaseUrls(proxyUrl: string): { openai: string; anthropic: string; codex: string } {
  return {
    openai: proxyEndpoint(proxyUrl, "/v1"),
    anthropic: proxyEndpoint(proxyUrl, ""),
    codex: proxyEndpoint(proxyUrl, "/v1"),
  };
}

function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

export function proxyBaseUrlForApi(proxyUrl: string, api: string): string | undefined {
  const baseUrls = proxyProviderBaseUrls(proxyUrl);
  if (api === "openai-completions" || api === "openai-responses") return baseUrls.openai;
  if (api === "openai-codex-responses") return baseUrls.codex;
  if (api === "anthropic-messages") return baseUrls.anthropic;
  return undefined;
}

function normalizedUrl(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, "");
}

export function headroomUpstreamBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function isDefaultBuiltInUpstream(provider: string, rawUrl: string): boolean {
  const url = normalizedUrl(rawUrl);
  if (provider === "openai") return url === "https://api.openai.com/v1";
  if (provider === "anthropic") return url === "https://api.anthropic.com";
  if (provider === "openai-codex") return url === "https://chatgpt.com/backend-api";
  return false;
}

export function planProxyProviderRoutes(proxyUrl: string, models: HeadroomRouteModel[] = []): HeadroomProviderRoutePlan {
  const baseUrls = proxyProviderBaseUrls(proxyUrl);
  const defaultRoutes = new Map<string, string>([
    ["openai", baseUrls.openai],
    ["anthropic", baseUrls.anthropic],
    ["openai-codex", baseUrls.codex],
  ]);
  const providers = new Map(defaultRoutes);
  const modelsByProvider = new Map<string, HeadroomRouteModel[]>();
  for (const model of models) {
    if (!model?.provider || !model?.id) continue;
    const entries = modelsByProvider.get(model.provider) ?? [];
    entries.push(model);
    modelsByProvider.set(model.provider, entries);
  }

  const upstreamByModel = new Map<string, string>();
  for (const [provider, entries] of modelsByProvider) {
    const candidates = entries.map((model) => ({
      model,
      proxyBaseUrl: hasSupportedProxyProtocol(model.baseUrl) ? proxyBaseUrlForApi(proxyUrl, model.api) : undefined,
    }));
    const compatible = candidates.every((entry) => entry.proxyBaseUrl !== undefined);
    const proxyBaseUrls = new Set(candidates.map((entry) => entry.proxyBaseUrl).filter((url): url is string => !!url));
    if (!compatible || proxyBaseUrls.size !== 1) {
      providers.delete(provider);
      continue;
    }

    providers.set(provider, candidates[0]!.proxyBaseUrl!);
    const customProvider = !defaultRoutes.has(provider);
    for (const { model } of candidates) {
      if (customProvider || !isDefaultBuiltInUpstream(provider, model.baseUrl)) {
        upstreamByModel.set(routeKey(provider, model.id), headroomUpstreamBaseUrl(model.baseUrl));
      }
    }
  }

  return { providers, upstreamByModel };
}

function configuredProviderIds(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8")) as { providers?: Record<string, unknown> };
    return new Set(Object.keys(parsed.providers ?? {}));
  } catch {
    return new Set();
  }
}

function runtimeForRouting(ctx: ExtensionContext): object | undefined {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  return runtime !== null && typeof runtime === "object" ? runtime : undefined;
}

function modelRegistryRoutingSnapshot(ctx: ExtensionContext): { models: unknown[]; registeredProviderIds: Set<string> } {
  return {
    models: ctx.modelRegistry.getAvailable(),
    registeredProviderIds: new Set(ctx.modelRegistry.getRegisteredProviderIds()),
  };
}

function sharedRoutingMatches(shared: SharedHeadroomRoutingState, config: HeadroomConfig, models: HeadroomRouteModel[]): boolean {
  if (shared.proxyUrl !== config.proxyUrl) return false;
  const canonicalByKey = new Map(shared.canonicalModels.map((model) => [routeKey(model.provider, model.id), model]));
  const liveByKey = new Map(models.map((model) => [routeKey(model.provider, model.id), model]));
  if (canonicalByKey.size !== liveByKey.size || [...canonicalByKey.keys()].some((key) => {
    const live = liveByKey.get(key);
    return !live || live.api !== canonicalByKey.get(key)!.api;
  })) return false;
  // Provider registration mutates live model baseUrls to point at Headroom.
  // Replan from definitions captured before that mutation, not routed models.
  const plan = planProxyProviderRoutes(config.proxyUrl, shared.canonicalModels);
  for (const provider of shared.registration.registeredProviders) {
    if (plan.providers.get(provider) !== shared.registration.providers.get(provider)) return false;
  }
  const sharedProviders = new Set(shared.registration.registeredProviders);
  for (const provider of plan.providers.keys()) {
    if (!sharedProviders.has(provider) && !shared.excludedProviderIds.has(provider)) return false;
  }
  for (const [modelKey, upstream] of shared.registration.upstreamByModel) {
    if (plan.upstreamByModel.get(modelKey) !== upstream) return false;
  }
  for (const modelKey of plan.upstreamByModel.keys()) {
    const provider = modelKey.slice(0, modelKey.indexOf("\u0000"));
    if (!shared.registration.upstreamByModel.has(modelKey) && !shared.excludedProviderIds.has(provider)) return false;
  }
  return true;
}

function routableModels(models: unknown[], configuredProviders: Set<string>): HeadroomRouteModel[] {
  return models.filter((model): model is HeadroomRouteModel => {
    if (!model || typeof model !== "object") return false;
    const candidate = model as Partial<HeadroomRouteModel>;
    const structurallyValid = typeof candidate.id === "string" && typeof candidate.provider === "string"
      && typeof candidate.api === "string" && typeof candidate.baseUrl === "string";
    if (!structurallyValid) return false;
    return ["openai", "anthropic", "openai-codex"].includes(candidate.provider!) || configuredProviders.has(candidate.provider!);
  }).map((model) => ({ ...model }));
}

function registerProxyProviders(
  pi: ExtensionAPI,
  config: HeadroomConfig,
  models: HeadroomRouteModel[],
  excludedProviderIds: Set<string>,
): HeadroomProxyRegistration | undefined {
  if (config.localToolResultCompression || !hasSupportedProxyProtocol(config.proxyUrl) || isRemoteBlocked(config)) return undefined;
  const registerProvider = (pi as ExtensionAPI & {
    registerProvider?: (name: string, options: { baseUrl: string }) => void;
  }).registerProvider;
  if (!registerProvider) return undefined;
  const plan = planProxyProviderRoutes(config.proxyUrl, models);
  for (const provider of excludedProviderIds) {
    plan.providers.delete(provider);
    const prefix = `${provider}\u0000`;
    for (const key of plan.upstreamByModel.keys()) {
      if (key.startsWith(prefix)) plan.upstreamByModel.delete(key);
    }
  }
  const registeredProviders: string[] = [];
  try {
    for (const [name, baseUrl] of plan.providers) {
      registerProvider(name, { baseUrl });
      registeredProviders.push(name);
    }
  } catch (error) {
    const unregisterProvider = (pi as ExtensionAPI & { unregisterProvider?: (name: string) => void }).unregisterProvider;
    for (const name of registeredProviders.reverse()) unregisterProvider?.(name);
    throw error;
  }
  return { ...plan, registeredProviders };
}

function unregisterProxyProviders(pi: ExtensionAPI, providers: string[]): void {
  const unregisterProvider = (pi as ExtensionAPI & {
    unregisterProvider?: (name: string) => void;
  }).unregisterProvider;
  if (!unregisterProvider) return;
  for (const provider of providers) unregisterProvider(provider);
}

export type HeadroomWireFormat = "openai" | "anthropic";

function wireFormatForContext(ctx: ExtensionContext): HeadroomWireFormat {
  return ctx.model?.provider?.toLowerCase().includes("anthropic") ? "anthropic" : "openai";
}

export function buildCompressRequest(
  text: string,
  toolName: string,
  model: string,
  wireFormat: HeadroomWireFormat = "openai",
) {
  const prefix = `Tool output from ${toolName}:\n\n`;
  if (wireFormat === "anthropic") {
    return {
      model,
      protect_recent: 0,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_headroom_tool_output", content: `${prefix}${text}` }],
        },
      ],
    };
  }
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
  const wireFormat = wireFormatForContext(ctx);
  const body = buildCompressRequest(text, toolName, modelId(ctx), wireFormat);
  const json = (await fetchJson(
    proxyEndpoint(config.proxyUrl, "/v1/compress"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-headroom-client": "pi-headroom-extension",
        ...(ctx.cwd ? { "x-headroom-project": basename(ctx.cwd) } : {}),
      },
      body: JSON.stringify(body),
    },
    config.compressionTimeoutMs,
    getContextSignal(ctx),
  )) as Record<string, unknown>;

  const messages = Array.isArray(json.messages) ? (json.messages as Array<Record<string, unknown>>) : [];
  if (messages.length !== 1) throw new Error("Headroom changed message count; refusing compressed output.");
  const first = messages[0] ?? {};
  let content: string | undefined;
  if (wireFormat === "anthropic") {
    const blocks = Array.isArray(first.content) ? (first.content as Array<Record<string, unknown>>) : [];
    const resultBlock = blocks.find((block) => block.type === "tool_result" && block.tool_use_id === "call_headroom_tool_output");
    if (first.role !== "user" || !resultBlock) throw new Error("Headroom changed Anthropic tool message identity; refusing compressed output.");
    content = typeof resultBlock.content === "string" ? resultBlock.content : undefined;
  } else {
    if (first.role !== "tool" || first.tool_call_id !== "call_headroom_tool_output") {
      throw new Error("Headroom changed tool message identity; refusing compressed output.");
    }
    content = typeof first.content === "string" ? first.content : undefined;
  }
  if (content === undefined) content = text;
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

export interface HeadroomDependencies {
  /** Monotonic milliseconds from an arbitrary origin; use only for elapsed durations. */
  monotonicNowMs(): number;
  readConfig(): HeadroomConfig;
  configuredProviderIds(): Set<string>;
  ensureDirs(): void;
  cleanupStore(config: HeadroomConfig): void;
  health(config: HeadroomConfig, signal?: AbortSignal): Promise<boolean>;
  proxyHistory(config: HeadroomConfig, signal?: AbortSignal): Promise<ProxyHistorySummary>;
  waitForHealth(
    config: HeadroomConfig,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    isActive: () => boolean,
  ): Promise<boolean>;
  commandAvailable(): boolean;
  openLog(): number;
  closeLog(fd: number): void;
  spawnProxy(config: HeadroomConfig, logFd: number): ChildProcess;
  writePid(pid: number): void;
  terminateChild(child: ChildProcess): Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: HeadroomDependencies = {
  monotonicNowMs: () => performance.now(),
  readConfig,
  configuredProviderIds,
  ensureDirs,
  cleanupStore,
  health,
  proxyHistory,
  waitForHealth,
  commandAvailable,
  openLog: () => openSync(LOG_PATH, "a"),
  closeLog: (fd) => closeSync(fd),
  spawnProxy: (config, logFd) => spawn("headroom", ["proxy", "--host", config.host, "--port", String(config.port)], {
    env: { ...process.env, HEADROOM_TELEMETRY: "off" },
    stdio: ["ignore", logFd, logFd],
  }),
  writePid: (pid) => writeFileSync(PID_PATH, `${pid}\n`, "utf8"),
  terminateChild: terminateChildProcess,
};

export default function headroom(pi: ExtensionAPI, dependencyOverrides: Partial<HeadroomDependencies> = {}) {
  const dependencies: HeadroomDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  let config = dependencies.readConfig();
  const specialistSessionNames = new Set(["researcher", "code-mapper", "builder", "reviewer"]);
  const disableLocalCompressionForSpecialist = (): void => {
    if (!config.localToolResultCompression || !specialistSessionNames.has(pi.getSessionName?.() ?? "")) return;
    // pi-subagents assigns role name after extension binding, so inspect it on
    // first turn, before deferred local-proxy startup.
    config = { ...config, enabled: false, localToolResultCompression: false, startup: "off" };
    runtimeEnabled = false;
    owner = "none";
  };
  let resetConfigForSave: HeadroomConfig | undefined;
  let proxyRegistration: ActiveHeadroomProxyRegistration | undefined;
  let proxyRoutingError: string | undefined;
  let sharedReleaseInFlight: Promise<boolean> | undefined;
  const requestSharedManagedRelease = (shared: SharedHeadroomRoutingState): void => {
    const release = shared.releaseManagedProcess;
    if (!release || sharedReleaseInFlight) return;
    const pending = release();
    sharedReleaseInFlight = pending;
    void pending.then(() => {
      if (sharedReleaseInFlight === pending) sharedReleaseInFlight = undefined;
    }, () => {
      if (sharedReleaseInFlight === pending) sharedReleaseInFlight = undefined;
    });
  };
  const enableProxyRouting = (ctx: ExtensionContext): boolean => {
    if (config.localToolResultCompression || proxyRegistration) return true;

    const runtime = runtimeForRouting(ctx);
    const shared = runtime ? sharedRoutingStates().get(runtime) : undefined;
    if (shared?.stopping) {
      proxyRoutingError = "another session is stopping the shared Headroom proxy; retry after shutdown completes";
      return false;
    }
    if (shared?.references === 0) {
      const ownsManagedProcess = !!managedProcess && shared.managedProcess === managedProcess;
      const canReuseUnmanagedState = !shared.managedProcess && !shared.stopping;
      const canReuseRetainedManagedState = !!shared.managedProcess && !shared.stopping;
      if ((!shared.adoptable && !ownsManagedProcess && !canReuseUnmanagedState && !canReuseRetainedManagedState) || shared.proxyUrl !== config.proxyUrl) {
        proxyRoutingError = shared.adoptable
          ? "another session owns a managed Headroom proxy for a different proxyUrl"
          : "a previous shared Headroom managed proxy is still tracked after failed termination";
        return false;
      }
      try {
        const registry = modelRegistryRoutingSnapshot(ctx);
        // Zero-reference retained proxies have already unregistered their
        // providers, so live models are native again and safe to snapshot.
        shared.canonicalModels = routableModels(registry.models, dependencies.configuredProviderIds());
        const registration = registerProxyProviders(
          pi,
          config,
          shared.canonicalModels,
          registry.registeredProviderIds,
        );
        if (!registration) {
          proxyRoutingError = "Pi provider registration API is unavailable";
          return false;
        }
        shared.registration = registration;
        shared.excludedProviderIds = registry.registeredProviderIds;
        shared.unregisterProvider = (pi as ExtensionAPI & { unregisterProvider?: (name: string) => void }).unregisterProvider?.bind(pi);
        shared.references = 1;
        shared.adoptable = false;
        proxyRegistration = { ...registration, sharedState: shared, leaseGeneration: shared.generation };
        proxyRoutingError = undefined;
        return true;
      } catch (error) {
        proxyRoutingError = error instanceof Error ? error.message : String(error);
        return false;
      }
    }
    if (shared) {
      const registry = modelRegistryRoutingSnapshot(ctx);
      const models = routableModels(registry.models, dependencies.configuredProviderIds());
      if (!sharedRoutingMatches(shared, config, models)) {
        proxyRoutingError = "another active session owns a different Headroom provider route; stop it before changing proxyUrl or models.json";
        return false;
      }
      shared.references++;
      proxyRegistration = { ...shared.registration, sharedState: shared, leaseGeneration: shared.generation };
      proxyRoutingError = undefined;
      return true;
    }

    try {
      const registry = modelRegistryRoutingSnapshot(ctx);
      const registration = registerProxyProviders(
        pi,
        config,
        routableModels(registry.models, dependencies.configuredProviderIds()),
        registry.registeredProviderIds,
      );
      proxyRoutingError = registration ? undefined : "Pi provider registration API is unavailable";
      if (registration) {
        const active: ActiveHeadroomProxyRegistration = { ...registration };
        if (runtime) {
          const sharedState: SharedHeadroomRoutingState = {
            runtime,
            registration,
            canonicalModels: routableModels(registry.models, dependencies.configuredProviderIds()),
            proxyUrl: config.proxyUrl,
            excludedProviderIds: registry.registeredProviderIds,
            references: 1,
            generation: 0,
            invalidatedReferences: 0,
            adoptable: false,
            stopping: false,
            unregisterProvider: (pi as ExtensionAPI & { unregisterProvider?: (name: string) => void }).unregisterProvider?.bind(pi),
          };
          sharedRoutingStates().set(runtime, sharedState);
          active.sharedState = sharedState;
          active.leaseGeneration = sharedState.generation;
        }
        proxyRegistration = active;
      } else {
        proxyRegistration = undefined;
      }
    } catch (error) {
      proxyRegistration = undefined;
      proxyRoutingError = error instanceof Error ? error.message : String(error);
    }
    return proxyRegistration !== undefined;
  };
  const disableProxyRouting = (releaseFinalManagedProcess = true, disableSharedRuntime = false): void => {
    const active = proxyRegistration;
    if (!active) return;
    proxyRegistration = undefined;
    if (active.sharedState) {
      const shared = active.sharedState;
      const states = sharedRoutingStates();
      const leaseIsCurrent = active.leaseGeneration === undefined || active.leaseGeneration === shared.generation;
      if (!leaseIsCurrent) {
        shared.invalidatedReferences = Math.max(0, shared.invalidatedReferences - 1);
        if (shared.invalidatedReferences === 0) {
          if (shared.references > 0) {
            shared.stopping = false;
            shared.adoptable = false;
          } else if (shared.releaseManagedProcess) {
            shared.stopping = true;
            shared.adoptable = false;
            if (releaseFinalManagedProcess && !managedProcess) requestSharedManagedRelease(shared);
          } else {
            shared.stopping = false;
            shared.adoptable = false;
            if (states.get(shared.runtime) === shared) states.delete(shared.runtime);
          }
        }
        return;
      }
      shared.references = Math.max(0, shared.references - 1);
      if (shared.references === 0) {
        for (const provider of shared.registration.registeredProviders) shared.unregisterProvider?.(provider);
        const retain = !!shared.managedProcess && !!shared.releaseManagedProcess;
        shared.adoptable = retain && !shared.stopping;
        if (!retain) {
          shared.managedProcess = undefined;
          shared.releaseManagedProcess = undefined;
          if (managedSharedRoutingState === shared) managedSharedRoutingState = undefined;
          if (states.get(shared.runtime) === shared) states.delete(shared.runtime);
        } else if (releaseFinalManagedProcess && !managedProcess) {
          shared.stopping = true;
          requestSharedManagedRelease(shared);
        }
      } else if (disableSharedRuntime) {
        shared.invalidatedReferences += shared.references;
        shared.references = 0;
        shared.generation++;
        shared.adoptable = false;
        for (const provider of shared.registration.registeredProviders) shared.unregisterProvider?.(provider);
        if ((!shared.managedProcess || !shared.releaseManagedProcess) && shared.invalidatedReferences === 0) {
          if (managedSharedRoutingState === shared) managedSharedRoutingState = undefined;
          if (states.get(shared.runtime) === shared) states.delete(shared.runtime);
        }
      }
      return;
    }
    unregisterProxyProviders(pi, active.registeredProviders);
  };
  const retireInvalidatedProxyLease = (): void => {
    const active = proxyRegistration;
    const shared = active?.sharedState;
    if (!active || !shared || active.leaseGeneration === undefined || active.leaseGeneration === shared.generation) return;
    proxyRegistration = undefined;
    shared.invalidatedReferences = Math.max(0, shared.invalidatedReferences - 1);
    if (shared.invalidatedReferences > 0) return;
    if (shared.references > 0) {
      shared.stopping = false;
      shared.adoptable = false;
      return;
    }
    if (shared.releaseManagedProcess) {
      shared.stopping = false;
      shared.adoptable = true;
      return;
    }
    if (sharedRoutingStates().get(shared.runtime) === shared) sharedRoutingStates().delete(shared.runtime);
  };
  let runtimeEnabled = initialRuntimeEnabled(config);
  let owner: ProxyOwner = "none";
  let managedProcess: ChildProcess | undefined;
  let managedLifecycle: ReturnType<typeof createManagedProxyLifecycle> | undefined;
  let managedSharedRoutingState: SharedHeadroomRoutingState | undefined;
  let managedStartupPending = false;
  const invalidateSharedRoutingForConflict = (shared: SharedHeadroomRoutingState): void => {
    shared.invalidatedReferences += shared.references;
    shared.references = 0;
    shared.generation++;
    shared.adoptable = false;
    for (const provider of shared.registration.registeredProviders) shared.unregisterProvider?.(provider);
  };
  const synchronizeSharedRouting = (ctx?: ExtensionContext): void => {
    if (!ctx) return;
    const routingRuntime = runtimeForRouting(ctx);
    const shared = routingRuntime ? sharedRoutingStates().get(routingRuntime) : undefined;
    const active = proxyRegistration;
    if (active?.sharedState && active.leaseGeneration !== undefined && active.leaseGeneration !== active.sharedState.generation) {
      retireInvalidatedProxyLease();
    }
    if (!shared || shared.references === 0) {
      if (active?.sharedState) runtimeEnabled = false;
      return;
    }
    const registry = modelRegistryRoutingSnapshot(ctx);
    const models = routableModels(registry.models, dependencies.configuredProviderIds());
    if (!sharedRoutingMatches(shared, config, models)) {
      proxyRoutingError = "shared Headroom route no longer matches this session's proxyUrl or models; restoring native routing";
      if (proxyRegistration?.sharedState === shared) disableProxyRouting(false, true);
      else invalidateSharedRoutingForConflict(shared);
      runtimeEnabled = false;
      return;
    }
    if (!proxyRegistration) {
      shared.references++;
      proxyRegistration = { ...shared.registration, sharedState: shared, leaseGeneration: shared.generation };
    }
    runtimeEnabled = true;
  };
  const clearManagedProcessFromSharedRouting = (child: ChildProcess): void => {
    const shared = managedSharedRoutingState;
    if (!shared || shared.managedProcess !== child) return;
    shared.managedProcess = undefined;
    shared.releaseManagedProcess = undefined;
    managedSharedRoutingState = undefined;
    const states = sharedRoutingStates();
    if (shared.references === 0 && states.get(shared.runtime) === shared) states.delete(shared.runtime);
  };
  const attachManagedProcessToSharedRouting = (): void => {
    const shared = proxyRegistration?.sharedState;
    const child = managedProcess;
    if (!shared || !child || shared.managedProcess) return;
    shared.managedProcess = child;
    managedSharedRoutingState = shared;
    const releaseManagedProcess = async (): Promise<boolean> => {
      managedLifecycle?.markStopping();
      const terminated = await dependencies.terminateChild(child);
      if (!terminated) {
        if (shared.references === 0) {
          shared.managedProcess = child;
          shared.releaseManagedProcess = releaseManagedProcess;
          managedSharedRoutingState = shared;
          sharedRoutingStates().set(shared.runtime, shared);
        }
        return false;
      }
      clearManagedProcessFromSharedRouting(child);
      if (managedProcess === child) {
        managedProcess = undefined;
        managedLifecycle = undefined;
      }
      try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
      return true;
    };
    shared.releaseManagedProcess = releaseManagedProcess;
  };
  let routingMutationRevision = 0;
  const beginRoutingMutation = (): number => ++routingMutationRevision;
  const routingMutationIsCurrent = (revision: number): boolean => revision === routingMutationRevision;
  let failureNotified = false;
  const stats = initialStats();

  let proxyStatsBaseline: { requests: number; tokensSaved: number; tokensAfter: number } | undefined;
  let proxyStatsBaselineRevision = 0;
  const proxyHistorySequenceKey = Symbol("proxyHistorySequence");
  let proxyHistoryIssuedSequence = 0;
  let proxyHistoryCompletedSequence = 0;
  let proxyHistoryAppliedSequence = 0;
  let proxyHistoryBackoffUntil = 0;
  const fetchProxyHistory = async (signal?: AbortSignal, force = false): Promise<ProxyHistorySummary> => {
    if (!force && dependencies.monotonicNowMs() < proxyHistoryBackoffUntil) return { error: "history backoff active" };
    const sequence = ++proxyHistoryIssuedSequence;
    const history = await dependencies.proxyHistory(config, signal);
    if (sequence >= proxyHistoryCompletedSequence) {
      proxyHistoryCompletedSequence = sequence;
      proxyHistoryBackoffUntil = history.error && !signal?.aborted ? dependencies.monotonicNowMs() + 30_000 : 0;
    }
    return Object.assign({}, history, { [proxyHistorySequenceKey]: sequence });
  };
  const proxyMetricSnapshot = (history: ProxyHistorySummary): { requests: number; tokensSaved: number; tokensAfter: number } | undefined => {
    const source = history.displaySession ?? history.lifetime;
    if (!source) return undefined;
    const numberValue = (key: string): number => typeof source[key] === "number" && Number.isFinite(source[key]) ? source[key] as number : 0;
    return {
      requests: Math.max(0, numberValue("requests")),
      tokensSaved: Math.max(0, numberValue("tokens_saved")),
      tokensAfter: Math.max(0, numberValue("total_input_tokens")),
    };
  };
  const syncStatsFromProxy = (history: ProxyHistorySummary, allowInactive = false): void => {
    if ((!runtimeEnabled && !allowInactive) || config.localToolResultCompression) return;
    const current = proxyMetricSnapshot(history);
    if (!current) return;
    const sequence = (history as ProxyHistorySummary & { [proxyHistorySequenceKey]?: number })[proxyHistorySequenceKey] ?? 0;
    if (sequence > 0 && sequence < proxyHistoryAppliedSequence) return;
    if (sequence > 0) proxyHistoryAppliedSequence = sequence;
    if (!proxyStatsBaseline) {
      proxyStatsBaseline = current;
      return;
    }
    if (current.requests < proxyStatsBaseline.requests || current.tokensSaved < proxyStatsBaseline.tokensSaved || current.tokensAfter < proxyStatsBaseline.tokensAfter) {
      proxyStatsBaseline = current;
      return;
    }
    const delta = (value: number, baseline: number): number => Math.max(0, value - baseline);
    stats.proxyRequests += delta(current.requests, proxyStatsBaseline.requests);
    stats.tokensSaved += delta(current.tokensSaved, proxyStatsBaseline.tokensSaved);
    stats.tokensAfter += delta(current.tokensAfter, proxyStatsBaseline.tokensAfter);
    stats.tokensBefore = stats.tokensAfter + stats.tokensSaved;
    proxyStatsBaseline = current;
  };

  const invalidatePendingBaselineCapture = (): void => { proxyStatsBaselineRevision++; };
  const captureProxyStatsBaseline = async (signal?: AbortSignal): Promise<boolean> => {
    if (config.localToolResultCompression) return true;
    const revision = ++proxyStatsBaselineRevision;
    proxyStatsBaseline = undefined;
    const history = await fetchProxyHistory(signal, true);
    if (signal?.aborted || revision !== proxyStatsBaselineRevision) return false;
    const snapshot = proxyMetricSnapshot(history);
    const sequence = (history as ProxyHistorySummary & { [proxyHistorySequenceKey]?: number })[proxyHistorySequenceKey] ?? 0;
    if (sequence > 0 && sequence < proxyHistoryAppliedSequence) return false;
    if (sequence > proxyHistoryAppliedSequence) proxyHistoryAppliedSequence = sequence;
    proxyStatsBaseline = snapshot;
    return snapshot !== undefined;
  };
  const finalizeProxyStatsSegment = async (wasRuntimeEnabled = runtimeEnabled, signal?: AbortSignal): Promise<void> => {
    if (!wasRuntimeEnabled || config.localToolResultCompression) return;
    const history = await fetchProxyHistory(signal, true);
    if (signal?.aborted) return;
    syncStatsFromProxy(history, true);
  };

  const notifyFailure = (ctx: ExtensionContext, message: string): void => {
    stats.failures++;
    if (!shouldNotifyHeadroomFailure("compression", ctx.hasUI, config.notifyFailures, failureNotified)) return;
    failureNotified = true;
    ctx.ui.notify(message, "warning");
  };

  const notifyLifecycleFailure = (ctx: ExtensionContext, message: string): void => {
    stats.failures++;
    if (shouldNotifyHeadroomFailure("lifecycle", ctx.hasUI, config.notifyFailures, failureNotified)) ctx.ui.notify(message, "error");
  };

  const activateProxyRouting = (ctx: ExtensionContext): boolean => {
    if (enableProxyRouting(ctx)) {
      attachManagedProcessToSharedRouting();
      return true;
    }
    runtimeEnabled = false;
    updateStatus(ctx, runtimeEnabled, owner, stats);
    notifyLifecycleFailure(ctx, `Headroom could not install Pi provider routing: ${proxyRoutingError ?? "unknown provider registration failure"}. Native providers remain active.`);
    return false;
  };

  const runManagedProxyStart = async (attempt: HeadroomStartAttempt, ctx: ExtensionContext): Promise<void> => {
    const startupSignal = getContextSignal(ctx);
    try {
      dependencies.ensureDirs();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      runtimeEnabled = false;
      disableProxyRouting();
      owner = "none";
      updateStatus(ctx, runtimeEnabled, owner, stats);
      notifyLifecycleFailure(ctx, `Headroom startup directory setup failed: ${detail}. Bypassing compression.`);
      return;
    }
    if (!canStartRuntime(config)) {
      runtimeEnabled = false;
      disableProxyRouting();
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify("Headroom startup is off. Change config startup before starting compression.", "warning");
      return;
    }
    if (!hasSupportedProxyProtocol(config.proxyUrl)) {
      owner = "none";
      runtimeEnabled = false;
      disableProxyRouting();
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify(`Headroom proxyUrl must use http or https: ${config.proxyUrl}.`, "warning");
      return;
    }
    if (isRemoteBlocked(config)) {
      owner = "none";
      runtimeEnabled = false;
      disableProxyRouting();
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify(`Headroom remote proxy blocked: ${config.proxyUrl}. Set allowRemote=true only for a trusted proxy.`, "warning");
      return;
    }
    const alreadyHealthy = await dependencies.health(config, startupSignal);
    if (!attempt.isCurrent() || startupSignal?.aborted) return;
    if (alreadyHealthy) {
      owner = managedProcess ? "managed" : "external";
      if (config.enabled) {
        const routingRevision = beginRoutingMutation();
        if (!activateProxyRouting(ctx)) return;
        runtimeEnabled = config.enabled;
        await captureProxyStatsBaseline(startupSignal);
        if (!attempt.isCurrent() || !routingMutationIsCurrent(routingRevision)) return;
        if (startupSignal?.aborted) {
          runtimeEnabled = false;
          disableProxyRouting();
          owner = managedProcess ? "managed" : "external";
          updateStatus(ctx, runtimeEnabled, owner, stats);
          return;
        }
      }
      runtimeEnabled = config.enabled;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify(`Headroom proxy already running (${owner}).`, "info");
      return;
    }
    if (managedProcess) {
      runtimeEnabled = false;
      disableProxyRouting();
      owner = "managed";
      updateStatus(ctx, runtimeEnabled, owner, stats);
      notifyLifecycleFailure(ctx, "A previous Headroom managed proxy is unhealthy but still tracked. Refusing to spawn a replacement until its exit is confirmed; retry /headroom stop or terminate it manually.");
      return;
    }
    if (!isLocalProxyUrl(config.proxyUrl)) {
      runtimeEnabled = false;
      disableProxyRouting();
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify(`Headroom remote proxy unavailable: ${config.proxyUrl}.`, "warning");
      return;
    }

    if (!dependencies.commandAvailable()) {
      owner = "none";
      runtimeEnabled = false;
      disableProxyRouting();
      updateStatus(ctx, runtimeEnabled, owner, stats);
      notifyLifecycleFailure(ctx, 'Headroom CLI missing. Run /headroom doctor for install commands.');
      return;
    }

    const lifecycle = createManagedProxyLifecycle();
    managedLifecycle = lifecycle;
    let terminalFailureNotified = false;
    let child: ChildProcess;
    let logFd: number | undefined;
    try {
      logFd = dependencies.openLog();
      child = dependencies.spawnProxy(config, logFd);
    } catch (error) {
      const notice = lifecycle.handleSpawnError(error);
      managedLifecycle = undefined;
      owner = "none";
      runtimeEnabled = false;
      disableProxyRouting();
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (notice) notifyLifecycleFailure(ctx, notice.message);
      return;
    } finally {
      if (logFd !== undefined) {
        try { dependencies.closeLog(logFd); } catch {}
      }
    }
    managedProcess = child;
    managedStartupPending = true;
    let startupPending = true;
    let pendingTerminalNotice: ManagedProxyLifecycleNotice | undefined;

    const handleTerminalFailure = (notice: ManagedProxyLifecycleNotice | undefined): void => {
      if (!notice) return;
      terminalFailureNotified = true;
      if (!startupPending) startCoordinator.cancel();
      beginRoutingMutation();
      invalidatePendingBaselineCapture();
      const exited = childHasExited(child);
      if (exited) {
        managedStartupPending = false;
        clearManagedProcessFromSharedRouting(child);
      }
      if (exited && managedProcess === child) managedProcess = undefined;
      if (exited && managedLifecycle === lifecycle) managedLifecycle = undefined;
      runtimeEnabled = false;
      disableProxyRouting();
      owner = exited ? "none" : "managed";
      try { if (exited && existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (startupPending) {
        pendingTerminalNotice = notice;
        return;
      }
      notifyLifecycleFailure(ctx, notice.message);
    };
    child.on("error", (error) => {
      handleTerminalFailure(lifecycle.handleSpawnError(error));
    });
    child.on("exit", (code, signal) => {
      // handleExit suppresses notices for intentional or previously failed
      // termination; confirmed exit must still release transferred ownership.
      clearManagedProcessFromSharedRouting(child);
      handleTerminalFailure(lifecycle.handleExit(code, signal));
      if (managedProcess === child) {
        managedStartupPending = false;
        if (runtimeEnabled || proxyRegistration) {
          beginRoutingMutation();
          invalidatePendingBaselineCapture();
          runtimeEnabled = false;
          disableProxyRouting();
        }
        managedProcess = undefined;
        if (managedLifecycle === lifecycle) managedLifecycle = undefined;
        if (owner === "managed") owner = "none";
        try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
        updateStatus(ctx, runtimeEnabled, owner, stats);
      }
    });
    try {
      if (child.pid) dependencies.writePid(child.pid);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const notice = lifecycle.handleSpawnError(new Error(`cannot write Headroom PID file: ${detail}`));
      terminalFailureNotified = true;
      runtimeEnabled = false;
      disableProxyRouting();
      owner = "managed";
      updateStatus(ctx, runtimeEnabled, owner, stats);
      lifecycle.markStopping();
      const terminated = await dependencies.terminateChild(child);
      managedStartupPending = false;
      if (!attempt.isCurrent()) return;
      if (notice) notifyLifecycleFailure(ctx, notice.message);
      if (terminated) {
        clearManagedProcessFromSharedRouting(child);
        if (managedProcess === child) managedProcess = undefined;
        if (managedLifecycle === lifecycle) managedLifecycle = undefined;
        owner = "none";
        try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
        updateStatus(ctx, runtimeEnabled, owner, stats);
      } else {
        notifyLifecycleFailure(ctx, "Headroom child could not be terminated after PID-file failure; compression is disabled and the process remains tracked. Run /headroom stop or terminate it manually.");
      }
      return;
    }

    const startupHealthStartedAtMs = dependencies.monotonicNowMs();
    const becameHealthy = await dependencies.waitForHealth(config, getContextSignal(ctx), config.startupHealthTimeoutMs, () => managedProcess === child && attempt.isCurrent());
    if (!attempt.isCurrent()) return;
    startupPending = false;
    if (becameHealthy) {
      managedStartupPending = false;
      lifecycle.markReady();
      owner = "managed";
      if (config.enabled) {
        const routingRevision = beginRoutingMutation();
        if (!activateProxyRouting(ctx)) return;
        runtimeEnabled = config.enabled;
        await captureProxyStatsBaseline(startupSignal);
        if (!attempt.isCurrent() || !routingMutationIsCurrent(routingRevision)) return;
        if (startupSignal?.aborted) {
          runtimeEnabled = false;
          disableProxyRouting();
          owner = "managed";
          updateStatus(ctx, runtimeEnabled, owner, stats);
          return;
        }
      }
      runtimeEnabled = config.enabled;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify("Headroom proxy started.", "info");
      return;
    }

    const elapsedStartupHealthMs = Math.max(0, dependencies.monotonicNowMs() - startupHealthStartedAtMs);
    const remainingStartupHealthMs = config.startupHealthTimeoutMs - elapsedStartupHealthMs;
    const concurrentProxyHealthy = pendingTerminalNotice && remainingStartupHealthMs > 0
      ? await dependencies.waitForHealth(
        config,
        getContextSignal(ctx),
        remainingStartupHealthMs,
        () => pendingTerminalNotice !== undefined && managedProcess !== child && attempt.isCurrent(),
      )
      : false;
    if (!attempt.isCurrent()) return;
    if (concurrentProxyHealthy) {
      owner = "external";
      if (config.enabled) {
        const routingRevision = beginRoutingMutation();
        if (!activateProxyRouting(ctx)) return;
        runtimeEnabled = config.enabled;
        await captureProxyStatsBaseline(startupSignal);
        if (!attempt.isCurrent() || !routingMutationIsCurrent(routingRevision)) return;
        if (startupSignal?.aborted) {
          runtimeEnabled = false;
          disableProxyRouting();
          owner = "external";
          updateStatus(ctx, runtimeEnabled, owner, stats);
          return;
        }
      }
      runtimeEnabled = config.enabled;
      updateStatus(ctx, runtimeEnabled, owner, stats);
      if (ctx.hasUI) ctx.ui.notify("Headroom adopted a concurrent Headroom proxy after its own startup attempt ended.", "info");
      return;
    }
    if (pendingTerminalNotice) notifyLifecycleFailure(ctx, pendingTerminalNotice.message);

    const timeoutNotice = terminalFailureNotified ? undefined : lifecycle.handleTimeout(config.startupHealthTimeoutMs);
    lifecycle.markStopping();
    const terminated = managedProcess === child ? await dependencies.terminateChild(child) : childHasExited(child);
    managedStartupPending = false;
    if (!attempt.isCurrent()) return;
    if (terminated) {
      if (managedProcess === child) managedProcess = undefined;
      if (managedLifecycle === lifecycle) managedLifecycle = undefined;
      owner = "none";
    } else {
      owner = "managed";
    }
    runtimeEnabled = false;
    disableProxyRouting();
    try { if (existsSync(PID_PATH) && terminated) unlinkSync(PID_PATH); } catch {}
    updateStatus(ctx, runtimeEnabled, owner, stats);
    if (timeoutNotice) notifyLifecycleFailure(ctx, timeoutNotice.message);
    if (!terminated) notifyLifecycleFailure(ctx, "Headroom timed-out child did not terminate; compression is disabled and the process remains tracked. Run /headroom stop or terminate it manually.");
  };

  const startCoordinator = createStartCoordinator(runManagedProxyStart);
  let stopInFlight: Promise<boolean> | undefined;
  let startInFlight: Promise<void> | undefined;
  const trackStart = async (operation: Promise<void>): Promise<void> => {
    startInFlight = operation;
    const cleanup = (): void => {
      if (startInFlight === operation) startInFlight = undefined;
    };
    void operation.then(cleanup, cleanup);
    await operation;
  };
  const startManagedProxy = async (ctx: ExtensionContext): Promise<void> => {
    if (stopInFlight) await stopInFlight;
    if (startInFlight) return startInFlight;
    await trackStart(startCoordinator.start(ctx));
  };
  const restartManagedProxy = async (ctx: ExtensionContext): Promise<void> => {
    if (stopInFlight) await stopInFlight;
    if (startInFlight) {
      startCoordinator.cancel();
      await startInFlight;
    }
    await trackStart(startCoordinator.restart(ctx));
  };

  const performStopManagedProxy = async (ctx: ExtensionContext, notify = true): Promise<boolean> => {
    const activeSharedRouting = proxyRegistration?.sharedState;
    const activeLeaseGeneration = activeSharedRouting ? proxyRegistration?.leaseGeneration : undefined;
    const runtime = runtimeForRouting(ctx);
    const staleSharedRouting = activeSharedRouting ? undefined : runtime ? sharedRoutingStates().get(runtime) : undefined;
    const sharedHasPeers = (shared: SharedHeadroomRoutingState, leaseGeneration?: number): boolean => {
      if (leaseGeneration === undefined) return shared.references > 0 || shared.invalidatedReferences > 0;
      if (leaseGeneration !== shared.generation) {
        return shared.references > 0 || shared.invalidatedReferences > 1;
      }
      return shared.references > 1 || shared.invalidatedReferences > 0;
    };
    let sharedRoutingHasPeers = activeSharedRouting
      ? sharedHasPeers(activeSharedRouting, activeLeaseGeneration)
      : !!staleSharedRouting && sharedHasPeers(staleSharedRouting);
    const releaseSharedManagedProcess = managedProcess
      ? undefined
      : activeSharedRouting?.releaseManagedProcess ?? ((staleSharedRouting?.references === 0 || (staleSharedRouting?.invalidatedReferences ?? 0) > 0) ? staleSharedRouting.releaseManagedProcess : undefined);
    const managedSharedRouting = activeSharedRouting ?? staleSharedRouting;
    const shouldStopManagedProxy = !!managedProcess && !sharedRoutingHasPeers;
    if (shouldStopManagedProxy && managedSharedRouting) managedSharedRouting.stopping = true;
    startCoordinator.cancel();
    const stopRevision = beginRoutingMutation();
    invalidatePendingBaselineCapture();
    const wasRuntimeEnabled = runtimeEnabled;
    runtimeEnabled = false;
    if (shouldStopManagedProxy) managedLifecycle?.markStopping();
    disableProxyRouting(false);
    updateStatus(ctx, runtimeEnabled, owner, stats);
    await finalizeProxyStatsSegment(wasRuntimeEnabled, getContextSignal(ctx));
    if (!routingMutationIsCurrent(stopRevision)) return false;
    if (!sharedRoutingHasPeers && runtime) {
      const currentSharedRouting = sharedRoutingStates().get(runtime);
      sharedRoutingHasPeers = !!currentSharedRouting && sharedHasPeers(currentSharedRouting, activeLeaseGeneration);
    }
    if (sharedRoutingHasPeers) {
      if (managedProcess) managedLifecycle?.markActive();
      if (notify && ctx.hasUI) ctx.ui.notify("Headroom routing released for this session; active subagents retain the shared proxy.", "info");
      updateStatus(ctx, runtimeEnabled, owner, stats);
      return true;
    }
    if (managedProcess) {
      const child = managedProcess;
      const lifecycle = managedLifecycle;
      lifecycle?.markStopping();
      const terminated = await dependencies.terminateChild(child);
      managedStartupPending = false;
      if (terminated) {
        clearManagedProcessFromSharedRouting(child);
        if (managedProcess === child) managedProcess = undefined;
        if (managedLifecycle === lifecycle) managedLifecycle = undefined;
        owner = "none";
        try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
        if (notify && ctx.hasUI) ctx.ui.notify("Headroom managed proxy stopped. Compression disabled.", "info");
      } else {
        owner = "managed";
        notifyLifecycleFailure(ctx, "Headroom managed proxy did not terminate; compression is disabled and the process remains tracked. Retry /headroom stop or terminate it manually.");
      }
      updateStatus(ctx, runtimeEnabled, owner, stats);
      return terminated;
    }
    if (releaseSharedManagedProcess) {
      if (managedSharedRouting) managedSharedRouting.stopping = true;
      const terminated = await releaseSharedManagedProcess();
      owner = terminated ? "none" : "managed";
      if (notify && ctx.hasUI) ctx.ui.notify(terminated ? "Headroom managed proxy stopped. Compression disabled." : "Headroom managed proxy did not terminate; compression is disabled and the process remains tracked. Retry /headroom stop or terminate it manually.", terminated ? "info" : "error");
      updateStatus(ctx, runtimeEnabled, owner, stats);
      return terminated;
    }
    const wasExternal = owner === "external";
    owner = wasExternal ? "external" : "none";
    if (notify && ctx.hasUI) ctx.ui.notify(wasExternal ? "Compression disabled. External proxy left running." : "Compression disabled.", "info");
    updateStatus(ctx, runtimeEnabled, owner, stats);
    return true;
  };

  const stopManagedProxy = (ctx: ExtensionContext, notify = true): Promise<boolean> => {
    if (stopInFlight) return stopInFlight;
    const operation = performStopManagedProxy(ctx, notify);
    stopInFlight = operation;
    const cleanup = (): void => {
      if (stopInFlight === operation) stopInFlight = undefined;
    };
    void operation.then(cleanup, cleanup);
    return operation;
  };

  const statsSummary = (): string => [
    `enabled: ${runtimeEnabled}`,
    `proxyOwner: ${owner}`,
    `proxyUrl: ${config.proxyUrl}`,
    `allowRemote: ${config.allowRemote}`,
    `remoteBlocked: ${isRemoteBlocked(config)}`,
    `proxyStatsScope: proxy-history delta; concurrent proxy clients may be included`,
    `compressions: ${stats.compressions}`,
    `proxyRequests: ${stats.proxyRequests}`,
    `bypasses: ${stats.bypasses}`,
    `failures: ${stats.failures}`,
    `retrievals: ${stats.retrievals}`,
    `tokensSaved: ${stats.tokensSaved}`,
    `savingsPercent: ${savingsPercent(stats)}%`,
  ].join("\n");

  pi.on("session_start", async (_event, ctx) => {
    try {
      dependencies.cleanupStore(config);
    } catch (error) {
      notifyLifecycleFailure(ctx, `Headroom local-store cleanup failed: ${error instanceof Error ? error.message : String(error)}. Compression will remain disabled unless startup succeeds.`);
    }
    if (config.startup === "auto" && !config.localToolResultCompression) await startManagedProxy(ctx);
    else updateStatus(ctx, runtimeEnabled, owner, stats);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopManagedProxy(ctx, false);
  });

  pi.on("before_provider_headers", (event, ctx) => {
    const routingRuntime = runtimeForRouting(ctx);
    const shared = routingRuntime ? sharedRoutingStates().get(routingRuntime) : undefined;
    const activeLease = proxyRegistration?.sharedState
      ? proxyRegistration.leaseGeneration === proxyRegistration.sharedState.generation
        && proxyRegistration.sharedState.references > 0
      : !!proxyRegistration;
    const sharedRoute = !proxyRegistration && shared && shared.references > 0
      && sharedRoutingMatches(shared, config, routableModels(modelRegistryRoutingSnapshot(ctx).models, dependencies.configuredProviderIds()))
      ? shared.registration
      : undefined;
    const registration = activeLease ? proxyRegistration : sharedRoute;
    if (!runtimeEnabled || config.localToolResultCompression || !registration || !ctx.model) return;
    const upstream = registration.upstreamByModel.get(routeKey(ctx.model.provider, ctx.model.id));
    if (upstream) event.headers["x-headroom-base-url"] = upstream;
  });

  let deferredNativeRecoveryRevision: number | undefined;
  const recoverNativeRouting = async (ctx: ExtensionContext, deferReplacement = false): Promise<boolean> => {
    synchronizeSharedRouting(ctx);
    if (config.localToolResultCompression) return runtimeEnabled;
    if (!runtimeEnabled) return false;
    const signal = getContextSignal(ctx);
    if (signal?.aborted) return true;
    const routingRevision = routingMutationRevision;
    const healthy = await dependencies.health(config, signal);
    if (signal?.aborted) return true;
    if (!routingMutationIsCurrent(routingRevision)) return runtimeEnabled;
    if (healthy) return true;
    const recoveryRevision = beginRoutingMutation();
    invalidatePendingBaselineCapture();
    runtimeEnabled = false;
    disableProxyRouting(true, true);
    updateStatus(ctx, runtimeEnabled, owner, stats);
    if (owner === "external" && config.startup === "auto") {
      const release = sharedReleaseInFlight;
      if (release && !(await release)) return false;
      if (deferReplacement) deferredNativeRecoveryRevision = recoveryRevision;
      else await startManagedProxy(ctx);
    }
    return false;
  };

  const runDeferredNativeRecovery = async (ctx: ExtensionContext): Promise<boolean> => {
    const revision = deferredNativeRecoveryRevision;
    if (revision === undefined) return false;
    deferredNativeRecoveryRevision = undefined;
    if (getContextSignal(ctx)?.aborted) return false;
    if (
      !routingMutationIsCurrent(revision)
      || runtimeEnabled
      || owner !== "external"
      || config.startup !== "auto"
      || config.localToolResultCompression
    ) return false;
    await startManagedProxy(ctx);
    return true;
  };

  pi.on("turn_start", async (_event, ctx) => {
    disableLocalCompressionForSpecialist();
    if (config.localToolResultCompression && config.startup === "auto" && runtimeEnabled) {
      await startManagedProxy(ctx);
    }
    await recoverNativeRouting(ctx, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (await runDeferredNativeRecovery(ctx)) return;
    if (!await recoverNativeRouting(ctx)) return;
    if (config.localToolResultCompression) return;
    const history = await fetchProxyHistory(getContextSignal(ctx));
    syncStatsFromProxy(history);
    updateStatus(ctx, runtimeEnabled, owner, stats);
  });

  pi.on("tool_result", async (event, ctx) => {
    updateStatus(ctx, runtimeEnabled, owner, stats);
    const runConfig = config;
    if (!runtimeEnabled || !runConfig.localToolResultCompression) return;

    const text = textFromContent(event.content as Array<{ type: string; text?: string }>);
    if (!shouldCompressToolResult(event.toolName, event.input, text, runConfig)) {
      stats.bypasses++;
      return;
    }

    if (!(await dependencies.health(runConfig, getContextSignal(ctx)))) {
      if (owner === "external" && runConfig.startup === "auto") await startManagedProxy(ctx);
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
      dependencies.cleanupStore(runConfig);
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

  if (config.localToolResultCompression) {
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
  }

  pi.registerTool({
    name: "headroom_stats",
    label: "Headroom Stats",
    description: "Show Pi Headroom adapter session stats.",
    promptSnippet: "Inspect Headroom compression savings and local retrieval stats.",
    parameters: Schema.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      synchronizeSharedRouting(ctx);
      const history = runtimeEnabled
        ? await fetchProxyHistory(signal ?? getContextSignal(ctx))
        : { error: "routing disabled" };
      syncStatsFromProxy(history);
      const text = `${statsSummary()}\nproxyHistory: ${history.error ? `unavailable (${history.error})` : "available"}`;
      return {
        content: [{ type: "text", text }],
        details: { ...stats, enabled: runtimeEnabled, proxyOwner: owner, proxyStatsScope: "proxy-history delta; concurrent proxy clients may be included", proxyHistory: history },
      };
    },
  });

  pi.registerCommand("headroom", {
    description: "Manage local Headroom proxy and Pi compression adapter",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [command = "status", ...rest] = trimmed.split(/\s+/);
      const value = rest.join(" ").trim();
      synchronizeSharedRouting(ctx);

      if (command === "start") {
        await startManagedProxy(ctx);
        return;
      }
      if (command === "stop") {
        await stopManagedProxy(ctx);
        return;
      }
      if (command === "restart") {
        if (await stopManagedProxy(ctx)) await restartManagedProxy(ctx);
        return;
      }
      if (command === "enable") {
        const proxyUrlSupported = hasSupportedProxyProtocol(config.proxyUrl);
        const routingRuntime = runtimeForRouting(ctx);
        const sharedRouting = routingRuntime ? sharedRoutingStates().get(routingRuntime) : undefined;
        const routingActive = !!proxyRegistration && (!proxyRegistration.sharedState || proxyRegistration.sharedState.references > 0)
          || !!sharedRouting && sharedRouting.references > 0;
        if (!routingActive) retireInvalidatedProxyLease();
        const enableSignal = getContextSignal(ctx);
        if (startInFlight) {
          if (managedStartupPending) await startInFlight;
          else startCoordinator.cancel();
        }
        if (enableSignal?.aborted) return;
        if (runtimeEnabled && routingActive) {
          const routingRevision = routingMutationRevision;
          const healthy = await dependencies.health(config, enableSignal);
          if (enableSignal?.aborted || !routingMutationIsCurrent(routingRevision)) return;
          if (healthy) {
            updateStatus(ctx, runtimeEnabled, owner, stats);
            ctx.ui.notify("Headroom compression is already enabled for this session.", "info");
            return;
          }
          beginRoutingMutation();
          invalidatePendingBaselineCapture();
          runtimeEnabled = false;
          disableProxyRouting();
          updateStatus(ctx, runtimeEnabled, owner, stats);
        }
        if (!routingActive) runtimeEnabled = false;
        const routingRevision = beginRoutingMutation();
        const proxyHealthy = config.startup !== "off" && proxyUrlSupported && await dependencies.health(config, enableSignal);
        if (enableSignal?.aborted || !routingMutationIsCurrent(routingRevision)) return;
        const decision = enableRuntimeDecision(config, proxyHealthy, owner, managedProcess !== undefined);
        runtimeEnabled = false;
        owner = decision.owner;
        updateStatus(ctx, runtimeEnabled, owner, stats);
        if (decision.reason === "startup-off") {
          disableProxyRouting();
          ctx.ui.notify("Headroom startup is off. Change config startup before enabling compression.", "warning");
          return;
        }
        if (decision.reason === "proxy-unavailable") {
          disableProxyRouting();
          ctx.ui.notify(
            proxyUrlSupported
              ? `Headroom proxy unavailable at ${config.proxyUrl}. Run /headroom start or start proxy before /headroom enable.`
              : `Headroom proxyUrl must use http or https: ${config.proxyUrl}.`,
            "warning",
          );
          return;
        }
        const configEnabledBefore = config.enabled;
        config = { ...config, enabled: true };
        if (!activateProxyRouting(ctx)) {
          config = { ...config, enabled: configEnabledBefore };
          return;
        }
        await captureProxyStatsBaseline(enableSignal);
        if (!routingMutationIsCurrent(routingRevision)) return;
        if (enableSignal?.aborted) {
          config = { ...config, enabled: configEnabledBefore };
          runtimeEnabled = false;
          disableProxyRouting();
          updateStatus(ctx, runtimeEnabled, owner, stats);
          return;
        }
        runtimeEnabled = decision.runtimeEnabled;
        updateStatus(ctx, runtimeEnabled, owner, stats);
        ctx.ui.notify("Headroom compression enabled for this session.", "info");
        return;
      }
      if (command === "disable") {
        startCoordinator.cancel();
        const disableRevision = beginRoutingMutation();
        invalidatePendingBaselineCapture();
        const wasRuntimeEnabled = runtimeEnabled;
        runtimeEnabled = false;
        disableProxyRouting(true, true);
        updateStatus(ctx, runtimeEnabled, owner, stats);
        await finalizeProxyStatsSegment(wasRuntimeEnabled, getContextSignal(ctx));
        if (!routingMutationIsCurrent(disableRevision)) return;
        ctx.ui.notify("Headroom compression disabled for this session.", "info");
        return;
      }
      if (command === "stats" || command === "status") {
        const healthy = await dependencies.health(config, getContextSignal(ctx));
        const history = await fetchProxyHistory(getContextSignal(ctx));
        syncStatsFromProxy(history);
        if (healthy && owner === "none") owner = "external";
        updateStatus(ctx, runtimeEnabled, owner, stats);
        ctx.ui.notify(`${statsSummary()}\nproxyHealthy: ${healthy}\nproxyHistory: ${history.error ? `unavailable (${history.error})` : "available"}`, healthy ? "info" : "warning");
        return;
      }
      if (command === "doctor") {
        const version = commandVersion();
        const healthy = await dependencies.health(config, getContextSignal(ctx));
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
        dependencies.cleanupStore(config);
        ctx.ui.notify("Headroom local store cleaned.", "info");
        return;
      }
      if (command === "config") {
        if (value === "show") {
          ctx.ui.notify(JSON.stringify(config, null, 2), "info");
          return;
        }
        if (value === "save") {
          writeConfig({ ...(resetConfigForSave ?? config), enabled: runtimeEnabled });
          resetConfigForSave = undefined;
          ctx.ui.notify(`Headroom config saved to ${CONFIG_PATH}`, "info");
          return;
        }
        if (value === "reset") {
          const stopped = await stopManagedProxy(ctx, false);
          if (!stopped) {
            runtimeEnabled = false;
            disableProxyRouting();
            updateStatus(ctx, runtimeEnabled, owner, stats);
            ctx.ui.notify("Headroom config reset aborted because the managed proxy is still running. Retry /headroom stop or terminate it manually first.", "error");
            return;
          }
          const modeBeforeReset = config.localToolResultCompression;
          resetConfigForSave = { ...DEFAULT_CONFIG };
          config = { ...DEFAULT_CONFIG, localToolResultCompression: modeBeforeReset };
          runtimeEnabled = false;
          disableProxyRouting();
          owner = "none";
          updateStatus(ctx, runtimeEnabled, owner, stats);
          const modeNotice = modeBeforeReset ? " Legacy local mode remains active until /reload." : " Native mode remains active until /reload.";
          ctx.ui.notify(`Headroom runtime config reset to defaults.${modeNotice} Use /headroom config save to persist.`, "info");
          if (config.startup === "auto") await restartManagedProxy(ctx);
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
