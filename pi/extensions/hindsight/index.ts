import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryEntry, Rule } from "./types.ts";
import {
  HINDSIGHT_DIR,
  appendMemory,
  clearMemories,
  dedupMemories,
  ensureDirs,
  jaccard,
  loadMemories,
  makeMemoryEntry,
  memoriesPath,
  memoryDocPath,
  memoryGuidanceBlock,
  memorySourceText,
  memorySummaryBlock,
  memorySummaryPath,
  readMemoryUrl,
  readTextFile,
  skillsDir,
  writeMemoryArtifacts,
  formatMemoryBlock,
  projectBasename,
  projectDir,
  projectKey,
  redactSecrets,
  searchMemories,
} from "./store.ts";
import {
  RULES_DIR,
  buildRuleFromMarkdown,
  builtinDefaultRules,
  discoverRules,
  parseFrontmatter,
  splitBuckets,
} from "./rules.ts";

export {
  HINDSIGHT_DIR,
  RULES_DIR,
  appendMemory,
  buildRuleFromMarkdown,
  builtinDefaultRules,
  clearMemories,
  dedupMemories,
  discoverRules,
  ensureDirs,
  jaccard,
  loadMemories,
  makeMemoryEntry,
  memoriesPath,
  memoryDocPath,
  memoryGuidanceBlock,
  memorySourceText,
  memorySummaryBlock,
  memorySummaryPath,
  readMemoryUrl,
  readTextFile,
  skillsDir,
  writeMemoryArtifacts,
  formatMemoryBlock,
  parseFrontmatter,
  projectBasename,
  projectDir,
  projectKey,
  redactSecrets,
  searchMemories,
  splitBuckets,
};

const MAX_RULE_BODY_CHARS = 1000;
const MAX_RULEBOOK_CHARS = 6000;

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function rulebookPromptBlock(rules: Rule[]): string {
  const buckets = splitBuckets(rules);
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

export function promptBlocks(projectRoot: string, rules: Rule[], memoryBackend: boolean, rootDir?: string): string {
  const summaryBlock = memoryBackend ? memorySummaryBlock(projectRoot, rootDir) : "";
  const memoryBlock = memoryBackend ? (summaryBlock || memoryGuidanceBlock(projectRoot)) : "";
  return [memoryBlock, rulebookPromptBlock(rules)].filter(Boolean).join("\n\n");
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

function modelTextFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(modelTextFrom).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) return obj.content.map(modelTextFrom).filter(Boolean).join("\n");
  if ("message" in obj) return modelTextFrom(obj.message);
  if ("choices" in obj) return modelTextFrom(obj.choices);
  return "";
}

export async function completeWithModel(ctx: any, prompt: string, maxTokens = 4096): Promise<string | undefined> {
  try {
    const model = ctx?.model ?? ctx?.modelRegistry?.find?.("google", "gemini-2.5-flash");
    if (!model || !ctx?.modelRegistry?.getApiKeyAndHeaders) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    const apiKey = auth?.apiKey;
    const headers = auth?.headers;
    const env = auth?.env;
    if (!apiKey && !headers) return undefined;
    const { complete } = await import("@earendil-works/pi-ai/compat");
    const result = await complete(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      { apiKey, headers, env, maxTokens, signal: ctx?.signal },
    );
    return modelTextFrom(result).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function deterministicMemory(cwd: string): { memoryDoc: string; summary: string } {
  const source = memorySourceText(cwd);
  if (!source) return { memoryDoc: "# MEMORY\n\nNo retained memories yet.", summary: "No retained memories yet." };
  const bullets = source
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("## "))
    .slice(0, 80)
    .map((line) => `- ${cap(line, 500)}`);
  return {
    memoryDoc: ["# MEMORY", "", "## Retained facts", ...bullets].join("\n"),
    summary: bullets.slice(0, 20).join("\n") || "No retained memories yet.",
  };
}

function extractMarked(text: string, marker: string): string | undefined {
  const match = text.match(new RegExp(`${marker}\\s*([\\s\\S]*?)(?=\\n---[A-Z_]+---|$)`));
  return match?.[1]?.trim();
}

export async function rebuildAutonomousMemory(ctx: any): Promise<{ usedModel: boolean; memoryDoc: string; summary: string }> {
  const projectRoot = ctx?.cwd || process.cwd();
  const source = memorySourceText(projectRoot);
  if (!source) {
    const empty = { usedModel: false, memoryDoc: "# MEMORY\n\nNo retained memories yet.", summary: "No retained memories yet." };
    writeMemoryArtifacts(projectRoot, empty.memoryDoc, empty.summary);
    return empty;
  }

  const extractionPrompt = [
    "Extract durable project memory from retained sessions/facts.",
    "Keep only technical decisions, constraints, resolved failures, and recurring workflows. Drop chatter and stale guesses.",
    "Source corpus:",
    source,
  ].join("\n\n");
  const extracted = await completeWithModel(ctx, extractionPrompt, 4096);
  if (extracted) {
    const memoryDoc = await completeWithModel(ctx, ["Write MEMORY.md from this durable knowledge. Use concise markdown.", extracted].join("\n\n"), 4096);
    const summary = await completeWithModel(ctx, ["Write compact memory_summary.md for session-start injection. Include only high-signal bullets.", memoryDoc || extracted].join("\n\n"), 1024);
    if (memoryDoc && summary) {
      writeMemoryArtifacts(projectRoot, memoryDoc, summary);
      return { usedModel: true, memoryDoc, summary };
    }
    const combined = await completeWithModel(
      ctx,
      [
        "Consolidate into two artifacts. Return exactly:",
        "---MEMORY_MD---",
        "# MEMORY ...",
        "---SUMMARY_MD---",
        "compact bullets ...",
        extracted,
      ].join("\n\n"),
      4096,
    );
    const markedMemory = combined ? extractMarked(combined, "---MEMORY_MD---") : undefined;
    const markedSummary = combined ? extractMarked(combined, "---SUMMARY_MD---") : undefined;
    if (markedMemory && markedSummary) {
      writeMemoryArtifacts(projectRoot, markedMemory, markedSummary);
      return { usedModel: true, memoryDoc: markedMemory, summary: markedSummary };
    }
  }

  const fallback = deterministicMemory(projectRoot);
  writeMemoryArtifacts(projectRoot, fallback.memoryDoc, fallback.summary);
  return { usedModel: false, ...fallback };
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
  options: { beforeRecall?: () => void; rebuildMemory?: () => Promise<string>; enqueueMemory?: () => void } = {},
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
    const memories = loadMemories(projectRoot);
    const artifacts = [
      `MEMORY.md: ${readTextFile(memoryDocPath(projectRoot)) === undefined ? "missing" : "present"}`,
      `memory_summary.md: ${readTextFile(memorySummaryPath(projectRoot)) === undefined ? "missing" : "present"}`,
    ].join("\n");
    ctx.ui.notify(`memories: ${memories.length}\nrules: ${ruleCacheRef.length}\n${artifacts}\n${bucketsSummary()}`, "info");
    return;
  }
  if (command === "diagnose") {
    try {
      ensureRules(projectRoot);
      const buckets = splitBuckets(ruleCacheRef);
      ctx.ui.notify([
        `project dir: ${projectRoot}`,
        `memories path: ${memoriesPath(projectRoot)}`,
        `MEMORY.md: ${readTextFile(memoryDocPath(projectRoot)) === undefined ? "missing" : "present"}`,
        `memory_summary.md: ${readTextFile(memorySummaryPath(projectRoot)) === undefined ? "missing" : "present"}`,
        `rules: ${ruleCacheRef.length}`,
        `ttsr: ${buckets.ttsr.length}`,
        `alwaysApply: ${buckets.alwaysApply.length}`,
        `rulebook: ${buckets.rulebook.length}`,
        `memoryBackend: ${configRef.memoryBackend}`,
        `autoRecall: ${configRef.autoRecall}`,
        `autoRetain: ${configRef.autoRetain}`,
        `native rules dir: ${RULES_DIR}`,
      ].join("\n"), "info");
    } catch (error) {
      ctx.ui.notify(`hindsight diagnose failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return;
  }
  if (command === "clear") {
    clearMemories(projectRoot);
    ctx.ui.notify("hindsight memories cleared.", "info");
    return;
  }
  if (command === "rebuild") {
    try {
      refreshRules(ctx.cwd || process.cwd());
      const memory = options.rebuildMemory ? await options.rebuildMemory() : "memory rebuild unavailable";
      ctx.ui.notify(`rebuilt rules: ${ruleCacheRef.length}\n${memory}`, "info");
    } catch (error) {
      ctx.ui.notify(`memory rebuild failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return;
  }
  if (command === "enqueue") {
    if (!options.enqueueMemory) {
      ctx.ui.notify("memory rebuild enqueue unavailable.", "warning");
      return;
    }
    try {
      options.enqueueMemory();
      ctx.ui.notify("memory rebuild queued.", "info");
    } catch (error) {
      ctx.ui.notify(`memory rebuild enqueue failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return;
  }
  if (command === "recall") {
    const query = rest.join(" ").trim();
    options.beforeRecall?.();
    ctx.ui.notify(formatMemoryBlock(searchMemories(projectRoot, query, 5)) || "No relevant hindsight memories.", "info");
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
  ctx.ui.notify("Usage: /hindsight view|stats|diagnose|clear|rebuild|enqueue|recall <query>|memory enable|disable", "warning");
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
const configRef = { autoRecall: true, autoRetain: true, memoryBackend: false as boolean };
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
  const retainQueue: Array<{ cwd: string; entry: MemoryEntry }> = [];
  let retainTimer: ReturnType<typeof setTimeout> | undefined;
  let autoRecallInjected = false;
  const MAX_RETAIN_BATCH = 16;
  const RETAIN_FLUSH_MS = 5000;
  const MAX_AUTO_RETAIN_CHARS = 50_000;

  function flushRetainQueue(): void {
    if (retainTimer) clearTimeout(retainTimer);
    retainTimer = undefined;
    const batch = retainQueue.splice(0);
    for (const item of batch) {
      try {
        appendMemory(item.cwd, item.entry);
      } catch {
        // shutdown/hooks must never throw
      }
    }
  }

  function queueRetain(cwd: string, entry: MemoryEntry): void {
    retainQueue.push({ cwd, entry });
    if (retainQueue.length >= MAX_RETAIN_BATCH) {
      flushRetainQueue();
      return;
    }
    retainTimer ??= setTimeout(flushRetainQueue, RETAIN_FLUSH_MS);
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

  function firstTtsrMatch(cwd: string, text: string, source: "prose" | "tool" | "text", modes: Rule["interruptMode"][], toolName?: string): Rule | undefined {
    const currentAttempt = ++ruleAttemptCounter;
    for (const rule of ttsrRules(cwd)) {
      const mode = rule.interruptMode ?? "always";
      const key = ruleStateKey(cwd, rule);
      if (!modes.includes(mode) || !ruleAllows(rule, source, toolName) || !matchesRule(rule, text) || !shouldInjectRule(rule, injectedRules.get(key), currentAttempt)) continue;
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
      const clean = redactSecrets(text);
      const entry = makeMemoryEntry(projectRoot, clean, category ?? "general", "retain");
      queueRetain(projectRoot, entry);
      return {
        content: [{ type: "text", text: `Queued retained memory ${entry.id}.` }],
        details: { id: entry.id, category: entry.category, queued: true },
      };
    },
  });

  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: "Recall relevant memories for a query (P1).",
    promptSnippet: "Recall memories matching a query (P1).",
    promptGuidelines: ["Use hindsight_recall to retrieve relevant local memories for current task context."],
    parameters: Schema.Object({
      query: Schema.String({ description: "Query to match against memories." }),
      limit: Schema.Optional(Schema.String({ description: "Max results (P1)." })),
    }) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { query, limit } = params as { query: string; limit?: string };
      const projectRoot = ctx.cwd || process.cwd();
      flushRetainQueue();
      const results = searchMemories(projectRoot, query, Number(limit) || 5);
      return {
        content: [{ type: "text", text: formatMemoryBlock(results) || "No relevant hindsight memories." }],
      };
    },
  });

  pi.registerTool({
    name: "hindsight_memory",
    label: "Hindsight Memory",
    description: "Browse the memory backend tree.",
    promptSnippet: "Browse hindsight memory tree with memory://root paths.",
    promptGuidelines: ["Use hindsight_memory to inspect MEMORY.md and memory_summary.md."],
    parameters: Schema.Object({
      path: Schema.Optional(Schema.String({ description: "memory:// path (default memory://root)." })),
    }) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path } = params as { path?: string };
      return {
        content: [{ type: "text", text: readMemoryUrl(ctx?.cwd || process.cwd(), path || "memory://root") }],
      };
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
    description: "Manage hindsight memory + OMP-style rules",
    handler: async (args, ctx) => handleHindsightCommand(args, ctx, {
      beforeRecall: flushRetainQueue,
      rebuildMemory: async () => {
        const result = await rebuildAutonomousMemory(ctx);
        return `rebuilt memory: ${result.usedModel ? "model" : "deterministic fallback"}`;
      },
      enqueueMemory: () => {
        void rebuildAutonomousMemory(ctx).catch((error) => ctx?.ui?.notify?.(`hindsight memory rebuild failed: ${error?.message ?? error}`, "warning"));
      },
    }),
  });

  pi.registerCommand("rules", {
    description: "Inspect hindsight rule cache",
    handler: async (args, ctx) => handleRulesCommand(args, ctx),
  });

  (pi as any).on?.("session_start", async (_event: any, ctx: any) => {
    try {
      if (!configRef.memoryBackend) return;
      void rebuildAutonomousMemory(ctx).catch((error) => ctx?.ui?.notify?.(`hindsight memory rebuild failed: ${error?.message ?? error}`, "warning"));
    } catch {
      return;
    }
  });

  (pi as any).on?.("before_agent_start", async (event: any, ctx: any) => {
    const projectRoot = projectRootFrom(event, ctx);
    autoRecallInjected = false;
    refreshRules(projectRoot);
    const blocks = promptBlocks(projectRoot, ruleCacheRef, configRef.memoryBackend);
    if (!blocks) return undefined;
    return { systemPrompt: `${event?.systemPrompt ?? ""}\n\n${blocks}` };
  });

  (pi as any).on?.("context", async (event: any, ctx: any) => {
    if (!configRef.autoRecall || autoRecallInjected) return;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const query = queryFromMessages(messages);
    flushRetainQueue();
    const block = formatMemoryBlock(searchMemories(ctx?.cwd || process.cwd(), query, 5));
    if (!block) return;
    autoRecallInjected = true;
    return { messages: [customMemoryMessage(block), ...messages] };
  });

  (pi as any).on?.("tool_result", async (event: any, ctx: any) => {
    try {
      const projectRoot = ctx?.cwd || process.cwd();
      const text = textFrom(event?.content ?? event?.result ?? event);
      if (!text) return;
      const rule = firstTtsrMatch(projectRoot, text, "tool", ["tool-only", "always", undefined], event?.toolName ?? event?.tool?.name ?? event?.name);
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
      const rule = firstTtsrMatch(projectRoot, text, "tool", ["tool-only", "always"], event?.toolName ?? event?.tool?.name ?? event?.name);
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
      flushRetainQueue();
      if (!configRef.autoRetain) return;
      const text = sessionTranscript(ctx);
      if (text) appendMemory(projectRoot, makeMemoryEntry(projectRoot, text, "session", "auto-retain"));
    } catch {
      // shutdown must never throw
    }
  });
}
