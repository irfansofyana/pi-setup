import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Rule } from "./types.ts";
import {
  HINDSIGHT_CONFIG_PATH,
  HindsightHttpClient,
  computeBankScope,
  computeMemoryScope,
  computeMemoryScopes,
  defaultHindsightConfig,
  readHindsightConfigFile,
  writeHindsightConfigFile,
  formatRecallResponse,
  formatReflectResponse,
  mergeRecallResponses,
  mergeReflectResponses,
  runHindsightEmbed,
  type HindsightConfigFile,
  type RetainItem,
} from "./client.ts";
import { redactSecrets } from "./store.ts";
import {
  RULES_DIR,
  buildRuleFromMarkdown,
  builtinDefaultRules,
  discoverRules,
  parseFrontmatter,
  splitBuckets,
} from "./rules.ts";

export {
  HINDSIGHT_CONFIG_PATH,
  HindsightHttpClient,
  computeBankScope,
  computeMemoryScope,
  computeMemoryScopes,
  defaultHindsightConfig,
  readHindsightConfigFile,
  writeHindsightConfigFile,
  formatRecallResponse,
  formatReflectResponse,
  mergeRecallResponses,
  mergeReflectResponses,
  runHindsightEmbed,
  RULES_DIR,
  buildRuleFromMarkdown,
  builtinDefaultRules,
  discoverRules,
  parseFrontmatter,
  redactSecrets,
  splitBuckets,
};

const MAX_RULE_BODY_CHARS = 1000;
const MAX_RULEBOOK_CHARS = 6000;
const STATUS_ID = "hindsight";

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function expandBraces(glob: string): string[] {
  const match = /\{([^{}]+)\}/.exec(glob);
  if (!match) return [glob];
  return match[1].split(",").flatMap((part) => expandBraces(`${glob.slice(0, match.index)}${part}${glob.slice(match.index + match[0].length)}`));
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const next = glob[i + 1];
    const after = glob[i + 2];
    if (char === "*" && next === "*" && after === "/") {
      pattern += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && next === "*") {
      pattern += ".*";
      i += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function ruleMatchesGlobs(rule: Pick<Rule, "globs">, paths: string[] = []): boolean {
  if (!rule.globs?.length) return true;
  return paths.some((path) => rule.globs!.some((glob) => expandBraces(glob).some((expandedGlob) => {
    const cleanPath = path.replace(/\\/g, "/");
    const cleanGlob = expandedGlob.replace(/\\/g, "/");
    const matcher = globToRegExp(cleanGlob);
    const basename = cleanPath.split("/").pop() ?? cleanPath;
    return matcher.test(cleanPath) || (!cleanGlob.includes("/") && matcher.test(basename));
  })));
}

function pathsFrom(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(pathsFrom);
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  return ["path", "file", "filename", "cwd", "target", "uri"].flatMap((key) => pathsFrom(obj[key]));
}

export function rulebookPromptBlock(rules: Rule[], paths: string[] = []): string {
  const buckets = splitBuckets(rules.filter((rule) => ruleMatchesGlobs(rule, paths)));
  const lines: string[] = [];
  if (buckets.alwaysApply.length) {
    lines.push("Hindsight always-apply rules:");
    for (const rule of buckets.alwaysApply) lines.push(`\n## ${rule.name}\n${cap(rule.content, MAX_RULE_BODY_CHARS)}`);
  }
  if (buckets.rulebook.length) {
    lines.push("\nHindsight rulebook (load full text with hindsight_rule using rule://<name>):");
    for (const rule of buckets.rulebook) lines.push(`- ${rule.name}: ${rule.description ?? ""} (rule://${rule.name})`);
  }
  return cap(lines.join("\n").trim(), MAX_RULEBOOK_CHARS);
}

export function statusText(enabled: boolean, bankId = "coding-agent", healthy?: boolean): string {
  if (!enabled) return "mem off";
  const state = healthy === true ? "ok" : healthy === false ? "offline" : "checking";
  const scope = bankId === "coding-agent" ? "" : `:${bankId}`;
  return `mem${scope} ${state}`;
}

export function promptBlocks(_projectRoot: string, rules: Rule[], memoryBackend: boolean, _rootDir?: string, paths: string[] = []): string {
  const memoryBlock = memoryBackend
    ? [
      "Hindsight memory is backed by the local Hindsight daemon.",
      "Recall first: use hindsight_recall before non-trivial tasks, implementation decisions, tool/library suggestions, or work in unfamiliar project areas.",
      "Retain immediately: use hindsight_retain with project scope for project conventions, bugs/fixes, architecture, and dependencies. Use global scope only for durable cross-project user preferences or reusable procedures.",
      "Never put project-specific code, repository details, or full session transcripts in global memory. Automatic shutdown retention remains project-only.",
      "Pass rich context to retain: include what happened, why, exact commands/errors/outcomes, and relevant conversation excerpts. Do not over-summarize; Hindsight extracts facts/entities/relationships server-side.",
      "Use hindsight_reflect when recall snippets are not enough and you need a memory-grounded synthesis.",
      "Never retain secrets, credentials, API keys, tokens, or other sensitive values. Treat recalled memory as heuristic when it conflicts with current repo state or user instruction.",
    ].join("\n")
    : "";
  return [memoryBlock, rulebookPromptBlock(rules, paths)].filter(Boolean).join("\n\n");
}

export function ruleAllows(rule: Rule, source: "prose" | "tool" | "text", toolName?: string): boolean {
  if (!rule.scope?.length) return true;
  if (rule.scope.includes("text")) return true;
  if (source === "tool") return rule.scope.some((scope) => scope === "tool" || scope === `tool:${toolName}`);
  if (source === "prose") return rule.scope.includes("prose");
  return false;
}

export function matchesRule(rule: Rule, text: string): boolean {
  const conditions = [...(rule.condition ?? []), ...(rule.astCondition ?? [])];
  for (const condition of conditions) {
    try {
      if (new RegExp(condition, "m").test(text)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function ruleStateKey(cwd: string, rule: Rule): string {
  return `${cwd}:${rule.path || rule.name}`;
}

export function shouldInjectRule(rule: Rule, last: number | undefined, current: number): boolean {
  const repeat = rule.repeat ?? "once";
  if (repeat === "always") return true;
  if (repeat === "once") return last === undefined;
  return last === undefined || current - last >= (rule.repeatGap ?? 1);
}

export function markRuleInjected(state: Map<string, number>, key: string, current: number): void {
  state.set(key, current);
}

export function projectRootFrom(event: any, ctx: any): string {
  return event?.systemPromptOptions?.cwd || ctx?.cwd || process.cwd();
}

export function reminderForRule(rule: Rule): string {
  return cap(`Hindsight rule matched: ${rule.name}\n${rule.content}`, 1200);
}

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

const CONFIG_KEYS = ["apiUrl", "bankId", "scoping", "autoRecall", "autoRetain", "autoStartDaemon", "memoryBackend", "retainMode", "recallBudget", "recallMaxTokens", "requestTimeoutMs"] as const;
type ConfigKey = typeof CONFIG_KEYS[number];

function configFileFromRuntime(): HindsightConfigFile {
  return {
    apiUrl: configRef.apiUrl,
    bankId: configRef.bankId,
    scoping: configRef.scoping,
    autoRecall: configRef.autoRecall,
    autoRetain: configRef.autoRetain,
    autoStartDaemon: configRef.autoStartDaemon,
    memoryBackend: configRef.memoryBackend,
    retainMode: configRef.retainMode,
    recallBudget: configRef.recallBudget,
    recallMaxTokens: configRef.recallMaxTokens,
    requestTimeoutMs: configRef.requestTimeoutMs,
  };
}

function parseConfigValue(key: ConfigKey, raw: string): HindsightConfigFile[ConfigKey] {
  if (["autoRecall", "autoRetain", "autoStartDaemon", "memoryBackend"].includes(key)) {
    if (!["true", "false"].includes(raw)) throw new Error(`${key} must be true or false.`);
    return raw === "true";
  }
  if (["recallMaxTokens", "requestTimeoutMs"].includes(key)) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number.`);
    return value;
  }
  if (key === "scoping" && !["global", "per-project", "per-project-tagged"].includes(raw)) throw new Error("scoping must be global, per-project, or per-project-tagged.");
  if (key === "retainMode" && !["full-session", "last-turn"].includes(raw)) throw new Error("retainMode must be full-session or last-turn.");
  if (key === "recallBudget" && !["low", "mid", "high"].includes(raw)) throw new Error("recallBudget must be low, mid, or high.");
  if (!raw.trim()) throw new Error(`${key} cannot be empty.`);
  return raw;
}

function envOverrideFor(key: ConfigKey): string | undefined {
  const envName = `HINDSIGHT_${key.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`;
  return process.env[envName] ? envName : undefined;
}

function reloadConfigRef(): void {
  Object.assign(configRef, defaultHindsightConfig());
}

export async function handleHindsightCommand(
  args: string,
  ctx: { cwd?: string; ui: { notify: (msg: string, kind: string) => void } },
  options: { beforeRecall?: () => void | Promise<void>; beforeClear?: (cwd: string) => void; statusMemory?: () => Promise<string>; clearMemory?: () => Promise<string>; recallMemory?: (query: string) => Promise<string> } = {},
): Promise<void> {
  const projectRoot = ctx.cwd || process.cwd();
  const trimmed = args.trim();
  const [command = "", ...rest] = trimmed.split(/\s+/);
  const sub = rest[0] ?? "";

  if (command === "view") {
    const { apiToken: _apiToken, ...safeConfig } = configRef;
    ctx.ui.notify(JSON.stringify({ ...safeConfig, apiToken: configRef.apiToken ? "[REDACTED]" : undefined }, null, 2), "info");
    return;
  }
  if (command === "config") {
    const action = sub || "show";
    try {
      if (action === "show") {
        const fileConfig = readHindsightConfigFile();
        const { apiToken: _apiToken, ...safeConfig } = configRef;
        ctx.ui.notify(JSON.stringify({ path: process.env.HINDSIGHT_CONFIG_PATH || HINDSIGHT_CONFIG_PATH, file: fileConfig, runtime: { ...safeConfig, apiToken: configRef.apiToken ? "[REDACTED]" : undefined } }, null, 2), "info");
        return;
      }
      if (action === "save") {
        const path = writeHindsightConfigFile(configFileFromRuntime());
        ctx.ui.notify(`Hindsight config saved to ${path}.`, "info");
        return;
      }
      if (action === "reset") {
        const path = writeHindsightConfigFile({});
        reloadConfigRef();
        ctx.ui.notify(`Hindsight config reset at ${path}. Runtime reloaded from defaults/env.`, "info");
        return;
      }
      if (action === "set") {
        const key = rest[1] as ConfigKey | undefined;
        const rawValue = rest.slice(2).join(" ").trim();
        if (!key || !CONFIG_KEYS.includes(key) || !rawValue) throw new Error(`Usage: /hindsight config set <${CONFIG_KEYS.join("|")}> <value>`);
        const nextConfig = { ...readHindsightConfigFile(), [key]: parseConfigValue(key, rawValue) };
        const path = writeHindsightConfigFile(nextConfig);
        reloadConfigRef();
        const override = envOverrideFor(key);
        const overrideNote = override ? ` ${override} overrides this key until Pi restarts without that env var.` : "";
        ctx.ui.notify(`Hindsight config updated: ${key}=${JSON.stringify(nextConfig[key])} (${path}).${overrideNote}`, override ? "warning" : "info");
        return;
      }
    } catch (error) {
      ctx.ui.notify(`hindsight config failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }
  }
  if (command === "stats") {
    ensureRules(projectRoot);
    const scope = computeBankScope(configRef, projectRoot);
    const status = options.statusMemory ? await options.statusMemory().catch((error) => `hindsight: ${error instanceof Error ? error.message : String(error)}`) : "hindsight: status unavailable in test harness";
    ctx.ui.notify([`hindsight api: ${configRef.apiUrl}`, `config path: ${process.env.HINDSIGHT_CONFIG_PATH || HINDSIGHT_CONFIG_PATH}`, `bank: ${scope.bankId}`, `tags: ${scope.tags?.join(",") || "(none)"}`, status, bucketsSummary()].join("\n"), "info");
    return;
  }
  if (command === "diagnose") {
    try {
      ensureRules(projectRoot);
      const buckets = splitBuckets(ruleCacheRef);
      const scope = computeBankScope(configRef, projectRoot);
      const daemon = options.statusMemory ? await options.statusMemory() : await runHindsightEmbed(["daemon", "status"], 30_000).catch((error) => `daemon status failed: ${error instanceof Error ? error.message : String(error)}\nRun: uvx hindsight-embed@latest configure`);
      ctx.ui.notify([
        `project dir: ${projectRoot}`,
        `hindsight api: ${configRef.apiUrl}`,
        `config path: ${process.env.HINDSIGHT_CONFIG_PATH || HINDSIGHT_CONFIG_PATH}`,
        `bank: ${scope.bankId}`,
        `scoping: ${configRef.scoping}`,
        `tags: ${scope.tags?.join(",") || "(none)"}`,
        `rules: ${ruleCacheRef.length}`,
        `ttsr: ${buckets.ttsr.length}`,
        `alwaysApply: ${buckets.alwaysApply.length}`,
        `rulebook: ${buckets.rulebook.length}`,
        `memoryBackend: ${configRef.memoryBackend}`,
        `autoRecall: ${configRef.autoRecall}`,
        `autoRetain: ${configRef.autoRetain}`,
        `native rules dir: ${RULES_DIR}`,
        daemon,
      ].join("\n"), "info");
    } catch (error) {
      ctx.ui.notify(`hindsight diagnose failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return;
  }
  if (command === "clear") {
    options.beforeClear?.(projectRoot);
    if (!options.clearMemory) {
      ctx.ui.notify("clear requires real Hindsight client; use Hindsight UI or delete the scoped bank.", "warning");
      return;
    }
    try {
      ctx.ui.notify(await options.clearMemory(), "info");
    } catch (error) {
      ctx.ui.notify(`hindsight clear failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return;
  }
  if (command === "recall") {
    const query = rest.join(" ").trim();
    try {
      await options.beforeRecall?.();
      const text = options.recallMemory ? await options.recallMemory(query) : "real Hindsight recall unavailable in test harness";
      ctx.ui.notify(text || "No relevant hindsight memories.", "info");
    } catch (error) {
      ctx.ui.notify(`hindsight recall failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return;
  }
  if (command === "memory") {
    if (sub === "enable") {
      memoryBackendByCwd.set(projectRoot, true);
      ctx.ui.notify("memory backend enabled for this project.", "info");
      return;
    }
    if (sub === "disable") {
      memoryBackendByCwd.set(projectRoot, false);
      autoRecallInjectedByCwd.delete(projectRoot);
      ctx.ui.notify("memory backend disabled for this project.", "info");
      return;
    }
  }
  ctx.ui.notify("Usage: /hindsight view|stats|diagnose|clear|recall <query>|memory enable|disable|config show|config set <key> <value>|config save|config reset", "warning");
}

export function handleRulesCommand(args: string, ctx: { cwd?: string; ui: { notify: (msg: string, kind: string) => void } }): void {
  const projectRoot = ctx.cwd || process.cwd();
  const trimmed = args.trim();
  const [command = "", ...rest] = trimmed.split(/\s+/);
  const name = rest.join(" ").trim();

  if (command === "list") {
    refreshRules(projectRoot);
    const buckets = splitBuckets(ruleCacheRef);
    const bucketByName = new Map<string, string>();
    for (const [bucket, rules] of Object.entries(buckets)) for (const rule of rules) bucketByName.set(rule.name, bucket);
    ctx.ui.notify(ruleCacheRef.map((rule) => `${rule.name} [${rule.provider}] ${bucketByName.get(rule.name) ?? "ignored"}`).join("\n") || "(no rules)", "info");
    return;
  }
  if (command === "reload") {
    refreshRules(projectRoot);
    ctx.ui.notify(`reloaded rules: ${ruleCacheRef.length}`, "info");
    return;
  }
  if (command === "show") {
    ensureRules(projectRoot);
    const rule = ruleCacheRef.find((entry) => entry.name === name);
    ctx.ui.notify(rule ? rule.content : `rule "${name}" not found.`, "info");
    return;
  }
  ctx.ui.notify("Usage: /rules list|reload|show <name>", "warning");
}

// Shared mutable state for command handlers (ref'd so exported handlers stay in sync with the closure).
const configRef = defaultHindsightConfig();
const memoryBackendByCwd = new Map<string, boolean>();
const autoRecallInjectedByCwd = new Set<string>();
const ruleCacheRef: Rule[] = discoverRules(RULES_DIR);
let ruleCacheCwd = "";

function refreshRules(cwd: string): void {
  ruleCacheRef.length = 0;
  ruleCacheRef.push(...discoverRules(cwd));
  ruleCacheCwd = cwd;
}

function ensureRules(cwd: string): void {
  if (ruleCacheCwd !== cwd) refreshRules(cwd);
}

function bucketsSummary(): string {
  const buckets = splitBuckets(ruleCacheRef);
  return [
    `ttsr: ${buckets.ttsr.length}`,
    `alwaysApply: ${buckets.alwaysApply.length}`,
    `rulebook: ${buckets.rulebook.length}`,
    `rules: ${ruleCacheRef.length}`,
  ].join("\n");
}

export default function hindsight(pi: ExtensionAPI) {
  const client = (pi as any).hindsightClient ?? new HindsightHttpClient(configRef);
  const skipAutoRetainAfterClear = new Set<string>();
  const MAX_AUTO_RETAIN_CHARS = 50_000;

  async function flushRetainQueue(): Promise<void> {
    // Real Hindsight explicit retains are synchronous; kept as hook seam for commands/tests.
  }

  async function recallFromMemoryScopes(projectRoot: string, scope: "project" | "global" | "all", query: string, options: any) {
    const scopes = computeMemoryScopes(configRef, projectRoot, scope);
    const responses = await Promise.all(scopes.map((bankScope) => client.recall(bankScope, query, options)));
    return mergeRecallResponses(responses);
  }

  async function reflectFromMemoryScopes(projectRoot: string, scope: "project" | "global" | "all", query: string, options: any) {
    if (configRef.scoping === "per-project" && scope === "all") {
      throw new Error("Hindsight native cross-bank joint reflection is unavailable with scoping 'per-project' and scope 'all'. Use scope 'project' or 'global', or migrate with `/hindsight config set scoping per-project-tagged`; `per-project-tagged` is required for genuine project+global synthesis.");
    }
    const scopes = computeMemoryScopes(configRef, projectRoot, scope);
    const responses = await Promise.all(scopes.map((bankScope) => client.reflect(bankScope, query, options)));
    return mergeReflectResponses(responses);
  }

  function memoryEnabled(cwd: string): boolean {
    return memoryBackendByCwd.get(cwd) ?? configRef.memoryBackend;
  }

  function clearRuntimeMemory(cwd: string): void {
    skipAutoRetainAfterClear.add(cwd);
    autoRecallInjectedByCwd.delete(cwd);
  }

  function updateStatus(ctx: any, projectRoot: string, healthy?: boolean): void {
    if (!ctx?.hasUI || typeof ctx?.ui?.setStatus !== "function") return;
    const scope = computeBankScope(configRef, projectRoot);
    ctx.ui.setStatus(STATUS_ID, statusText(memoryEnabled(projectRoot), scope.bankId, healthy));
  }

  async function refreshStatus(ctx: any, projectRoot: string): Promise<void> {
    updateStatus(ctx, projectRoot);
    try {
      await client.health(ctx?.signal);
      updateStatus(ctx, projectRoot, true);
    } catch {
      updateStatus(ctx, projectRoot, false);
    }
  }

  function textFrom(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
    if (!value || typeof value !== "object") return "";
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (Array.isArray(obj.content)) return obj.content.map(textFrom).filter(Boolean).join("\n");
    if ("message" in obj) return textFrom(obj.message);
    return "";
  }

  function sessionTranscript(ctx: any): string {
    try {
      const allEntries = ctx?.sessionManager?.getEntries?.() ?? [];
      const entries = configRef.retainMode === "last-turn" ? allEntries.slice(-2) : allEntries;
      const text = entries
        .map((entry: any) => `${entry?.role ?? entry?.type ?? "entry"}: ${textFrom(entry)}`.trim())
        .filter((line: string) => line && !line.endsWith(":"))
        .join("\n");
      return redactSecrets(text).slice(-MAX_AUTO_RETAIN_CHARS);
    } catch {
      return "";
    }
  }

  function queryFromMessages(messages: unknown): string {
    if (!Array.isArray(messages)) return "";
    return messages
      .filter((message: any) => ["user", "custom", "toolResult"].includes(String(message?.role ?? message?.type)))
      .slice(-3)
      .map(textFrom)
      .filter(Boolean)
      .join("\n")
      .slice(-2000);
  }

  function customMemoryMessage(text: string): object {
    return { role: "custom", customType: "hindsight-recall", content: text, display: false, timestamp: Date.now() };
  }

  const injectedRules = new Map<string, number>();
  let ruleAttemptCounter = 0;

  function ttsrRules(cwd: string): Rule[] {
    refreshRules(cwd);
    return splitBuckets(ruleCacheRef).ttsr;
  }

  function firstTtsrMatch(cwd: string, text: string, source: "prose" | "tool" | "text", modes: Rule["interruptMode"][], toolName?: string, paths: string[] = []): Rule | undefined {
    const currentAttempt = ++ruleAttemptCounter;
    for (const rule of ttsrRules(cwd)) {
      const mode = rule.interruptMode ?? "always";
      const key = ruleStateKey(cwd, rule);
      if (!modes.includes(mode) || !ruleMatchesGlobs(rule, paths) || !ruleAllows(rule, source, toolName) || !matchesRule(rule, text) || !shouldInjectRule(rule, injectedRules.get(key), currentAttempt)) continue;
      markRuleInjected(injectedRules, key, currentAttempt);
      return rule;
    }
    return undefined;
  }

  function prependReminder(content: unknown, reminder: string): unknown | undefined {
    if (typeof content === "string") return `${reminder}\n\n${content}`;
    if (!Array.isArray(content)) return undefined;
    const copy = [...content];
    const index = copy.findIndex((item: any) => item?.type === "text" && typeof item.text === "string");
    if (index < 0) return undefined;
    copy[index] = { ...(copy[index] as object), text: `${reminder}\n\n${(copy[index] as any).text}` };
    return copy;
  }

  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description: "Persist a project or durable cross-project memory note.",
    promptSnippet: "Save a durable memory note in project scope by default, or global scope when explicitly appropriate.",
    promptGuidelines: [
      "Use hindsight_retain immediately after learning durable user preferences, project conventions, procedure outcomes, bugs/fixes, workarounds, architecture decisions, or dependency/version requirements.",
      "Pass rich full context: what happened, why, commands/errors/outcomes, and relevant conversation excerpts. Do not pre-summarize aggressively; Hindsight extracts facts server-side.",
      "Use global scope only for durable cross-project facts, user preferences, or reusable procedures; never for project-specific code or full transcripts.",
      "Never retain secrets, credentials, API keys, tokens, or sensitive values.",
    ],
    parameters: Schema.Object({
      text: Schema.String({ description: "Rich memory content to retain, including observations, commands/errors, rationale, outcomes, or conversation excerpts." }),
      category: Schema.Optional(Schema.String({ description: "Optional context label such as preferences, procedures, learnings, decisions, bugs, or workarounds." })),
      scope: Schema.Optional(Schema.String({ enum: ["project", "global"], description: "Memory scope. Defaults to project; use global only for durable cross-project facts/preferences/procedures." })),
    }) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { text, category, scope = "project" } = params as { text: string; category?: string; scope?: "project" | "global" };
      const projectRoot = ctx.cwd || process.cwd();
      await client.retain(computeMemoryScope(configRef, projectRoot, scope), [{
        content: text,
        context: category ?? "agent-retain",
        metadata: { source: "pi-hindsight", category: category ?? "general", scope, ...(scope === "project" ? { project: projectRoot } : {}) },
        timestamp: new Date().toISOString(),
      }], { async: false, signal: _signal });
      return {
        content: [{ type: "text", text: `Retained memory in Hindsight (scope: ${scope}).` }],
        details: { category: category ?? "general", scope, retained: true, backend: "hindsight" },
      };
    },
  });

  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: "Recall relevant memories from the local Hindsight daemon.",
    promptSnippet: "Recall memories matching a query from Hindsight.",
    promptGuidelines: [
      "Use hindsight_recall before non-trivial tasks, implementation decisions, tool/library suggestions, or work in unfamiliar project areas.",
      "Prefer current repo state and explicit user instruction when recalled memory conflicts.",
    ],
    parameters: Schema.Object({
      query: Schema.String({ description: "Query to match against memories." }),
      budget: Schema.Optional(Schema.String({ description: "Recall budget: low, mid, or high." })),
      scope: Schema.Optional(Schema.String({ enum: ["project", "global", "all"], description: "Recall scope: exact current project, exact untagged global, or the safe combination of current-project plus global memories. Defaults to all." })),
    }) as any,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { query, budget, scope = "all" } = params as { query: string; budget?: "low" | "mid" | "high"; scope?: "project" | "global" | "all" };
      const projectRoot = ctx.cwd || process.cwd();
      await flushRetainQueue();
      const response = await recallFromMemoryScopes(projectRoot, scope, query, { budget: budget || configRef.recallBudget, maxTokens: configRef.recallMaxTokens, signal });
      return {
        content: [{ type: "text", text: formatRecallResponse(response) || "No relevant hindsight memories." }],
      };
    },
  });

  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description: "Ask Hindsight for a memory-grounded answer. In separate-bank per-project scoping, scope all is unavailable; use per-project-tagged for joint project+global reflection.",
    promptSnippet: "Use Hindsight reflect for deeper reasoning over retained memories; joint project+global reflection requires per-project-tagged scoping.",
    promptGuidelines: [
      "Use hindsight_reflect when recall snippets are not enough and you need memory-grounded synthesis or task approach guidance.",
      "With legacy separate-bank per-project scoping, use project or global reflection separately; scope all fails closed because Hindsight has no native cross-bank joint reflection. Migrate to per-project-tagged for genuine project+global synthesis.",
    ],
    parameters: Schema.Object({
      query: Schema.String({ description: "Question for Hindsight reflect." }),
      context: Schema.Optional(Schema.String({ description: "Optional current task context." })),
      budget: Schema.Optional(Schema.String({ description: "Reflect budget: low, mid, or high." })),
      scope: Schema.Optional(Schema.String({ enum: ["project", "global", "all"], description: "Reflection scope. Defaults to all. Project and global work in every scoping mode; all performs genuine joint synthesis in a shared tagged bank, but fails closed with legacy separate-bank per-project scoping." })),
    }) as any,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { query, context, budget, scope = "all" } = params as { query: string; context?: string; budget?: "low" | "mid" | "high"; scope?: "project" | "global" | "all" };
      const projectRoot = ctx.cwd || process.cwd();
      await flushRetainQueue();
      const response = await reflectFromMemoryScopes(projectRoot, scope, query, { context, budget: budget || "low", signal });
      return { content: [{ type: "text", text: formatReflectResponse(response) }] };
    },
  });

  pi.registerTool({
    name: "hindsight_rule",
    label: "Hindsight Rule",
    description: "Show a rule's content by name from the rule cache.",
    promptSnippet: "Look up a rule's content by name.",
    promptGuidelines: ["Use hindsight_rule to surface a specific rule's body."],
    parameters: Schema.Object({
      name: Schema.String({ description: "Rule name (filename without extension)." }),
    }) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { name } = params as { name: string };
      ensureRules(ctx.cwd || process.cwd());
      const key = name.replace(/^rule:\/\//, "");
      const rule = ruleCacheRef.find((entry) => entry.name === key);
      if (!rule) return { content: [{ type: "text", text: `rule "${key}" not found.` }] };
      return { content: [{ type: "text", text: rule.content }] };
    },
  });

  pi.registerCommand("hindsight", {
    description: "Manage real Hindsight memory + Pi rules",
    handler: async (args, ctx) => handleHindsightCommand(args, ctx, {
      beforeRecall: flushRetainQueue,
      beforeClear: clearRuntimeMemory,
      statusMemory: async () => {
        const health = await client.health(ctx?.signal);
        updateStatus(ctx, ctx?.cwd || process.cwd(), true);
        return `hindsight health: ${JSON.stringify(health)}`;
      },
      clearMemory: async () => {
        const scope = computeBankScope(configRef, ctx?.cwd || process.cwd());
        if (configRef.scoping === "per-project-tagged") return "clear skipped: per-project-tagged uses shared bank; delete/curate tagged memories in Hindsight UI to avoid wiping other projects.";
        await client.clearMemories(scope, ctx?.signal);
        return `cleared Hindsight memories in bank ${scope.bankId}`;
      },
      recallMemory: async (query) => formatRecallResponse(await recallFromMemoryScopes(ctx?.cwd || process.cwd(), "all", query, { budget: configRef.recallBudget, maxTokens: configRef.recallMaxTokens, signal: ctx?.signal })),
    }),
  });

  pi.registerCommand("rules", {
    description: "Inspect hindsight rule cache",
    handler: async (args, ctx) => handleRulesCommand(args, ctx),
  });

  (pi as any).on?.("session_start", async (_event: any, ctx: any) => {
    const projectRoot = ctx?.cwd || process.cwd();
    void refreshStatus(ctx, projectRoot);
  });

  (pi as any).on?.("before_agent_start", async (event: any, ctx: any) => {
    const projectRoot = projectRootFrom(event, ctx);
    autoRecallInjectedByCwd.delete(projectRoot);
    refreshRules(projectRoot);
    void refreshStatus(ctx, projectRoot);
    const blocks = promptBlocks(projectRoot, ruleCacheRef, memoryEnabled(projectRoot));
    if (!blocks) return undefined;
    return { systemPrompt: `${event?.systemPrompt ?? ""}\n\n${blocks}` };
  });

  (pi as any).on?.("context", async (event: any, ctx: any) => {
    const projectRoot = ctx?.cwd || process.cwd();
    if (!memoryEnabled(projectRoot) || !configRef.autoRecall || autoRecallInjectedByCwd.has(projectRoot)) return;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const query = queryFromMessages(messages);
    await flushRetainQueue();
    try {
      const block = formatRecallResponse(await recallFromMemoryScopes(projectRoot, "all", query, { budget: configRef.recallBudget, maxTokens: configRef.recallMaxTokens, signal: ctx?.signal }));
      if (!block) return;
      autoRecallInjectedByCwd.add(projectRoot);
      return { messages: [customMemoryMessage(block), ...messages] };
    } catch {
      return;
    }
  });

  (pi as any).on?.("tool_result", async (event: any, ctx: any) => {
    try {
      const projectRoot = ctx?.cwd || process.cwd();
      const text = textFrom(event?.content ?? event?.result ?? event);
      if (!text) return;
      const rule = firstTtsrMatch(projectRoot, text, "tool", ["tool-only", "always", undefined], event?.toolName ?? event?.tool?.name ?? event?.name, pathsFrom(event?.input ?? event?.params ?? event));
      if (!rule) return;
      const reminder = reminderForRule(rule);
      const content = prependReminder(event?.content, reminder);
      if (!content) return;
      return { content, details: { ...(event?.details ?? {}), hindsightRule: rule.name } };
    } catch {
      return;
    }
  });

  (pi as any).on?.("tool_call", async (event: any, ctx: any) => {
    try {
      const projectRoot = ctx?.cwd || process.cwd();
      const text = JSON.stringify(event?.input ?? event?.params ?? event ?? {});
      const rule = firstTtsrMatch(projectRoot, text, "tool", ["tool-only", "always"], event?.toolName ?? event?.tool?.name ?? event?.name, pathsFrom(event?.input ?? event?.params ?? event));
      if (!rule) return;
      return { block: true, reason: reminderForRule(rule) };
    } catch {
      return;
    }
  });

  (pi as any).on?.("input", async (event: any, ctx: any) => {
    try {
      const projectRoot = ctx?.cwd || process.cwd();
      const text = textFrom(event?.text ?? event?.content ?? event?.message ?? event);
      const rule = firstTtsrMatch(projectRoot, text, "prose", ["prose-only", "always"]);
      if (!rule) return;
      const reminder = reminderForRule(rule);
      const message = { role: "custom", customType: "hindsight-rule", content: reminder, display: false, timestamp: Date.now() };
      if (typeof (pi as any).sendMessage === "function") {
        await (pi as any).sendMessage(message, { deliverAs: "steer", triggerTurn: true });
      } else if (typeof (pi as any).sendUserMessage === "function") {
        await (pi as any).sendUserMessage(reminder, { deliverAs: "steer", triggerTurn: true });
      }
    } catch {
      return;
    }
  });

  (pi as any).on?.("session_shutdown", async (_event: any, ctx: any) => {
    try {
      const projectRoot = ctx?.cwd || process.cwd();
      await flushRetainQueue();
      if (skipAutoRetainAfterClear.delete(projectRoot)) return;
      if (!memoryEnabled(projectRoot) || !configRef.autoRetain) return;
      const text = sessionTranscript(ctx);
      if (text) await client.retain(computeMemoryScope(configRef, projectRoot, "project"), [{
        content: text,
        context: "pi session transcript",
        metadata: { source: "pi-session", project: projectRoot },
        timestamp: new Date().toISOString(),
      }], { async: true, signal: ctx?.signal });
    } catch {
      // shutdown must never throw
    }
  });
}
