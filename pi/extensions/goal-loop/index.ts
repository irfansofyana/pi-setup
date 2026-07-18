import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  acquireGoalLease,
  createGoal,
  createPendingRun,
  editGoalObjective,
  expireStalePendingRun,
  goalKey,
  goalStatusText,
  MAX_GOAL_OBJECTIVE_CHARS,
  normalizeGoalState,
  normalizeGoalUsage,
  recordEvidence,
  recordProviderUsageLimit,
  recordRunCandidate,
  recordRunUsage,
  releaseGoalLease,
  resumeGoal,
  settlePendingRun,
  shouldAutoContinue,
  tokenBudgetAllowsResume,
  validateGoalObjective,
  type GoalCommand,
  type GoalDecision,
  type GoalEvaluation,
  type GoalEvidenceInput,
  type GoalEvidenceKind,
  type GoalEvidenceOutcome,
  type GoalState,
  type GoalUsage,
} from "./state.ts";
import { parseCurrentRunCandidate } from "./evaluation.ts";
import {
  createGoalStorage,
  GoalStorageAuditError,
  GoalStorageConflictError,
  GoalStorageCorruptError,
  type GoalAuditEvent,
  type GoalStorage,
} from "./storage.ts";

export type {
  GoalCommand,
  GoalDecision,
  GoalEvaluation,
  GoalEvidenceInput,
  GoalEvidenceKind,
  GoalEvidenceOutcome,
  GoalState,
} from "./state.ts";
export {
  createGoal,
  goalKey,
  goalStatusText,
  normalizeGoalState,
  recordEvidence,
  resumeGoal,
  shouldAutoContinue,
} from "./state.ts";

export interface GoalLoopConfig {
  allowModelCreateGoal: boolean;
}

export interface GoalLoopExtensionOptions {
  storage?: GoalStorage;
  config?: GoalLoopConfig;
  now?: () => Date;
  randomId?: () => string;
}

interface CreateGoalToolParams {
  objective?: unknown;
}

interface UpdateGoalToolParams {
  proposedStatus?: "complete" | "blocked" | "needs_user";
  reason?: string;
  evidence?: string;
  evidenceKind?: GoalEvidenceKind;
  command?: string;
  outcome?: GoalEvidenceOutcome;
  verificationCommand?: string;
}

const OPTIONAL_SCHEMA = Symbol("optional-schema");
type JsonSchema = Record<string, unknown> & { [OPTIONAL_SCHEMA]?: true };
const CONFIG_PATH = join(homedir(), ".pi", "agent", "goal-loop", "config.json");
const DEFAULT_CONFIG: GoalLoopConfig = { allowModelCreateGoal: false };
const COMMANDS = new Set<GoalCommand>(["status", "list", "pause", "resume", "clear", "edit", "verify", "budget"]);
const CLEAR_ALIASES = new Set(["stop", "off", "reset", "none", "cancel"]);

const Schema = {
  Object(properties: Record<string, JsonSchema>): JsonSchema {
    const required = Object.entries(properties).filter(([, schema]) => !schema[OPTIONAL_SCHEMA]).map(([name]) => name);
    const cleaned = Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
      const { [OPTIONAL_SCHEMA]: _optional, ...plain } = schema;
      return [name, plain];
    }));
    return { type: "object", additionalProperties: false, ...(required.length ? { required } : {}), properties: cleaned };
  },
  String(options: Record<string, unknown> = {}): JsonSchema { return { type: "string", ...options }; },
  Enum(values: readonly string[]): JsonSchema { return { type: "string", enum: [...values] }; },
  Optional(schema: JsonSchema): JsonSchema { return { ...schema, [OPTIONAL_SCHEMA]: true }; },
};

export interface ParsedGoalArgs {
  command: GoalCommand;
  value: string;
}

export function parseGoalArgs(args: string): ParsedGoalArgs {
  const trimmed = args.trim();
  if (!trimmed) return { command: "status", value: "" };
  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (CLEAR_ALIASES.has(first) && rest.length === 0) return { command: "clear", value: "" };
  return COMMANDS.has(first as GoalCommand)
    ? { command: first as GoalCommand, value: rest.join(" ").trim() }
    : { command: "start", value: trimmed };
}

export function normalizeGoalLoopConfig(raw: unknown): GoalLoopConfig {
  return raw && typeof raw === "object" && (raw as { allowModelCreateGoal?: unknown }).allowModelCreateGoal === true
    ? { allowModelCreateGoal: true }
    : DEFAULT_CONFIG;
}

function readGoalLoopConfig(): GoalLoopConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    return normalizeGoalLoopConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}

function messageRecord(message: unknown): { role?: unknown; stopReason?: unknown; message?: unknown; content?: unknown; usage?: unknown; timestamp?: unknown } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as { role?: unknown; stopReason?: unknown; message?: unknown; content?: unknown; usage?: unknown; timestamp?: unknown };
  return record.message && typeof record.message === "object" ? record.message as typeof record : record;
}

export function sumAssistantUsage(messages: unknown[]): GoalUsage {
  let total: GoalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
  for (const item of messages) {
    const record = messageRecord(item);
    if (record?.role !== "assistant" || !record.usage || typeof record.usage !== "object") continue;
    const raw = record.usage as Record<string, unknown>;
    const cost = raw.cost && typeof raw.cost === "object" ? raw.cost as Record<string, unknown> : {};
    const usage = normalizeGoalUsage({
      input: raw.input,
      output: raw.output,
      cacheRead: raw.cacheRead,
      cacheWrite: raw.cacheWrite,
      totalTokens: raw.totalTokens,
      cost: { total: cost.total },
    });
    if (!usage) continue;
    total = {
      input: total.input + usage.input,
      output: total.output + usage.output,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
      totalTokens: total.totalTokens + usage.totalTokens,
      cost: { total: total.cost.total + usage.cost.total },
    };
  }
  return total;
}

function autonomousRunFingerprint(messages: unknown[]): string {
  const finalized = messages.map((item) => {
    const record = messageRecord(item);
    if (record?.role !== "assistant") return undefined;
    return {
      timestamp: record.timestamp,
      stopReason: record.stopReason,
      usage: record.usage,
      content: record.content,
    };
  }).filter(Boolean);
  return createHash("sha256").update(JSON.stringify(finalized)).digest("hex");
}

function assistantStopReason(messages: unknown[]): "aborted" | "error" | undefined {
  for (const item of [...messages].reverse()) {
    const record = messageRecord(item);
    if (record?.role !== "assistant") continue;
    return record.stopReason === "aborted" || record.stopReason === "error" ? record.stopReason : undefined;
  }
  return undefined;
}

function decisionTemplate(goal: GoalState): string {
  const pending = goal.pendingRun;
  if (!pending) return "No autonomous run is currently pending.";
  return JSON.stringify({
    goalId: goal.goalId,
    goalRevision: goal.goalRevision,
    runId: pending.runId,
    evaluationRequestId: pending.evaluationRequestId,
    decision: "continue",
    reason: "one short sentence",
  });
}

export function buildEvaluatorInstructions(goal: GoalState): string {
  const pending = goal.pendingRun;
  const commands = goal.verification.commands.length
    ? goal.verification.commands.map((command) => `- ${command}`).join("\n")
    : "- No explicit verification commands configured.";
  if (!pending) return "No evaluator decision is needed until the coordinator dispatches a run.";
  return [
    "When proposing a terminal outcome, obtain an independent evaluator review if the Agent tool is available.",
    "Call Agent with description exactly `Evaluate goal status` and include this request ID in its prompt:",
    `Evaluation request ID: ${pending.evaluationRequestId}`,
    "Evaluator output must be one exact JSON line and use these identifiers:",
    `GOAL_EVALUATOR_DECISION: ${JSON.stringify({ goalId: goal.goalId, goalRevision: goal.goalRevision, runId: pending.runId, evaluationRequestId: pending.evaluationRequestId, decision: "continue", reason: "one short sentence", confidence: "high" })}`,
    "Configured verification commands:",
    commands,
  ].join("\n");
}

function workerInstructions(goal: GoalState): string {
  return [
    "At the end of the response, include exactly one worker decision JSON line:",
    `GOAL_WORKER_DECISION: ${decisionTemplate(goal)}`,
  ].join("\n");
}

function usageBudgetText(goal: GoalState): string {
  const usage = goal.usage;
  const tokens = usage?.totalTokens ?? 0;
  const cost = usage?.cost.total ?? 0;
  const budget = goal.tokenBudget === undefined ? "off" : `${tokens}/${goal.tokenBudget} tokens`;
  return `Usage: ${tokens} tokens (input ${usage?.input ?? 0}, output ${usage?.output ?? 0}, cache read ${usage?.cacheRead ?? 0}, cache write ${usage?.cacheWrite ?? 0}, cost $${cost.toFixed(6)}); token budget: ${budget}`;
}

export function buildContinuationPrompt(goal: GoalState): string {
  const commands = goal.verification.commands.length
    ? goal.verification.commands.map((command) => `- ${command}`).join("\n")
    : "- No explicit verification commands configured.";
  const evidence = goal.evidence.length
    ? goal.evidence.slice(-5).map((entry) => `- ${entry.kind}${entry.command ? ` [${entry.command}]` : ""}${entry.outcome ? ` (${entry.outcome})` : ""}: ${entry.summary}`).join("\n")
    : "- No evidence recorded yet.";
  return [
    // This durable marker ties before_agent_start to the exact message sent by
    // the coordinator, rather than accidentally claiming a normal user turn.
    `GOAL_LOOP_CONTINUATION_RUN: ${goal.pendingRun?.runId ?? "none"}`,
    "Continue working toward this active goal.",
    `Goal: ${goal.objective}`,
    `Loop turn: ${goal.turns + 1}/${goal.maxTurns}`,
    usageBudgetText(goal),
    "Verification commands:",
    commands,
    "Recent evidence:",
    evidence,
    "Use get_goal to inspect state. Use update_goal only to record evidence, add verification commands, or propose a terminal outcome.",
    buildEvaluatorInstructions(goal),
    workerInstructions(goal),
  ].join("\n\n");
}

function continuationRunId(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  const match = /^GOAL_LOOP_CONTINUATION_RUN:\s*(\S+)$/m.exec(prompt);
  return match?.[1];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
    .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
    .join("\n");
}

function isCurrentContinuation(messages: unknown[], runId: string): boolean {
  for (const message of [...messages].reverse()) {
    const record = messageRecord(message);
    if (record?.role !== "user") continue;
    return continuationRunId(contentText(record.content)) === runId;
  }
  return false;
}

function containsUserMessage(messages: unknown[]): boolean {
  return messages.some((message) => messageRecord(message)?.role === "user");
}

function firstNonContinuationUserIndex(messages: unknown[], runId: string): number {
  return messages.findIndex((message) => {
    const record = messageRecord(message);
    return record?.role === "user" && continuationRunId(contentText(record.content)) !== runId;
  });
}

export function buildGoalSystemPrompt(goal: GoalState, autonomous = true): string {
  const common = [
    "Active Pi goal loop:",
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Loop budget: ${goal.turns}/${goal.maxTurns}`,
    usageBudgetText(goal),
    "Model-authored terminal status is only a proposal; the coordinator decides it after the run settles.",
  ];
  if (!autonomous) {
    return [...common, "This is a normal user turn, not an autonomous continuation. Do not call update_goal for this pending run or emit autonomous decision records."].join("\n\n");
  }
  return [
    ...common,
    "Use get_goal to inspect state and update_goal to record evidence, add verification commands, or propose a terminal outcome.",
    buildEvaluatorInstructions(goal),
    workerInstructions(goal),
  ].join("\n\n");
}

function formatAchievement(goal: GoalState): string {
  return [
    `Goal: ${goal.objective}`,
    `Completed: ${goal.updatedAt}`,
    usageBudgetText(goal),
    goal.lastEvaluation ? `Receipt: ${goal.lastEvaluation.reason}` : "Receipt: completed",
  ].join("\n");
}

export function formatGoalDuration(startedAt: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatStatus(goal: GoalState | undefined, latestAchievement: GoalState | undefined, timestamp: Date): string {
  if (!goal) {
    return latestAchievement
      ? `No active goal for this working root. Latest achievement (read-only):\n${formatAchievement(latestAchievement)}`
      : "No active goal for this working root. No archived achievement found.";
  }
  const latest = goal.evidence.at(-1);
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Duration: ${formatGoalDuration(goal.createdAt, timestamp)}`,
    `Evaluated runs: ${goal.evaluatedRuns}`,
    `Loops used: ${goal.turns}/${goal.maxTurns}`,
    usageBudgetText(goal),
    `Revision: ${goal.goalRevision}`,
    `Verification: ${goal.verification.commands.length ? goal.verification.commands.join(", ") : "none"}`,
    latest ? `Latest evidence: ${latest.kind} - ${latest.summary}` : "Latest evidence: none",
    goal.lastEvaluation ? `Last check: ${goal.lastEvaluation.decision} - ${goal.lastEvaluation.reason}` : "Last check: none",
    goal.limitDetail ? `Limit: ${goal.limitDetail.reason}${goal.limitDetail.retryAfter ? ` (retry-after: ${goal.limitDetail.retryAfter})` : ""}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatGoalList(goals: GoalState[]): string {
  if (!goals.length) return "No active goals across stored working roots.";
  return [
    "Active goals across stored working roots:",
    ...goals.map((goal) => `- ${goal.projectRoot} [${goal.status}] ${goal.turns}/${goal.maxTurns} — ${goal.objective}`),
  ].join("\n");
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, type);
}

function storageError(ctx: ExtensionContext, error: unknown): void {
  if (error instanceof GoalStorageCorruptError) {
    notify(ctx, `Goal loop stopped because state was corrupt. Quarantined file: ${error.quarantinedPath}`, "error");
    return;
  }
  if (error instanceof GoalStorageConflictError) {
    notify(ctx, "Goal loop state changed in another session. Reload status and retry; no continuation was sent.", "warning");
    return;
  }
  if (error instanceof GoalStorageAuditError) {
    notify(ctx, error.message, "warning");
    return;
  }
  notify(ctx, `Goal loop storage error: ${error instanceof Error ? error.message : String(error)}`, "error");
}

function auditEvent(type: string, reason: string, ctx: ExtensionContext, now: Date): GoalAuditEvent {
  return { type, at: now.toISOString(), reason, sessionId: ctx.sessionManager.getSessionId() };
}

type GoalReadResult =
  | { ok: true; goal: GoalState | undefined }
  | { ok: false };

function readGoal(storage: GoalStorage, projectRoot: string, ctx: ExtensionContext): GoalReadResult {
  try {
    return { ok: true, goal: storage.read(projectRoot) };
  } catch (error) {
    storageError(ctx, error);
    if (error instanceof GoalStorageAuditError && error.committedState) {
      return { ok: true, goal: error.committedState };
    }
    return { ok: false };
  }
}

function readLatestAchievement(storage: GoalStorage, projectRoot: string, ctx: ExtensionContext): GoalState | undefined {
  try {
    return storage.readLatestCompleted(projectRoot);
  } catch (error) {
    storageError(ctx, error);
    return undefined;
  }
}

function archiveCompletedGoal(storage: GoalStorage, goal: GoalState, ctx: ExtensionContext): boolean {
  try {
    storage.archive(goal);
    return true;
  } catch (error) {
    storageError(ctx, error);
    notify(ctx, "The completed goal remains in the active slot because its archive receipt could not be persisted.", "warning");
    return false;
  }
}

function persistGoal(storage: GoalStorage, goal: GoalState, event: GoalAuditEvent, ctx: ExtensionContext): GoalState | undefined {
  try {
    return storage.write(goal, goal.storageRevision, event);
  } catch (error) {
    storageError(ctx, error);
    return error instanceof GoalStorageAuditError ? error.committedState : undefined;
  }
}

function clearGoal(storage: GoalStorage, projectRoot: string, revision: number, event: GoalAuditEvent, ctx: ExtensionContext): boolean {
  try {
    storage.clear(projectRoot, revision, event);
    return true;
  } catch (error) {
    storageError(ctx, error);
    return error instanceof GoalStorageAuditError && error.cleared;
  }
}

function leaseConflict(goal: GoalState, sessionId: string, now: Date): { owner: string; expiresAt: string } | undefined {
  const lease = goal.lease;
  if (!lease || lease.sessionId === sessionId || Date.parse(lease.expiresAt) <= now.getTime()) return undefined;
  return { owner: lease.sessionId, expiresAt: lease.expiresAt };
}

function notifyLeaseConflict(ctx: ExtensionContext, conflict: { owner: string; expiresAt: string }): void {
  notify(ctx, `Goal is active in session ${conflict.owner.slice(0, 8)} until ${conflict.expiresAt}. Pause it there or resume after the lease expires.`, "warning");
}

function ownsFreshPendingRun(
  goal: GoalState,
  sessionId: string,
  now: Date,
): goal is GoalState & { lease: NonNullable<GoalState["lease"]>; pendingRun: NonNullable<GoalState["pendingRun"]> } {
  return goal.status === "active" &&
    goal.lease?.sessionId === sessionId &&
    Date.parse(goal.lease.expiresAt) > now.getTime() &&
    goal.pendingRun?.sessionId === sessionId;
}

function prepareDispatch(goal: GoalState, sessionId: string, now: Date, randomId: () => string): { goal?: GoalState; reason?: string } {
  const previousOwner = goal.lease?.sessionId;
  const leased = acquireGoalLease(goal, sessionId, now);
  if (!leased.ok) return { reason: `Goal is leased by session ${leased.ownerSessionId.slice(0, 8)} until ${leased.expiresAt}.` };
  let next = leased.goal;
  if (next.pendingRun && (previousOwner !== sessionId || next.pendingRun.sessionId !== sessionId)) {
    next = { ...next, pendingRun: undefined, updatedAt: now.toISOString() };
  }
  const pending = createPendingRun(next, sessionId, now, { runId: randomId(), evaluationRequestId: randomId() });
  return pending.ok ? { goal: pending.goal } : { reason: pending.reason };
}

function sendPrepared(pi: ExtensionAPI, ctx: ExtensionContext, goal: GoalState): boolean {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    notify(ctx, "Goal run was saved but not sent because Pi is busy or messages are pending.", "warning");
    return false;
  }
  try {
    pi.sendUserMessage(buildContinuationPrompt(goal));
    return true;
  } catch (error) {
    notify(ctx, `Goal run was saved but could not be sent: ${error instanceof Error ? error.message : String(error)}. Run /goal resume to retry.`, "error");
    return false;
  }
}

function createGoalStatusAnimator(storage: GoalStorage) {
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let latestCtx: ExtensionContext | undefined;
  const paint = (ctx: ExtensionContext): boolean => {
    const result = readGoal(storage, ctx.cwd || process.cwd(), ctx);
    const goal = result.ok ? result.goal : undefined;
    ctx.ui.setStatus("goal-loop", goalStatusText(goal, frame));
    return result.ok && goal?.status === "active";
  };
  return {
    sync(ctx: ExtensionContext) {
      latestCtx = ctx;
      if (!paint(ctx)) {
        if (timer) clearInterval(timer);
        timer = undefined;
        return;
      }
      if (!timer) {
        timer = setInterval(() => {
          if (!latestCtx) return;
          frame += 1;
          if (!paint(latestCtx) && timer) {
            clearInterval(timer);
            timer = undefined;
          }
        }, 500);
        timer.unref?.();
      }
    },
    clear(ctx?: ExtensionContext) {
      if (timer) clearInterval(timer);
      timer = undefined;
      latestCtx = undefined;
      ctx?.ui.setStatus("goal-loop", undefined);
    },
  };
}

function registerGoalLoop(pi: ExtensionAPI, options: GoalLoopExtensionOptions): void {
  const storage = options.storage ?? createGoalStorage();
  const config = options.config ?? readGoalLoopConfig();
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const status = createGoalStatusAnimator(storage);
  // Tool authority belongs only to the accepted top-level continuation attempt
  // and is revoked at its first agent_end or first non-marker user message.
  // Chain identity survives Pi's markerless low-level retries until
  // agent_settled, but never grants tools.
  type AutonomousRunIdentity = { projectRoot: string; sessionId: string; runId: string };
  type AutonomousRunInterruption = AutonomousRunIdentity & { reason: string };
  let activeContinuation: AutonomousRunIdentity | undefined;
  let autonomousChain: AutonomousRunIdentity | undefined;
  let autonomousInterruption: AutonomousRunInterruption | undefined;
  let providerLimit: AutonomousRunIdentity & { retryAfter?: string } | undefined;
  const clearContinuationAuthority = (): void => { activeContinuation = undefined; };
  const clearProviderLimit = (): void => { providerLimit = undefined; };
  const clearAutonomousTracking = (): void => {
    autonomousChain = undefined;
    autonomousInterruption = undefined;
    providerLimit = undefined;
  };
  const matchesRun = (identity: AutonomousRunIdentity | undefined, projectRoot: string, sessionId: string, runId: string): boolean =>
    identity?.projectRoot === projectRoot && identity.sessionId === sessionId && identity.runId === runId;
  const hasContinuationAuthority = (projectRoot: string, sessionId: string, runId: string): boolean =>
    matchesRun(activeContinuation, projectRoot, sessionId, runId);

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Inspect the current working-root goal, status, verification commands, and evidence.",
    promptSnippet: "Inspect the current working-root goal loop state.",
    parameters: Schema.Object({}) as any,
    async execute(_id, _params, _signal, _update, ctx) {
      const result = readGoal(storage, ctx.cwd || process.cwd(), ctx);
      if (!result.ok) {
        return { content: [{ type: "text", text: "Goal state is unavailable because storage could not be read." }], details: { error: "storage_error" } };
      }
      const latestAchievement = result.goal ? undefined : readLatestAchievement(storage, ctx.cwd || process.cwd(), ctx);
      return { content: [{ type: "text", text: formatStatus(result.goal, latestAchievement, now()) }], details: { goal: result.goal, latestAchievement } };
    },
  });

  if (config.allowModelCreateGoal) {
    pi.registerTool({
      name: "create_goal",
      label: "Create Goal",
      description: "Create or replace the current working-root goal loop objective when model creation is explicitly enabled.",
      promptSnippet: "Create a goal only when the user has enabled model goal creation.",
      parameters: Schema.Object({ objective: Schema.String({ description: "Goal objective.", minLength: 1, maxLength: MAX_GOAL_OBJECTIVE_CHARS }) }) as any,
      executionMode: "sequential",
      async execute(_id, params, _signal, _update, ctx) {
        const projectRoot = ctx.cwd || process.cwd();
        const readResult = readGoal(storage, projectRoot, ctx);
        if (!readResult.ok) {
          return { content: [{ type: "text", text: "Goal was not created because storage could not be read safely." }], details: { error: "storage_error" } };
        }
        const existing = readResult.goal;
        const owner = ctx.sessionManager.getSessionId();
        const timestamp = now();
        if (existing) {
          const conflict = leaseConflict(existing, owner, timestamp);
          if (conflict) {
            notifyLeaseConflict(ctx, conflict);
            return { content: [{ type: "text", text: "Goal creation refused because another session owns the goal lease." }], details: { error: "lease_conflict" } };
          }
          if (existing.status === "complete" && !archiveCompletedGoal(storage, existing, ctx)) {
            return { content: [{ type: "text", text: "Goal creation refused until the completed receipt can be archived." }], details: { error: "archive_error" } };
          }
        }
        const input = params as CreateGoalToolParams;
        const validated = validateGoalObjective(input.objective);
        if (!validated.ok) return { content: [{ type: "text", text: validated.reason }], details: { error: "invalid_objective" } };
        const objective = validated.objective;
        let goal = { ...createGoal(projectRoot, objective, timestamp, randomId()), storageRevision: existing?.storageRevision ?? 0 };
        const prepared = ctx.isIdle() && !ctx.hasPendingMessages() ? prepareDispatch(goal, owner, timestamp, randomId) : undefined;
        if (prepared?.goal) goal = prepared.goal;
        const persisted = persistGoal(storage, goal, auditEvent(prepared?.goal ? "run_dispatched" : "goal_created", "Model goal creation enabled by configuration.", ctx, timestamp), ctx);
        if (!persisted) return { content: [{ type: "text", text: "Goal was not created because storage rejected the transition." }], details: { error: "storage_error" } };
        status.sync(ctx);
        if (prepared?.goal) sendPrepared(pi, ctx, persisted);
        return { content: [{ type: "text", text: `Goal created.\n\n${formatStatus(persisted, undefined, timestamp)}` }], details: { goal: persisted } };
      },
    });
  }

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Record evidence, add a verification command, or propose a terminal outcome.",
    promptSnippet: "Update current goal evidence or propose a terminal outcome.",
    promptGuidelines: [
      "Use update_goal to record evidence before proposing completion.",
      "Terminal outcomes passed to update_goal are proposals reviewed by the goal-loop coordinator.",
    ],
    parameters: Schema.Object({
      proposedStatus: Schema.Optional(Schema.Enum(["complete", "blocked", "needs_user"] as const)),
      reason: Schema.Optional(Schema.String()),
      evidence: Schema.Optional(Schema.String()),
      evidenceKind: Schema.Optional(Schema.Enum(["note", "verification", "tool"] as const)),
      command: Schema.Optional(Schema.String()),
      outcome: Schema.Optional(Schema.Enum(["passed", "failed", "unknown"] as const)),
      verificationCommand: Schema.Optional(Schema.String()),
    }) as any,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const projectRoot = ctx.cwd || process.cwd();
      const readResult = readGoal(storage, projectRoot, ctx);
      if (!readResult.ok) return { content: [{ type: "text", text: "Goal update refused because storage could not be read safely." }], details: { error: "storage_error" } };
      const currentGoal = readResult.goal;
      if (!currentGoal) return { content: [{ type: "text", text: "No active goal for this working root. Use /goal <objective> first." }], details: { error: "missing_goal" } };
      const owner = ctx.sessionManager.getSessionId();
      const timestamp = now();
      if (!ownsFreshPendingRun(currentGoal, owner, timestamp)) {
        return { content: [{ type: "text", text: "Goal update refused because no matching session-owned run with a fresh lease is active." }], details: { error: "no_pending_run" } };
      }
      const input = params as UpdateGoalToolParams;
      const pendingRun = currentGoal.pendingRun;
      if (!hasContinuationAuthority(projectRoot, owner, pendingRun.runId)) {
        return { content: [{ type: "text", text: "Goal update refused because this is not the accepted autonomous continuation turn." }], details: { error: "no_continuation_authority" } };
      }
      let goal: GoalState = currentGoal;
      const verificationCommand = typeof input.verificationCommand === "string" ? input.verificationCommand.trim() : undefined;
      if (input.verificationCommand !== undefined && !verificationCommand) {
        return { content: [{ type: "text", text: "Verification command must not be empty." }], details: { error: "invalid_verification_command" } };
      }
      if (verificationCommand) {
        goal = { ...goal, verification: { ...goal.verification, commands: [...new Set([...goal.verification.commands, verificationCommand])] }, updatedAt: timestamp.toISOString() };
      }
      const evidenceCommand = typeof input.command === "string" ? input.command.trim() || undefined : undefined;
      if (input.evidence || evidenceCommand || input.outcome) {
        goal = recordEvidence(goal, {
          kind: input.evidenceKind ?? (evidenceCommand ? "verification" : "note"),
          summary: input.evidence ?? input.reason ?? "Goal evidence recorded.",
          command: evidenceCommand,
          outcome: input.outcome,
          goalRevision: goal.goalRevision,
          runId: pendingRun.runId,
        }, timestamp);
      }
      if (input.proposedStatus) {
        const conflictingProposal = pendingRun.toolProposal !== undefined && pendingRun.toolProposal !== input.proposedStatus;
        goal = {
          ...goal,
          pendingRun: {
            ...pendingRun,
            // The first proposal is an immutable record of what the model
            // asked for. A later disagreement is fail-closed at settlement.
            toolProposal: pendingRun.toolProposal ?? input.proposedStatus,
            ...(conflictingProposal ? { toolProposalConflict: true as const } : {}),
          },
          updatedAt: timestamp.toISOString(),
        };
      }
      const persisted = persistGoal(storage, goal, auditEvent("goal_model_update", input.reason ?? "Model recorded goal evidence or proposal.", ctx, timestamp), ctx);
      if (!persisted) return { content: [{ type: "text", text: "Goal update was rejected by storage." }], details: { error: "storage_error" } };
      status.sync(ctx);
      return { content: [{ type: "text", text: `Goal update recorded.\n\n${formatStatus(persisted, undefined, timestamp)}` }], details: { goal: persisted } };
    },
  });

  pi.registerCommand("goal", {
    description: "Set or manage a bounded working-root goal loop",
    async handler(args, ctx: ExtensionCommandContext) {
      const parsed = parseGoalArgs(args);
      const projectRoot = ctx.cwd || process.cwd();
      const timestamp = now();
      const owner = ctx.sessionManager.getSessionId();

      if (parsed.command === "list") {
        try {
          notify(ctx, formatGoalList(storage.listActive()));
        } catch (error) {
          storageError(ctx, error);
        }
        return;
      }

      const readResult = readGoal(storage, projectRoot, ctx);
      if (!readResult.ok) return;
      const existing = readResult.goal;

      if (parsed.command === "status") {
        notify(ctx, formatStatus(existing, existing ? undefined : readLatestAchievement(storage, projectRoot, ctx), timestamp));
        return;
      }

      if (parsed.command === "start") {
        const validated = validateGoalObjective(parsed.value);
        if (!validated.ok) {
          notify(ctx, validated.reason, "warning");
          return;
        }
        if (existing) {
          const conflict = leaseConflict(existing, owner, timestamp);
          if (conflict) {
            notifyLeaseConflict(ctx, conflict);
            return;
          }
          if (existing.status === "complete" && !archiveCompletedGoal(storage, existing, ctx)) return;
        }
        let goal = { ...createGoal(projectRoot, validated.objective, timestamp, randomId()), storageRevision: existing?.storageRevision ?? 0 };
        const safeToSend = ctx.isIdle() && !ctx.hasPendingMessages();
        const prepared = safeToSend ? prepareDispatch(goal, owner, timestamp, randomId) : undefined;
        if (prepared?.goal) goal = prepared.goal;
        else {
          const leased = acquireGoalLease(goal, owner, timestamp);
          if (leased.ok) goal = leased.goal;
        }
        const persisted = persistGoal(storage, goal, auditEvent(prepared?.goal ? "run_dispatched" : "goal_created", "Human started goal.", ctx, timestamp), ctx);
        if (!persisted) return;
        status.sync(ctx);
        if (!prepared?.goal) {
          notify(ctx, `Goal saved but not dispatched${prepared?.reason ? `: ${prepared.reason}` : "; Pi is not idle or messages are pending."}`, "warning");
          return;
        }
        if (sendPrepared(pi, ctx, persisted)) notify(ctx, `Goal started: ${persisted.objective}`);
        return;
      }

      if (!existing) {
        notify(ctx, "No active goal for this working root.", "warning");
        return;
      }
      if (existing.status === "complete" && parsed.command !== "clear") {
        notify(ctx, "This retained completion receipt cannot be edited or otherwise mutated; it is immutable. Inspect it with /goal, remove it with /goal clear, or start a new goal to archive it safely.", "warning");
        return;
      }
      const conflict = leaseConflict(existing, owner, timestamp);
      if (conflict) {
        notifyLeaseConflict(ctx, conflict);
        return;
      }

      if (parsed.command === "pause") {
        const paused = { ...existing, status: "paused" as const, lease: undefined, pendingRun: undefined, updatedAt: timestamp.toISOString() };
        const persisted = persistGoal(storage, paused, auditEvent("goal_paused", "Human paused goal.", ctx, timestamp), ctx);
        if (!persisted) return;
        status.sync(ctx);
        notify(ctx, "Goal paused.");
        return;
      }

      if (parsed.command === "resume") {
        if (!tokenBudgetAllowsResume(existing)) {
          notify(ctx, `Goal cannot resume until its token budget is raised above ${existing.usage?.totalTokens ?? 0} or disabled with /goal budget off.`, "warning");
          return;
        }
        let goal = resumeGoal({ ...existing, pendingRun: undefined }, timestamp);
        const safeToSend = ctx.isIdle() && !ctx.hasPendingMessages();
        const prepared = safeToSend ? prepareDispatch(goal, owner, timestamp, randomId) : undefined;
        if (prepared?.goal) goal = prepared.goal;
        else {
          const leased = acquireGoalLease(goal, owner, timestamp);
          if (leased.ok) goal = leased.goal;
        }
        const persisted = persistGoal(storage, goal, auditEvent(prepared?.goal ? "run_dispatched" : "goal_resumed", "Human resumed goal.", ctx, timestamp), ctx);
        if (!persisted) return;
        status.sync(ctx);
        if (!prepared?.goal) {
          notify(ctx, "Goal resumed but not dispatched because Pi is not idle or messages are pending.", "warning");
          return;
        }
        if (sendPrepared(pi, ctx, persisted)) notify(ctx, "Goal resumed.");
        return;
      }

      if (parsed.command === "clear") {
        if (!clearGoal(storage, projectRoot, existing.storageRevision, auditEvent("goal_cleared", "Human cleared goal.", ctx, timestamp), ctx)) return;
        status.clear(ctx);
        notify(ctx, "Goal cleared.");
        return;
      }

      if (parsed.command === "edit") {
        const validated = validateGoalObjective(parsed.value);
        if (!validated.ok) {
          notify(ctx, validated.reason, "warning");
          return;
        }
        let goal = editGoalObjective(existing, validated.objective, timestamp);
        const safeToSend = ctx.isIdle() && !ctx.hasPendingMessages();
        const prepared = safeToSend ? prepareDispatch(goal, owner, timestamp, randomId) : undefined;
        if (prepared?.goal) goal = prepared.goal;
        else {
          const leased = acquireGoalLease(goal, owner, timestamp);
          if (leased.ok) goal = leased.goal;
        }
        const persisted = persistGoal(storage, goal, auditEvent(prepared?.goal ? "run_dispatched" : "goal_edited", "Human changed objective.", ctx, timestamp), ctx);
        if (!persisted) return;
        status.sync(ctx);
        if (prepared?.goal) {
          if (sendPrepared(pi, ctx, persisted)) notify(ctx, `Goal updated: ${persisted.objective}`);
        } else {
          notify(ctx, `Goal updated but not dispatched: ${persisted.objective}`, "warning");
        }
        return;
      }

      if (parsed.command === "budget") {
        const value = parsed.value.toLowerCase();
        const tokenBudget = value === "off" ? undefined : /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
        if (tokenBudget === null) {
          notify(ctx, "Usage: /goal budget <positive-integer|off>", "warning");
          return;
        }
        const goal = { ...existing, tokenBudget, updatedAt: timestamp.toISOString() };
        const persisted = persistGoal(storage, goal, auditEvent("token_budget_changed", tokenBudget === undefined ? "Human disabled token budget." : `Human set token budget to ${tokenBudget}.`, ctx, timestamp), ctx);
        if (!persisted) return;
        status.sync(ctx);
        notify(ctx, tokenBudget === undefined ? "Goal token budget disabled." : `Goal token budget set to ${tokenBudget} tokens.`);
        return;
      }

      if (parsed.command === "verify") {
        if (!parsed.value) {
          notify(ctx, "Usage: /goal verify <command>", "warning");
          return;
        }
        const goal = {
          ...existing,
          verification: { ...existing.verification, commands: [...new Set([...existing.verification.commands, parsed.value])] },
          updatedAt: timestamp.toISOString(),
        };
        const persisted = persistGoal(storage, goal, auditEvent("verification_added", "Human added verification command.", ctx, timestamp), ctx);
        if (!persisted) return;
        status.sync(ctx);
        notify(ctx, `Verification command added: ${parsed.value}`);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => status.sync(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    clearContinuationAuthority();
    clearAutonomousTracking();
    const projectRoot = ctx.cwd || process.cwd();
    const readResult = readGoal(storage, projectRoot, ctx);
    if (!readResult.ok) {
      status.clear(ctx);
      return;
    }
    const goal = readResult.goal;
    const owner = ctx.sessionManager.getSessionId();
    if (goal?.lease?.sessionId === owner) {
      const timestamp = now();
      persistGoal(storage, releaseGoalLease({ ...goal, pendingRun: undefined }, owner, timestamp), auditEvent("lease_released", "Session shut down.", ctx, timestamp), ctx);
    }
    status.clear(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const projectRoot = event.systemPromptOptions.cwd || ctx.cwd || process.cwd();
    const readResult = readGoal(storage, projectRoot, ctx);
    if (!readResult.ok) return;
    clearContinuationAuthority();
    clearAutonomousTracking();
    let goal = readResult.goal;
    if (!goal || goal.status !== "active") return;
    const owner = ctx.sessionManager.getSessionId();
    const timestamp = now();
    const expired = expireStalePendingRun(goal, timestamp);
    if (expired !== goal) {
      persistGoal(storage, expired, auditEvent("run_expired", "Continuation started after its lease expired.", ctx, timestamp), ctx);
      status.sync(ctx);
      return;
    }
    const conflict = leaseConflict(goal, owner, timestamp);
    if (conflict) return;
    // A goal-owned session keeps its lease warm and receives durable context
    // on ordinary queued user turns too.  Those turns deliberately receive no
    // run IDs, evaluator contract, or update_goal authority.
    if (goal.lease?.sessionId !== owner) return;
    const leased = acquireGoalLease(goal, owner, timestamp);
    if (!leased.ok) return;
    goal = leased.goal;
    const runId = continuationRunId(event.prompt);
    const autonomous = Boolean(runId && goal.pendingRun?.runId === runId && goal.pendingRun.sessionId === owner);
    const persisted = persistGoal(storage, goal, auditEvent("lease_renewed", autonomous ? "Agent continuation turn started." : "Normal agent turn started for active goal.", ctx, timestamp), ctx);
    if (!persisted) return;
    if (autonomous && runId) {
      activeContinuation = { projectRoot, sessionId: owner, runId };
      autonomousChain = { projectRoot, sessionId: owner, runId };
    }
    return { systemPrompt: [event.systemPrompt, buildGoalSystemPrompt(persisted, autonomous)].filter(Boolean).join("\n\n") };
  });

  pi.on("message_start", (event, ctx) => {
    if (!autonomousChain) return;
    const record = messageRecord(event.message);
    if (record?.role !== "user") return;
    const projectRoot = ctx.cwd || process.cwd();
    const owner = ctx.sessionManager.getSessionId();
    if (!matchesRun(autonomousChain, projectRoot, owner, autonomousChain.runId)) return;
    if (continuationRunId(contentText(record.content)) === autonomousChain.runId) return;

    // Pi drains queued follow-ups inside the same low-level agent run. Revoke
    // tool authority before the follow-up model turn can call update_goal, but
    // retain chain identity until agent_end can isolate pre-follow-up usage.
    clearContinuationAuthority();
    clearProviderLimit();
    autonomousInterruption = {
      ...autonomousChain,
      reason: "Autonomous goal run was interrupted by a queued user follow-up; later work was not treated as autonomous.",
    };
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!autonomousChain) return;
    const projectRoot = ctx.cwd || process.cwd();
    const owner = ctx.sessionManager.getSessionId();
    if (matchesRun(autonomousInterruption, projectRoot, owner, autonomousChain.runId)) return;
    if (event.status !== 429) {
      // Every observed response is authoritative for the current attempt.
      clearProviderLimit();
      return;
    }
    const retryAfterEntry = Object.entries(event.headers).find(([name]) => name.toLowerCase() === "retry-after");
    providerLimit = {
      ...autonomousChain,
      retryAfter: typeof retryAfterEntry?.[1] === "string" ? retryAfterEntry[1] : undefined,
    };
  });

  pi.on("agent_end", (event, ctx) => {
    const correlatedProviderLimit = providerLimit;
    const interruption = autonomousInterruption;
    clearContinuationAuthority();
    clearProviderLimit();
    const projectRoot = ctx.cwd || process.cwd();
    const readResult = readGoal(storage, projectRoot, ctx);
    if (!readResult.ok) return;
    const goal = readResult.goal;
    const owner = ctx.sessionManager.getSessionId();
    const timestamp = now();
    if (!goal) return;
    const expired = expireStalePendingRun(goal, timestamp);
    if (expired !== goal) {
      persistGoal(storage, expired, auditEvent("run_expired", "Run ended after its lease expired.", ctx, timestamp), ctx);
      status.sync(ctx);
      return;
    }
    if (!ownsFreshPendingRun(goal, owner, timestamp)) return;
    const messages = event.messages as unknown[];
    const runId = goal.pendingRun.runId;
    const chainCorrelated = matchesRun(autonomousChain, projectRoot, owner, runId);
    if (interruption && matchesRun(interruption, projectRoot, owner, runId)) {
      const followUpIndex = firstNonContinuationUserIndex(messages, runId);
      const autonomousMessages = followUpIndex >= 0 ? messages.slice(0, followUpIndex) : [];
      let updated: GoalState = goal;
      if (autonomousMessages.some((message) => messageRecord(message)?.role === "assistant")) {
        updated = recordRunUsage(updated, sumAssistantUsage(autonomousMessages), timestamp, autonomousRunFingerprint(autonomousMessages));
      }
      const candidate = {
        protocol: "malformed" as const,
        reason: interruption.reason,
      };
      updated = recordRunCandidate(updated, candidate, timestamp);
      updated = recordProviderUsageLimit(updated, undefined, timestamp);
      if (updated === goal) return;
      persistGoal(storage, updated, auditEvent("run_candidate_recorded", interruption.reason, ctx, timestamp), ctx);
      status.sync(ctx);
      return;
    }
    // Pi's agent.continue() retries emit only the new low-level messages, so
    // the original continuation marker is absent. A queued user/follow-up run
    // always introduces a user message and must not inherit chain authority.
    if (!isCurrentContinuation(messages, runId) && !(chainCorrelated && !containsUserMessage(messages))) return;
    const stopReason = assistantStopReason(messages);
    let updated: GoalState = recordRunUsage(goal, sumAssistantUsage(messages), timestamp, autonomousRunFingerprint(messages));
    const terminalUsageLimit = stopReason !== undefined &&
      correlatedProviderLimit !== undefined &&
      correlatedProviderLimit.projectRoot === projectRoot &&
      correlatedProviderLimit.sessionId === owner &&
      correlatedProviderLimit.runId === runId;
    const candidate = stopReason
      ? { protocol: "malformed" as const, source: "assistant_stop" as const, reason: `Assistant turn ended with ${stopReason}.` }
      : parseCurrentRunCandidate(messages, {
          goalId: goal.goalId,
          goalRevision: goal.pendingRun.goalRevision,
          runId,
          evaluationRequestId: goal.pendingRun.evaluationRequestId,
        });
    updated = recordRunCandidate(updated, candidate, timestamp);
    const providerReason = terminalUsageLimit ? `Provider usage limit ended the autonomous run with ${stopReason}.` : undefined;
    updated = recordProviderUsageLimit(updated, providerReason ? { reason: providerReason, retryAfter: correlatedProviderLimit?.retryAfter } : undefined, timestamp);
    if (updated === goal) return;
    persistGoal(storage, updated, auditEvent("run_candidate_recorded", providerReason ?? (candidate.protocol === "valid" ? "Recorded current-run decision and usage." : candidate.reason), ctx, timestamp), ctx);
    status.sync(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const interruption = autonomousInterruption;
    clearContinuationAuthority();
    clearAutonomousTracking();
    const projectRoot = ctx.cwd || process.cwd();
    const readResult = readGoal(storage, projectRoot, ctx);
    if (!readResult.ok) return;
    let goal = readResult.goal;
    const owner = ctx.sessionManager.getSessionId();
    const timestamp = now();
    if (!goal) return;
    const expired = expireStalePendingRun(goal, timestamp);
    if (expired !== goal) {
      persistGoal(storage, expired, auditEvent("run_expired", "Run settled after its lease expired.", ctx, timestamp), ctx);
      status.sync(ctx);
      return;
    }
    if (!ownsFreshPendingRun(goal, owner, timestamp)) return;
    let settlementGoal: GoalState = goal;
    if (interruption && matchesRun(interruption, projectRoot, owner, goal.pendingRun.runId)) {
      settlementGoal = recordRunCandidate(settlementGoal, { protocol: "malformed", reason: interruption.reason }, timestamp);
      settlementGoal = recordProviderUsageLimit(settlementGoal, undefined, timestamp);
    }
    const settled = settlePendingRun(settlementGoal, timestamp);
    if (settled.action === "none") return;
    let persisted = persistGoal(storage, settled.goal, auditEvent("run_settled", settled.reason ?? "Settled goal run.", ctx, timestamp), ctx);
    if (!persisted) return;
    status.sync(ctx);
    if (settled.action === "complete") {
      if (!archiveCompletedGoal(storage, persisted, ctx)) {
        notify(ctx, `Goal complete, but its active receipt was retained: ${settled.reason}`, "warning");
        return;
      }
      const cleared = clearGoal(storage, projectRoot, persisted.storageRevision, auditEvent("goal_completed_archived", "Completed goal archived and active slot cleared.", ctx, timestamp), ctx);
      if (cleared) status.clear(ctx);
      else status.sync(ctx);
      notify(ctx, cleared ? `Goal complete: ${settled.reason}` : `Goal complete and archived, but its active slot was retained: ${settled.reason}`, cleared ? "info" : "warning");
      return;
    }
    if (settled.action !== "dispatch") {
      notify(ctx, `Goal stopped (${settled.action}): ${settled.reason}`, "warning");
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      notify(ctx, "Goal run settled; no continuation was queued because Pi is busy or messages are pending.", "warning");
      return;
    }
    const prepared = prepareDispatch(persisted, owner, timestamp, randomId);
    if (!prepared.goal) {
      notify(ctx, `Goal continuation was not dispatched: ${prepared.reason}`, "warning");
      return;
    }
    persisted = persistGoal(storage, prepared.goal, auditEvent("run_dispatched", "Coordinator dispatched next run.", ctx, timestamp), ctx);
    if (!persisted) return;
    status.sync(ctx);
    sendPrepared(pi, ctx, persisted);
  });
}

export function createGoalLoopExtension(options: GoalLoopExtensionOptions = {}): (pi: ExtensionAPI) => void {
  return (pi) => registerGoalLoop(pi, options);
}

export default function goalLoopExtension(pi: ExtensionAPI): void {
  registerGoalLoop(pi, {});
}

export { GoalStorageAuditError, GoalStorageConflictError, GoalStorageCorruptError };
