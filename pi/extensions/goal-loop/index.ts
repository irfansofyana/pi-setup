import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GoalStatus = "active" | "paused" | "complete" | "blocked" | "needs_user";
export type GoalDecision = "complete" | "continue" | "blocked" | "needs_user";
export type GoalCommand = "start" | "status" | "pause" | "resume" | "clear" | "edit" | "verify";

export interface GoalEvaluation {
  decision: GoalDecision;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export type GoalEvidenceKind = "note" | "verification" | "tool";
export type GoalEvidenceOutcome = "passed" | "failed" | "unknown";

export interface GoalEvidence {
  at: string;
  kind: GoalEvidenceKind;
  summary: string;
  command?: string;
  outcome?: GoalEvidenceOutcome;
}

export interface GoalEvidenceInput {
  kind: GoalEvidenceKind;
  summary: string;
  command?: string;
  outcome?: GoalEvidenceOutcome;
}

export interface GoalState {
  projectRoot: string;
  objective: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  turns: number;
  maxTurns: number;
  maxFailedVerificationAttempts: number;
  consecutiveFailedVerificationAttempts: number;
  lastEvaluation?: GoalEvaluation;
  verification: {
    commands: string[];
    lastResult?: string;
  };
  evidence: GoalEvidence[];
}

interface GoalStore {
  goals: Record<string, GoalState>;
}

const OPTIONAL_SCHEMA = Symbol("optional-schema");
type JsonSchema = Record<string, unknown> & { [OPTIONAL_SCHEMA]?: true };

export interface ParsedGoalArgs {
  command: GoalCommand;
  value: string;
}

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS = 3;
const MAX_EVIDENCE_ENTRIES = 10;
const STATE_PATH = join(homedir(), ".pi", "agent", "goal-loop", "state.json");

const COMMANDS = new Set<GoalCommand>(["status", "pause", "resume", "clear", "edit", "verify"]);
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
    return {
      type: "object",
      ...(required.length ? { required } : {}),
      properties: cleanProperties,
    };
  },
  String(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "string", ...options };
  },
  Number(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "number", ...options };
  },
  Array(items: JsonSchema): JsonSchema {
    return { type: "array", items };
  },
  Enum(values: readonly string[]): JsonSchema {
    return { type: "string", enum: [...values] };
  },
  Optional(schema: JsonSchema): JsonSchema {
    return { ...schema, [OPTIONAL_SCHEMA]: true };
  },
};

export function parseGoalArgs(args: string): ParsedGoalArgs {
  const trimmed = args.trim();
  if (!trimmed) return { command: "status", value: "" };

  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (COMMANDS.has(first as GoalCommand)) {
    return { command: first as GoalCommand, value: rest.join(" ").trim() };
  }

  return { command: "start", value: trimmed };
}

export function goalKey(projectRoot: string): string {
  const normalized = normalize(projectRoot).replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function createGoal(projectRoot: string, objective: string, now = new Date()): GoalState {
  const timestamp = now.toISOString();
  return {
    projectRoot,
    objective,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: 0,
    maxTurns: DEFAULT_MAX_TURNS,
    maxFailedVerificationAttempts: DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS,
    consecutiveFailedVerificationAttempts: 0,
    verification: {
      commands: [],
    },
    evidence: [],
  };
}

export function normalizeGoalState(goal: GoalState | Record<string, unknown>): GoalState {
  const raw = goal as Partial<GoalState>;
  return {
    projectRoot: raw.projectRoot ?? "",
    objective: raw.objective ?? "",
    status: raw.status ?? "active",
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
    turns: raw.turns ?? 0,
    maxTurns: raw.maxTurns ?? DEFAULT_MAX_TURNS,
    maxFailedVerificationAttempts: raw.maxFailedVerificationAttempts ?? DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS,
    consecutiveFailedVerificationAttempts: raw.consecutiveFailedVerificationAttempts ?? 0,
    lastEvaluation: raw.lastEvaluation,
    verification: {
      commands: Array.isArray(raw.verification?.commands) ? raw.verification.commands : [],
      lastResult: raw.verification?.lastResult,
    },
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
  };
}

export function continuationDeliveryOptions(isIdle: boolean): { deliverAs: "followUp" } | undefined {
  return isIdle ? undefined : { deliverAs: "followUp" };
}

export function recordEvidence(goal: GoalState, evidence: GoalEvidenceInput, now = new Date()): GoalState {
  const entry: GoalEvidence = {
    at: now.toISOString(),
    kind: evidence.kind,
    summary: evidence.summary,
    command: evidence.command,
    outcome: evidence.outcome,
  };

  const verification =
    entry.kind === "verification"
      ? {
          ...goal.verification,
          lastResult: `${entry.outcome ?? "unknown"}: ${entry.summary}`,
        }
      : goal.verification;

  return {
    ...goal,
    verification,
    evidence: [...goal.evidence, entry].slice(-MAX_EVIDENCE_ENTRIES),
    updatedAt: now.toISOString(),
  };
}

export function recordEvaluation(goal: GoalState, evaluation: GoalEvaluation, now = new Date()): GoalState {
  const failedVerification =
    evaluation.decision === "continue" && /\b(fail|fails|failed|failing|error|errored|red)\b/i.test(evaluation.reason);
  const consecutiveFailedVerificationAttempts = failedVerification
    ? goal.consecutiveFailedVerificationAttempts + 1
    : evaluation.decision === "continue"
      ? 0
      : goal.consecutiveFailedVerificationAttempts;

  const explicitStatus: GoalStatus =
    evaluation.decision === "complete"
      ? "complete"
      : evaluation.decision === "blocked"
        ? "blocked"
        : evaluation.decision === "needs_user"
          ? "needs_user"
          : "active";
  const status =
    explicitStatus === "active" && consecutiveFailedVerificationAttempts >= goal.maxFailedVerificationAttempts
      ? "blocked"
      : explicitStatus;

  return {
    ...goal,
    status,
    turns: goal.turns + (evaluation.decision === "continue" ? 1 : 0),
    consecutiveFailedVerificationAttempts,
    updatedAt: now.toISOString(),
    lastEvaluation: evaluation,
  };
}

export function shouldAutoContinue(goal: GoalState): boolean {
  return goal.status === "active" && goal.turns < goal.maxTurns;
}

export function resumeGoal(goal: GoalState, now = new Date()): GoalState {
  return {
    ...goal,
    status: "active",
    maxTurns: goal.turns >= goal.maxTurns ? goal.turns + DEFAULT_MAX_TURNS : goal.maxTurns,
    updatedAt: now.toISOString(),
  };
}

export function goalStatusText(goal: GoalState | undefined): string | undefined {
  return goal && goal.status === "active" ? `goal ${goal.turns}/${goal.maxTurns}` : undefined;
}

export function buildEvaluatorInstructions(goal: GoalState): string {
  const commands = goal.verification.commands.length
    ? goal.verification.commands.map((command) => `- ${command}`).join("\n")
    : "- No explicit verification commands configured.";
  const evidence = goal.evidence.length
    ? goal.evidence
        .slice(-5)
        .map((entry) => {
          const command = entry.command ? ` [${entry.command}]` : "";
          const outcome = entry.outcome ? ` (${entry.outcome})` : "";
          return `- ${entry.kind}${command}${outcome}: ${entry.summary}`;
        })
        .join("\n")
    : "- No evidence recorded yet.";

  return [
    "Evaluator subagent protocol:",
    "- Before claiming complete, blocked, or needs_user, call a foreground read-only evaluator subagent if the Agent tool is available.",
    "- Also call the evaluator when verification failures repeat or the evidence is ambiguous.",
    "- Normal continue turns do not need evaluator review.",
    "- If Agent is unavailable, use the worker GOAL_STATUS/GOAL_REASON markers as the fallback.",
    "",
    "Use this shape:",
    "Agent({",
    '  subagent_type: "Explore",',
    '  description: "Evaluate goal status",',
    "  run_in_background: false,",
    "  prompt: `Review this goal loop decision.",
    "Proposed status: <complete | blocked | needs_user | continue>",
    "Proposed reason: <why the worker thinks this status is right>",
    "Latest verification/output: <paste the latest relevant command output or evidence>",
    `Goal: ${goal.objective}`,
    "Verification commands:",
    commands,
    "Recent evidence:",
    evidence,
    "Return only:",
    "GOAL_EVAL_STATUS: complete | continue | blocked | needs_user",
    "GOAL_EVAL_REASON: one short sentence",
    "GOAL_EVAL_CONFIDENCE: low | medium | high`",
    "})",
    "",
    "Evaluator markers win over worker markers when both are present.",
  ].join("\n");
}

export function buildContinuationPrompt(goal: GoalState): string {
  const commands = goal.verification.commands.length
    ? goal.verification.commands.map((command) => `- ${command}`).join("\n")
    : "- No explicit verification commands configured. Use the best project-specific checks you can infer.";
  const evidence = goal.evidence.length
    ? goal.evidence
        .slice(-5)
        .map((entry) => {
          const command = entry.command ? ` [${entry.command}]` : "";
          const outcome = entry.outcome ? ` (${entry.outcome})` : "";
          return `- ${entry.kind}${command}${outcome}: ${entry.summary}`;
        })
        .join("\n")
    : "- No evidence recorded yet.";

  return [
    "Continue working toward this active goal.",
    "",
    `Goal: ${goal.objective}`,
    `Loop turn: ${goal.turns + 1}/${goal.maxTurns}`,
    "",
    "Verification commands:",
    commands,
    "",
    "Recent evidence:",
    evidence,
    "",
    "Goal tools:",
    "- get_goal: inspect the current goal, verification commands, and evidence",
    "- update_goal: record evidence, add verification commands, or mark complete/blocked/needs_user",
    "",
    buildEvaluatorInstructions(goal),
    "",
    "Operate as a goal loop:",
    "- inspect the current state",
    "- update or create todos if available",
    "- call get_goal when goal state is unclear",
    "- call update_goal after meaningful verification or when stopping",
    "- use subagents only for independent research or review lanes",
    "- make focused changes",
    "- run the smallest useful verification, then broader checks when near completion",
    "- Stop and ask the user if blocked, risky, or the same failure repeats",
    "",
    "At the end of your response, include exactly one status marker:",
    "GOAL_STATUS: complete | continue | blocked | needs_user",
    "GOAL_REASON: one short sentence",
  ].join("\n");
}

export function buildGoalSystemPrompt(goal: GoalState): string {
  return [
    "Active Pi goal loop:",
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Turn budget: ${goal.turns}/${goal.maxTurns}`,
    "",
    "Before stopping, evaluate whether the goal is complete against the objective and any verification command output.",
    "Use get_goal to inspect persisted goal state and update_goal to record evidence or terminal status.",
    buildEvaluatorInstructions(goal),
    "End every response while this goal is active with:",
    "GOAL_STATUS: complete | continue | blocked | needs_user",
    "GOAL_REASON: one short sentence",
  ].join("\n");
}

function normalizeConfidence(value: string | undefined): GoalEvaluation["confidence"] {
  const normalized = value?.toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : "medium";
}

export function parseEvaluationFromText(text: string): GoalEvaluation {
  const evaluatorStatusMatch = text.match(/GOAL_EVAL_STATUS:\s*(complete|continue|blocked|needs_user)/i);
  if (evaluatorStatusMatch) {
    const evaluatorReasonMatch = text.match(/GOAL_EVAL_REASON:\s*(.+)/i);
    const evaluatorConfidenceMatch = text.match(/GOAL_EVAL_CONFIDENCE:\s*(low|medium|high)/i);

    return {
      decision: evaluatorStatusMatch[1].toLowerCase() as GoalDecision,
      reason: evaluatorReasonMatch?.[1]?.trim() || "No explicit evaluator reason found.",
      confidence: normalizeConfidence(evaluatorConfidenceMatch?.[1]),
    };
  }

  const statusMatch = text.match(/GOAL_STATUS:\s*(complete|continue|blocked|needs_user)/i);
  const reasonMatch = text.match(/GOAL_REASON:\s*(.+)/i);
  const decision = (statusMatch?.[1]?.toLowerCase() as GoalDecision | undefined) ?? "continue";

  return {
    decision,
    reason: reasonMatch?.[1]?.trim() || "No explicit goal reason found.",
    confidence: statusMatch ? "medium" : "low",
  };
}

function getText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (!part || typeof part !== "object") return [] as string[];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n")
    .trim();
}

function unwrapMessage(message: unknown): { role?: unknown; content?: unknown; toolName?: unknown; stopReason?: unknown } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as { role?: unknown; content?: unknown; toolName?: unknown; stopReason?: unknown; message?: unknown };
  return record.message && typeof record.message === "object"
    ? (record.message as { role?: unknown; content?: unknown; toolName?: unknown; stopReason?: unknown })
    : record;
}

function getLastAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    const record = unwrapMessage(message);
    if (record?.role !== "assistant") continue;
    const text = getText(record.content);
    if (text) return text;
  }
  return "";
}

export function getGoalEvaluationText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    const record = unwrapMessage(message);
    if (record?.role !== "toolResult" || record.toolName !== "Agent") continue;
    const text = getText(record.content);
    if (/GOAL_EVAL_STATUS:\s*(complete|continue|blocked|needs_user)/i.test(text)) return text;
  }
  return getLastAssistantText(messages);
}

function getLastAssistantStopReason(messages: unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const record = unwrapMessage(message);
    if (record?.role === "assistant") return typeof record.stopReason === "string" ? record.stopReason : undefined;
  }
  return undefined;
}

export function getGoalEvaluation(messages: unknown[]): GoalEvaluation {
  const stopReason = getLastAssistantStopReason(messages);
  if (stopReason === "aborted" || stopReason === "error") {
    return {
      decision: "blocked",
      reason: `Assistant turn ended with ${stopReason}.`,
      confidence: "low",
    };
  }
  return parseEvaluationFromText(getGoalEvaluationText(messages));
}

function readStore(): GoalStore {
  if (!existsSync(STATE_PATH)) return { goals: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as GoalStore;
    if (!parsed || typeof parsed !== "object" || !parsed.goals || typeof parsed.goals !== "object" || Array.isArray(parsed.goals)) return { goals: {} };
    return parsed;
  } catch {
    return { goals: {} };
  }
}

function writeStore(store: GoalStore) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function getProjectGoal(projectRoot: string): GoalState | undefined {
  const goal = readStore().goals[goalKey(projectRoot)];
  return goal ? normalizeGoalState(goal) : undefined;
}

function setProjectGoal(goal: GoalState) {
  const store = readStore();
  store.goals[goalKey(goal.projectRoot)] = goal;
  writeStore(store);
}

function clearProjectGoal(projectRoot: string) {
  const store = readStore();
  delete store.goals[goalKey(projectRoot)];
  writeStore(store);
}

function formatStatus(goal: GoalState | undefined): string {
  if (!goal) return "No active goal for this project.";
  const latestEvidence = goal.evidence.at(-1);
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Turns: ${goal.turns}/${goal.maxTurns}`,
    `Verification: ${goal.verification.commands.length ? goal.verification.commands.join(", ") : "none"}`,
    latestEvidence ? `Latest evidence: ${latestEvidence.kind} - ${latestEvidence.summary}` : "Latest evidence: none",
    goal.lastEvaluation ? `Last check: ${goal.lastEvaluation.decision} - ${goal.lastEvaluation.reason}` : "Last check: none",
  ].join("\n");
}

function notify(ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }, message: string, type: "info" | "warning" | "error" = "info") {
  ctx.ui.notify(message, type);
}

function sendContinuation(pi: ExtensionAPI, ctx: { isIdle: () => boolean }, goal: GoalState) {
  const options = continuationDeliveryOptions(ctx.isIdle());
  if (options) {
    pi.sendUserMessage(buildContinuationPrompt(goal), options);
    return;
  }
  pi.sendUserMessage(buildContinuationPrompt(goal));
}

export default function goalLoopExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Inspect the current project goal, status, verification commands, and evidence.",
    promptSnippet: "Inspect the current project goal loop state.",
    parameters: Schema.Object({}) as any,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const goal = getProjectGoal(ctx.cwd || process.cwd());
      return {
        content: [{ type: "text", text: formatStatus(goal) }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create or replace the current project goal loop objective.",
    promptSnippet: "Create or replace the current project goal loop objective.",
    parameters: Schema.Object({
      objective: Schema.String({ description: "Goal objective to pursue." }),
      maxTurns: Schema.Optional(Schema.Number({ description: "Optional turn budget. Default is 10." })),
      verificationCommands: Schema.Optional(Schema.Array(Schema.String({ description: "Verification command." }))),
    }) as any,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectRoot = ctx.cwd || process.cwd();
      const goal = {
        ...createGoal(projectRoot, params.objective),
        maxTurns: typeof params.maxTurns === "number" && params.maxTurns > 0 ? Math.floor(params.maxTurns) : DEFAULT_MAX_TURNS,
        verification: {
          commands: Array.isArray(params.verificationCommands) ? [...new Set(params.verificationCommands)] : [],
        },
      };
      setProjectGoal(goal);
      ctx.ui.setStatus("goal-loop", goalStatusText(goal));
      return {
        content: [{ type: "text", text: `Goal created.\n\n${formatStatus(goal)}` }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Record goal evidence, add verification commands, or mark the current project goal complete, blocked, or needing user input.",
    promptSnippet: "Update the current project goal loop state.",
    promptGuidelines: [
      "Use update_goal to record verification evidence before marking a goal complete.",
      "Use update_goal with status=blocked or status=needs_user when progress requires user input.",
    ],
    parameters: Schema.Object({
      status: Schema.Optional(Schema.Enum(["active", "paused", "complete", "blocked", "needs_user"] as const)),
      reason: Schema.Optional(Schema.String({ description: "Short reason for a status update." })),
      evidence: Schema.Optional(Schema.String({ description: "Evidence summary to append to the goal ledger." })),
      evidenceKind: Schema.Optional(Schema.Enum(["note", "verification", "tool"] as const)),
      command: Schema.Optional(Schema.String({ description: "Verification command related to the evidence." })),
      outcome: Schema.Optional(Schema.Enum(["passed", "failed", "unknown"] as const)),
      verificationCommand: Schema.Optional(Schema.String({ description: "Verification command to remember for future loop turns." })),
      maxTurns: Schema.Optional(Schema.Number({ description: "Replace the remaining turn budget ceiling." })),
    }) as any,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectRoot = ctx.cwd || process.cwd();
      let goal = getProjectGoal(projectRoot);
      if (!goal) {
        return {
          content: [{ type: "text", text: "No active goal for this project. Use create_goal or /goal <objective> first." }],
          details: { error: "missing_goal" },
        };
      }

      if (typeof params.maxTurns === "number" && params.maxTurns > 0) {
        goal = { ...goal, maxTurns: Math.floor(params.maxTurns), updatedAt: new Date().toISOString() };
      }

      if (params.verificationCommand) {
        goal = {
          ...goal,
          verification: {
            ...goal.verification,
            commands: [...new Set([...goal.verification.commands, params.verificationCommand])],
          },
          updatedAt: new Date().toISOString(),
        };
      }

      if (params.evidence || params.command || params.outcome) {
        goal = recordEvidence(goal, {
          kind: (params.evidenceKind as GoalEvidenceKind | undefined) ?? (params.command ? "verification" : "note"),
          summary: params.evidence ?? params.reason ?? "Goal evidence recorded.",
          command: params.command,
          outcome: params.outcome as GoalEvidenceOutcome | undefined,
        });
      }

      if (params.status === "active" || params.status === "paused") {
        goal = { ...goal, status: params.status, updatedAt: new Date().toISOString() };
      } else if (params.status) {
        goal = recordEvaluation(goal, {
          decision: params.status as GoalDecision,
          reason: params.reason ?? params.evidence ?? "Goal status updated.",
          confidence: "medium",
        });
      }

      setProjectGoal(goal);
      ctx.ui.setStatus("goal-loop", goalStatusText(goal));
      return {
        content: [{ type: "text", text: `Goal updated.\n\n${formatStatus(goal)}` }],
        details: { goal },
      };
    },
  });

  pi.registerCommand("goal", {
    description: "Set or manage an auto-continuing project goal loop",
    async handler(args, ctx) {
      const parsed = parseGoalArgs(args);
      const projectRoot = ctx.cwd || process.cwd();
      const existing = getProjectGoal(projectRoot);

      if (parsed.command === "start") {
        if (!parsed.value) {
          notify(ctx, "Usage: /goal <objective>", "warning");
          return;
        }
        const goal = createGoal(projectRoot, parsed.value);
        setProjectGoal(goal);
        ctx.ui.setStatus("goal-loop", goalStatusText(goal));
        notify(ctx, `Goal started: ${goal.objective}`);
        sendContinuation(pi, ctx, goal);
        return;
      }

      if (parsed.command === "status") {
        notify(ctx, formatStatus(existing));
        return;
      }

      if (!existing) {
        notify(ctx, "No active goal for this project.", "warning");
        return;
      }

      if (parsed.command === "pause") {
        const goal = { ...existing, status: "paused" as const, updatedAt: new Date().toISOString() };
        setProjectGoal(goal);
        ctx.ui.setStatus("goal-loop", goalStatusText(goal));
        notify(ctx, "Goal paused.");
        return;
      }

      if (parsed.command === "resume") {
        const goal = resumeGoal(existing);
        setProjectGoal(goal);
        ctx.ui.setStatus("goal-loop", goalStatusText(goal));
        notify(ctx, "Goal resumed.");
        sendContinuation(pi, ctx, goal);
        return;
      }

      if (parsed.command === "clear") {
        clearProjectGoal(projectRoot);
        ctx.ui.setStatus("goal-loop", undefined);
        notify(ctx, "Goal cleared.");
        return;
      }

      if (parsed.command === "edit") {
        if (!parsed.value) {
          notify(ctx, "Usage: /goal edit <objective>", "warning");
          return;
        }
        const goal = { ...existing, objective: parsed.value, status: "active" as const, updatedAt: new Date().toISOString() };
        setProjectGoal(goal);
        ctx.ui.setStatus("goal-loop", goalStatusText(goal));
        notify(ctx, `Goal updated: ${goal.objective}`);
        return;
      }

      if (parsed.command === "verify") {
        if (!parsed.value) {
          notify(ctx, "Usage: /goal verify <command>", "warning");
          return;
        }
        const commands = [...existing.verification.commands, parsed.value];
        const goal = {
          ...existing,
          verification: { ...existing.verification, commands },
          updatedAt: new Date().toISOString(),
        };
        setProjectGoal(goal);
        ctx.ui.setStatus("goal-loop", goalStatusText(goal));
        notify(ctx, `Verification command added: ${parsed.value}`);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const goal = getProjectGoal(ctx.cwd || process.cwd());
    ctx.ui.setStatus("goal-loop", goalStatusText(goal));
  });

  pi.on("before_agent_start", (event, ctx) => {
    const goal = getProjectGoal(event.systemPromptOptions.cwd || ctx.cwd || process.cwd());
    if (!goal || goal.status !== "active") return;
    return {
      systemPrompt: [event.systemPrompt, buildGoalSystemPrompt(goal)].filter(Boolean).join("\n\n"),
    };
  });

  pi.on("agent_end", (event, ctx) => {
    const projectRoot = ctx.cwd || process.cwd();
    const goal = getProjectGoal(projectRoot);
    if (!goal || goal.status !== "active") return;

    const evaluation = getGoalEvaluation(event.messages as unknown[]);
    const updated = recordEvaluation(goal, evaluation);
    setProjectGoal(updated);
    ctx.ui.setStatus("goal-loop", goalStatusText(updated));

    if (updated.status === "complete") {
      notify(ctx, `Goal complete: ${evaluation.reason}`);
      return;
    }

    if (updated.status === "blocked" || updated.status === "needs_user") {
      notify(ctx, `Goal stopped (${updated.status}): ${evaluation.reason}`, "warning");
      return;
    }

    if (!shouldAutoContinue(updated)) {
      const blocked = { ...updated, status: "blocked" as const, updatedAt: new Date().toISOString() };
      setProjectGoal(blocked);
      ctx.ui.setStatus("goal-loop", goalStatusText(blocked));
      notify(ctx, `Goal stopped after ${updated.turns}/${updated.maxTurns} turns. Run /goal resume to continue.`, "warning");
      return;
    }

    sendContinuation(pi, ctx, updated);
  });
}
