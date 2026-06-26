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
}

interface GoalStore {
  goals: Record<string, GoalState>;
}

export interface ParsedGoalArgs {
  command: GoalCommand;
  value: string;
}

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS = 3;
const STATE_PATH = join(homedir(), ".pi", "agent", "goal-loop", "state.json");

const COMMANDS = new Set<GoalCommand>(["status", "pause", "resume", "clear", "edit", "verify"]);

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

export function buildContinuationPrompt(goal: GoalState): string {
  const commands = goal.verification.commands.length
    ? goal.verification.commands.map((command) => `- ${command}`).join("\n")
    : "- No explicit verification commands configured. Use the best project-specific checks you can infer.";

  return [
    "Continue working toward this active goal.",
    "",
    `Goal: ${goal.objective}`,
    `Loop turn: ${goal.turns + 1}/${goal.maxTurns}`,
    "",
    "Verification commands:",
    commands,
    "",
    "Operate as a goal loop:",
    "- inspect the current state",
    "- update or create todos if available",
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

function buildGoalSystemPrompt(goal: GoalState): string {
  return [
    "Active Pi goal loop:",
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Turn budget: ${goal.turns}/${goal.maxTurns}`,
    "",
    "Before stopping, evaluate whether the goal is complete against the objective and any verification command output.",
    "End every response while this goal is active with:",
    "GOAL_STATUS: complete | continue | blocked | needs_user",
    "GOAL_REASON: one short sentence",
  ].join("\n");
}

function parseEvaluationFromText(text: string): GoalEvaluation {
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

function getLastAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: unknown; content?: unknown; message?: { content?: unknown } };
    if (record.role !== "assistant") continue;
    const text = getText(record.content) || getText(record.message?.content);
    if (text) return text;
  }
  return "";
}

function readStore(): GoalStore {
  if (!existsSync(STATE_PATH)) return { goals: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as GoalStore;
    if (!parsed || typeof parsed !== "object" || typeof parsed.goals !== "object") return { goals: {} };
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
  return readStore().goals[goalKey(projectRoot)];
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
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Turns: ${goal.turns}/${goal.maxTurns}`,
    `Verification: ${goal.verification.commands.length ? goal.verification.commands.join(", ") : "none"}`,
    goal.lastEvaluation ? `Last check: ${goal.lastEvaluation.decision} - ${goal.lastEvaluation.reason}` : "Last check: none",
  ].join("\n");
}

function notify(ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }, message: string, type: "info" | "warning" | "error" = "info") {
  ctx.ui.notify(message, type);
}

export default function goalLoopExtension(pi: ExtensionAPI) {
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
        notify(ctx, `Goal started: ${goal.objective}`);
        pi.sendUserMessage(buildContinuationPrompt(goal), { deliverAs: "followUp" });
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
        setProjectGoal({ ...existing, status: "paused", updatedAt: new Date().toISOString() });
        notify(ctx, "Goal paused.");
        return;
      }

      if (parsed.command === "resume") {
        const goal = { ...existing, status: "active" as const, updatedAt: new Date().toISOString() };
        setProjectGoal(goal);
        notify(ctx, "Goal resumed.");
        pi.sendUserMessage(buildContinuationPrompt(goal), { deliverAs: "followUp" });
        return;
      }

      if (parsed.command === "clear") {
        clearProjectGoal(projectRoot);
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
        notify(ctx, `Goal updated: ${goal.objective}`);
        return;
      }

      if (parsed.command === "verify") {
        if (!parsed.value) {
          notify(ctx, "Usage: /goal verify <command>", "warning");
          return;
        }
        const commands = [...existing.verification.commands, parsed.value];
        setProjectGoal({
          ...existing,
          verification: { ...existing.verification, commands },
          updatedAt: new Date().toISOString(),
        });
        notify(ctx, `Verification command added: ${parsed.value}`);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const goal = getProjectGoal(ctx.cwd || process.cwd());
    ctx.ui.setStatus("goal-loop", goal && goal.status === "active" ? `goal ${goal.turns}/${goal.maxTurns}` : undefined);
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

    const assistantText = getLastAssistantText(event.messages as unknown[]);
    const evaluation = parseEvaluationFromText(assistantText);
    const updated = recordEvaluation(goal, evaluation);
    setProjectGoal(updated);
    ctx.ui.setStatus("goal-loop", updated.status === "active" ? `goal ${updated.turns}/${updated.maxTurns}` : undefined);

    if (updated.status === "complete") {
      notify(ctx, `Goal complete: ${evaluation.reason}`);
      return;
    }

    if (updated.status === "blocked" || updated.status === "needs_user") {
      notify(ctx, `Goal stopped (${updated.status}): ${evaluation.reason}`, "warning");
      return;
    }

    if (!shouldAutoContinue(updated)) {
      setProjectGoal({ ...updated, status: "blocked", updatedAt: new Date().toISOString() });
      notify(ctx, `Goal stopped after ${updated.turns}/${updated.maxTurns} turns. Run /goal resume to continue.`, "warning");
      return;
    }

    pi.sendUserMessage(buildContinuationPrompt(updated), { deliverAs: "followUp" });
  });
}
