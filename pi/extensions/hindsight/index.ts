import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Rule } from "./types.ts";
import {
  HindsightHttpClient,
  computeBankScope,
  defaultHindsightConfig,
  formatRecallResponse,
  formatReflectResponse,
  runHindsightEmbed,
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
  HindsightHttpClient,
  computeBankScope,
  defaultHindsightConfig,
  formatRecallResponse,
  formatReflectResponse,
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

export function promptBlocks(_projectRoot: string, rules: Rule[], memoryBackend: boolean, _rootDir?: string, paths: string[] = []): string {
  const memoryBlock = memoryBackend
    ? "Hindsight memory is backed by the local Hindsight daemon. Use hindsight_recall before relying on prior context, hindsight_retain for durable learnings, and hindsight_reflect for deeper memory-grounded answers. Treat recalled memory as heuristic when it conflicts with current repo state or user instruction."
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
    ctx.ui.notify(JSON.stringify(configRef, null, 2), "info");
    return;
  }
  if (command === "stats") {
    ensureRules(projectRoot);
    const scope = computeBankScope(configRef, projectRoot);
    const status = options.statusMemory ? await options.statusMemory().catch((error) => `hindsight: ${error instanceof Error ? error.message : String(error)}`) : "hindsight: status unavailable in test harness";
    ctx.ui.notify([`hindsight api: ${configRef.apiUrl}`, `bank: ${scope.bankId}`, `tags: ${scope.tags?.join(",") || "(none)"}`, status, bucketsSummary()].join("\n"), "info");
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
    ctx.ui.notify(await options.clearMemory(), "info");
    return;
  }
  if (command === "recall") {
    const query = rest.join(" ").trim();
    await options.beforeRecall?.();
    const text = options.recallMemory ? await options.recallMemory(query) : "real Hindsight recall unavailable in test harness";
    ctx.ui.notify(text || "No relevant hindsight memories.", "info");
    return;
  }
  if (command === "memory") {
    if (sub === "enable") {
      configRef.memoryBackend = true;
      ctx.ui.notify("memory backend enabled.", "info");
      return;
    }
    if (sub === "disable") {
      configRef.memoryBackend = false;
      ctx.ui.notify("memory backend disabled.", "info");
      return;
    }
  }
  ctx.ui.notify("Usage: /hindsight view|stats|diagnose|clear|recall <query>|memory enable|disable", "warning");
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
  const retainQueue: Array<{ cwd: string; item: RetainItem }> = [];
  const skipAutoRetainAfterClear = new Set<string>();
  let retainTimer: ReturnType<typeof setTimeout> | undefined;
  let autoRecallInjected = false;
  const MAX_RETAIN_BATCH = 16;
  const RETAIN_FLUSH_MS = 5000;
  const MAX_AUTO_RETAIN_CHARS = 50_000;

  async function flushRetainQueue(): Promise<void> {
    if (retainTimer) clearTimeout(retainTimer);
    retainTimer = undefined;
    const batch = retainQueue.splice(0);
    const byCwd = new Map<string, RetainItem[]>();
    for (const item of batch) byCwd.set(item.cwd, [...(byCwd.get(item.cwd) ?? []), item.item]);
    for (const [cwd, items] of byCwd) {
      try {
        await client.retain(computeBankScope(configRef, cwd), items, { async: true });
      } catch {
        // background memory must never break agent work
      }
    }
  }

  function dropRetainQueue(cwd: string): void {
    for (let i = retainQueue.length - 1; i >= 0; i--) {
      if (retainQueue[i]?.cwd === cwd) retainQueue.splice(i, 1);
    }
    if (retainQueue.length === 0 && retainTimer) {
      clearTimeout(retainTimer);
      retainTimer = undefined;
    }
  }

  function clearRuntimeMemory(cwd: string): void {
    dropRetainQueue(cwd);
    skipAutoRetainAfterClear.add(cwd);
  }

  function queueRetain(cwd: string, item: RetainItem): void {
    retainQueue.push({ cwd, item });
    if (retainQueue.length >= MAX_RETAIN_BATCH) {
      void flushRetainQueue();
      return;
    }
    retainTimer ??= setTimeout(() => void flushRetainQueue(), RETAIN_FLUSH_MS);
    retainTimer.unref?.();
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
      const entries = ctx?.sessionManager?.getEntries?.() ?? [];
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
    description: "Persist a memory note for the current project.",
    promptSnippet: "Save a durable memory note for the current project via hindsight.",
    promptGuidelines: ["Use hindsight_retain for facts worth keeping across sessions."],
    parameters: Schema.Object({
      text: Schema.String({ description: "Memory text to retain." }),
      category: Schema.Optional(Schema.String({ description: "Optional category tag." })),
    }) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { text, category } = params as { text: string; category?: string };
      const projectRoot = ctx.cwd || process.cwd();
      queueRetain(projectRoot, {
        content: text,
        context: category ?? "agent-retain",
        metadata: { source: "pi-hindsight", category: category ?? "general", project: projectRoot },
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: "Queued memory for Hindsight." }],
        details: { category: category ?? "general", queued: true, backend: "hindsight" },
      };
    },
  });

  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: "Recall relevant memories from the local Hindsight daemon.",
    promptSnippet: "Recall memories matching a query from Hindsight.",
    promptGuidelines: ["Use hindsight_recall before tasks where prior user/project context may matter."],
    parameters: Schema.Object({
      query: Schema.String({ description: "Query to match against memories." }),
      budget: Schema.Optional(Schema.String({ description: "Recall budget: low, mid, or high." })),
    }) as any,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { query, budget } = params as { query: string; budget?: "low" | "mid" | "high" };
      const projectRoot = ctx.cwd || process.cwd();
      await flushRetainQueue();
      const response = await client.recall(computeBankScope(configRef, projectRoot), query, { budget: budget || configRef.recallBudget, maxTokens: configRef.recallMaxTokens, signal });
      return {
        content: [{ type: "text", text: formatRecallResponse(response) || "No relevant hindsight memories." }],
      };
    },
  });

  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description: "Ask Hindsight for a memory-grounded answer.",
    promptSnippet: "Use Hindsight reflect for deeper reasoning over retained memories.",
    promptGuidelines: ["Use hindsight_reflect when recall snippets are not enough and a memory-grounded answer is useful."],
    parameters: Schema.Object({
      query: Schema.String({ description: "Question for Hindsight reflect." }),
      context: Schema.Optional(Schema.String({ description: "Optional current task context." })),
      budget: Schema.Optional(Schema.String({ description: "Reflect budget: low, mid, or high." })),
    }) as any,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { query, context, budget } = params as { query: string; context?: string; budget?: "low" | "mid" | "high" };
      const projectRoot = ctx.cwd || process.cwd();
      await flushRetainQueue();
      const response = await client.reflect(computeBankScope(configRef, projectRoot), query, { context, budget: budget || "low", signal });
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
      beforeRebuild: flushRetainQueue,
      statusMemory: async () => `hindsight health: ${JSON.stringify(await client.health(ctx?.signal))}`,
      clearMemory: async () => {
        const scope = computeBankScope(configRef, ctx?.cwd || process.cwd());
        if (configRef.scoping === "per-project-tagged") return "clear skipped: per-project-tagged uses shared bank; delete/curate tagged memories in Hindsight UI to avoid wiping other projects.";
        await client.clearMemories(scope, ctx?.signal);
        return `cleared Hindsight memories in bank ${scope.bankId}`;
      },
      recallMemory: async (query) => formatRecallResponse(await client.recall(computeBankScope(configRef, ctx?.cwd || process.cwd()), query, { budget: configRef.recallBudget, maxTokens: configRef.recallMaxTokens, signal: ctx?.signal })),
    }),
  });

  pi.registerCommand("rules", {
    description: "Inspect hindsight rule cache",
    handler: async (args, ctx) => handleRulesCommand(args, ctx),
  });

  (pi as any).on?.("session_start", async () => undefined);

  (pi as any).on?.("before_agent_start", async (event: any, ctx: any) => {
    const projectRoot = projectRootFrom(event, ctx);
    autoRecallInjected = false;
    refreshRules(projectRoot);
    const blocks = promptBlocks(projectRoot, ruleCacheRef, configRef.memoryBackend);
    if (!blocks) return undefined;
    return { systemPrompt: `${event?.systemPrompt ?? ""}\n\n${blocks}` };
  });

  (pi as any).on?.("context", async (event: any, ctx: any) => {
    if (!configRef.memoryBackend || !configRef.autoRecall || autoRecallInjected) return;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const query = queryFromMessages(messages);
    await flushRetainQueue();
    try {
      const projectRoot = ctx?.cwd || process.cwd();
      const block = formatRecallResponse(await client.recall(computeBankScope(configRef, projectRoot), query, { budget: configRef.recallBudget, maxTokens: configRef.recallMaxTokens, signal: ctx?.signal }));
      if (!block) return;
      autoRecallInjected = true;
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
      if (!configRef.memoryBackend || !configRef.autoRetain) return;
      const text = sessionTranscript(ctx);
      if (text) await client.retain(computeBankScope(configRef, projectRoot), [{
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
