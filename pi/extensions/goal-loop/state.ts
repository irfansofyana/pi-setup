import { createHash, randomUUID } from "node:crypto";
import { normalize, parse } from "node:path";

export type GoalStatus = "active" | "paused" | "complete" | "blocked" | "needs_user" | "usage_limited" | "token_budget_limited";
export type GoalDecision = "complete" | "continue" | "blocked" | "needs_user";
export type GoalCommand = "start" | "status" | "list" | "pause" | "resume" | "clear" | "edit" | "verify" | "budget";
export type GoalEvidenceKind = "note" | "verification" | "tool";
export type GoalEvidenceOutcome = "passed" | "failed" | "unknown";

export interface GoalEvaluation {
  decision: GoalDecision;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export interface GoalEvidence {
  at: string;
  kind: GoalEvidenceKind;
  summary: string;
  command?: string;
  outcome?: GoalEvidenceOutcome;
  goalRevision: number;
  runId?: string;
}

export interface GoalEvidenceInput {
  kind: GoalEvidenceKind;
  summary: string;
  command?: string;
  outcome?: GoalEvidenceOutcome;
  goalRevision?: number;
  runId?: string;
}

export interface GoalLease {
  sessionId: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface GoalUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    total: number;
  };
}

export interface GoalLimitDetail {
  kind: "usage_limited" | "token_budget_limited";
  reason: string;
  at: string;
  runId?: string;
  retryAfter?: string;
}

export type GoalTerminalProposal = Exclude<GoalDecision, "continue">;

export interface PendingGoalRun {
  runId: string;
  evaluationRequestId: string;
  goalRevision: number;
  sessionId: string;
  dispatchedAt: string;
  toolProposal?: GoalTerminalProposal;
  /** Conflicting model terminal proposals require an explicit human decision. */
  toolProposalConflict?: true;
  /** Durable de-duplication keys for low-level autonomous-run usage. */
  usageRunFingerprints?: string[];
  /** Correlated terminal 429 detail for the latest low-level run. */
  providerUsageLimit?: {
    reason: string;
    retryAfter?: string;
  };
  candidate?: GoalRunCandidate;
}

export interface GoalDecisionRecord {
  goalId: string;
  goalRevision: number;
  runId: string;
  evaluationRequestId: string;
  decision: GoalDecision;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export type GoalRunCandidateProtocol = "valid" | "missing" | "malformed" | "stale" | "duplicate" | "conflict";

export type GoalRunCandidate =
  | {
      protocol: "valid";
      worker: GoalDecisionRecord;
      evaluator?: GoalDecisionRecord;
      source?: "assistant_message" | "assistant_stop";
      reason?: string;
    }
  | {
      protocol: Exclude<GoalRunCandidateProtocol, "valid">;
      reason: string;
      source?: "assistant_message" | "assistant_stop";
      worker?: GoalDecisionRecord;
      evaluator?: GoalDecisionRecord;
    };

export interface GoalState {
  schemaVersion: 2;
  goalId: string;
  goalRevision: number;
  storageRevision: number;
  projectRoot: string;
  objective: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  turns: number;
  evaluatedRuns: number;
  maxTurns: number;
  maxFailedVerificationAttempts: number;
  consecutiveFailedVerificationAttempts: number;
  verification: {
    commands: string[];
    lastResult?: string;
    /**
     * Complete verification history is retained separately from the compact
     * user-facing evidence feed.  Completion must be able to inspect every
     * configured command, even when there are more than ten commands.
     */
    proofs: GoalEvidence[];
  };
  evidence: GoalEvidence[];
  /** Human-owned, opt-in cumulative token ceiling. */
  tokenBudget?: number;
  /** Normalized cumulative Pi assistant usage from autonomous runs only. */
  usage?: GoalUsage;
  limitDetail?: GoalLimitDetail;
  lastEvaluation?: GoalEvaluation;
  lease?: GoalLease;
  pendingRun?: PendingGoalRun;
}

export const GOAL_SCHEMA_VERSION = 2 as const;
export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS = 3;
export const GOAL_LEASE_MS = 4 * 60 * 60 * 1000;
export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

const MAX_EVIDENCE_ENTRIES = 10;
const GOAL_STATUS_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export type GoalObjectiveValidation =
  | { ok: true; objective: string }
  | { ok: false; reason: string };

export function validateGoalObjective(objective: unknown): GoalObjectiveValidation {
  const normalized = typeof objective === "string" ? objective.trim() : "";
  if (!normalized) return { ok: false, reason: "Goal objective must not be empty." };
  if (normalized.length > MAX_GOAL_OBJECTIVE_CHARS) {
    return { ok: false, reason: "Goal objective must be 4,000 characters or fewer." };
  }
  return { ok: true, objective: normalized };
}

export function canonicalProjectRoot(projectRoot: string): string {
  const normalized = normalize(projectRoot);
  const filesystemRoot = parse(normalized).root;
  return normalized === filesystemRoot ? filesystemRoot : normalized.replace(/[\\/]+$/, "");
}

export function goalKey(projectRoot: string): string {
  return createHash("sha256").update(canonicalProjectRoot(projectRoot)).digest("hex").slice(0, 16);
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEvidenceEntry(entry: unknown, fallbackGoalRevision: number): GoalEvidence | undefined {
  if (!isRecord(entry)) return undefined;
  const kind = entry.kind;
  const summary = entry.summary;
  if (kind !== "note" && kind !== "verification" && kind !== "tool") return undefined;
  if (typeof summary !== "string") return undefined;

  const goalRevision = typeof entry.goalRevision === "number" && Number.isFinite(entry.goalRevision)
    ? Math.max(1, Math.trunc(entry.goalRevision))
    : fallbackGoalRevision;

  return {
    at: typeof entry.at === "string" ? entry.at : new Date(0).toISOString(),
    kind,
    summary,
    command: typeof entry.command === "string" ? entry.command : undefined,
    outcome: entry.outcome === "passed" || entry.outcome === "failed" || entry.outcome === "unknown" ? entry.outcome : undefined,
    goalRevision,
    runId: typeof entry.runId === "string" ? entry.runId : undefined,
  };
}

function normalizeNonNegativeNumber(value: unknown, integer = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return integer ? Math.trunc(value) : value;
}

export function normalizeGoalUsage(usage: unknown): GoalUsage | undefined {
  if (!isRecord(usage) || !isRecord(usage.cost)) return undefined;
  const input = normalizeNonNegativeNumber(usage.input, true);
  const output = normalizeNonNegativeNumber(usage.output, true);
  const cacheRead = normalizeNonNegativeNumber(usage.cacheRead, true);
  const cacheWrite = normalizeNonNegativeNumber(usage.cacheWrite, true);
  const totalTokens = normalizeNonNegativeNumber(usage.totalTokens, true);
  const totalCost = normalizeNonNegativeNumber(usage.cost.total);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || totalTokens === undefined || totalCost === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens, cost: { total: totalCost } };
}

function normalizeLimitDetail(detail: unknown): GoalLimitDetail | undefined {
  if (!isRecord(detail)) return undefined;
  if (detail.kind !== "usage_limited" && detail.kind !== "token_budget_limited") return undefined;
  if (typeof detail.reason !== "string" || !detail.reason.trim() || typeof detail.at !== "string" || !Number.isFinite(Date.parse(detail.at))) return undefined;
  return {
    kind: detail.kind,
    reason: detail.reason.trim(),
    at: detail.at,
    runId: typeof detail.runId === "string" && detail.runId ? detail.runId : undefined,
    retryAfter: typeof detail.retryAfter === "string" && detail.retryAfter ? detail.retryAfter : undefined,
  };
}

export function addGoalUsage(current: GoalUsage | undefined, added: GoalUsage): GoalUsage {
  return {
    input: (current?.input ?? 0) + added.input,
    output: (current?.output ?? 0) + added.output,
    cacheRead: (current?.cacheRead ?? 0) + added.cacheRead,
    cacheWrite: (current?.cacheWrite ?? 0) + added.cacheWrite,
    totalTokens: (current?.totalTokens ?? 0) + added.totalTokens,
    cost: { total: (current?.cost.total ?? 0) + added.cost.total },
  };
}

function normalizeEvaluation(evaluation: unknown): GoalEvaluation | undefined {
  if (!isRecord(evaluation)) return undefined;
  const decision = evaluation.decision;
  const reason = evaluation.reason;
  if (decision !== "complete" && decision !== "continue" && decision !== "blocked" && decision !== "needs_user") return undefined;
  if (typeof reason !== "string") return undefined;
  const confidence = evaluation.confidence;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") return undefined;
  return { decision, reason, confidence };
}

export function createGoal(projectRoot: string, objective: string, now = new Date(), goalId: string = randomUUID()): GoalState {
  const timestamp = nowIso(now);
  return {
    schemaVersion: GOAL_SCHEMA_VERSION,
    goalId,
    goalRevision: 1,
    storageRevision: 0,
    projectRoot: canonicalProjectRoot(projectRoot),
    objective,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: 0,
    evaluatedRuns: 0,
    maxTurns: DEFAULT_MAX_TURNS,
    maxFailedVerificationAttempts: DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS,
    consecutiveFailedVerificationAttempts: 0,
    verification: { commands: [], proofs: [] },
    evidence: [],
  };
}

export function normalizeGoalState(goal: GoalState | Record<string, unknown>): GoalState {
  const raw = isRecord(goal) ? goal : {};
  const goalRevision = typeof raw.goalRevision === "number" && Number.isFinite(raw.goalRevision) ? Math.max(1, Math.trunc(raw.goalRevision)) : 1;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .map((entry) => normalizeEvidenceEntry(entry, goalRevision))
        .filter((entry): entry is GoalEvidence => Boolean(entry))
    : [];
  const rawVerification = isRecord(raw.verification) ? raw.verification : {};
  const verificationCommands = Array.isArray(rawVerification.commands)
    ? [...new Set(rawVerification.commands.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))]
    : [];
  const verificationProofs = Array.isArray(rawVerification.proofs)
    ? rawVerification.proofs
        .map((entry) => normalizeEvidenceEntry(entry, goalRevision))
        .filter((entry): entry is GoalEvidence => entry !== undefined && entry.kind === "verification")
    : evidence.filter((entry) => entry.kind === "verification");
  const turns = typeof raw.turns === "number" && Number.isFinite(raw.turns) ? Math.max(0, Math.trunc(raw.turns)) : 0;

  return {
    schemaVersion: GOAL_SCHEMA_VERSION,
    goalId: typeof raw.goalId === "string" ? raw.goalId : randomUUID(),
    goalRevision,
    storageRevision: typeof raw.storageRevision === "number" && Number.isFinite(raw.storageRevision) ? Math.max(0, Math.trunc(raw.storageRevision)) : 0,
    projectRoot: typeof raw.projectRoot === "string" ? canonicalProjectRoot(raw.projectRoot) : "",
    objective: typeof raw.objective === "string" ? raw.objective : "",
    status: raw.status === "active" || raw.status === "paused" || raw.status === "complete" || raw.status === "blocked" || raw.status === "needs_user" || raw.status === "usage_limited" || raw.status === "token_budget_limited" ? raw.status : "active",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    turns,
    evaluatedRuns: typeof raw.evaluatedRuns === "number" && Number.isFinite(raw.evaluatedRuns) ? Math.max(0, Math.trunc(raw.evaluatedRuns)) : turns,
    maxTurns: typeof raw.maxTurns === "number" && Number.isFinite(raw.maxTurns) ? Math.max(1, Math.trunc(raw.maxTurns)) : DEFAULT_MAX_TURNS,
    maxFailedVerificationAttempts:
      typeof raw.maxFailedVerificationAttempts === "number" && Number.isFinite(raw.maxFailedVerificationAttempts)
        ? Math.max(1, Math.trunc(raw.maxFailedVerificationAttempts))
        : DEFAULT_MAX_FAILED_VERIFICATION_ATTEMPTS,
    consecutiveFailedVerificationAttempts:
      typeof raw.consecutiveFailedVerificationAttempts === "number" && Number.isFinite(raw.consecutiveFailedVerificationAttempts)
        ? Math.max(0, Math.trunc(raw.consecutiveFailedVerificationAttempts))
        : 0,
    verification: {
      commands: verificationCommands,
      lastResult: typeof rawVerification.lastResult === "string" ? rawVerification.lastResult : undefined,
      proofs: verificationProofs,
    },
    evidence,
    tokenBudget: typeof raw.tokenBudget === "number" && Number.isInteger(raw.tokenBudget) && raw.tokenBudget > 0 ? raw.tokenBudget : undefined,
    usage: normalizeGoalUsage(raw.usage),
    limitDetail: normalizeLimitDetail(raw.limitDetail),
    lastEvaluation: normalizeEvaluation(raw.lastEvaluation),
    lease: normalizeLease(raw.lease),
    pendingRun: normalizePendingRun(raw.pendingRun),
  };
}

function normalizeLease(lease: unknown): GoalLease | undefined {
  if (!isRecord(lease)) return undefined;
  if (typeof lease.sessionId !== "string" || typeof lease.acquiredAt !== "string" || typeof lease.renewedAt !== "string" || typeof lease.expiresAt !== "string") {
    return undefined;
  }
  return {
    sessionId: lease.sessionId,
    acquiredAt: lease.acquiredAt,
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
  };
}

function normalizePendingRun(pendingRun: unknown): PendingGoalRun | undefined {
  if (!isRecord(pendingRun)) return undefined;
  if (
    typeof pendingRun.runId !== "string" ||
    typeof pendingRun.evaluationRequestId !== "string" ||
    typeof pendingRun.sessionId !== "string" ||
    typeof pendingRun.goalRevision !== "number" ||
    typeof pendingRun.dispatchedAt !== "string"
  ) {
    return undefined;
  }

  const result: PendingGoalRun = {
    runId: pendingRun.runId,
    evaluationRequestId: pendingRun.evaluationRequestId,
    goalRevision: Math.max(1, Math.trunc(pendingRun.goalRevision)),
    sessionId: pendingRun.sessionId,
    dispatchedAt: pendingRun.dispatchedAt,
  };

  if (pendingRun.toolProposal === "complete" || pendingRun.toolProposal === "blocked" || pendingRun.toolProposal === "needs_user") {
    result.toolProposal = pendingRun.toolProposal;
  }
  if (pendingRun.toolProposalConflict === true) result.toolProposalConflict = true;
  if (Array.isArray(pendingRun.usageRunFingerprints)) {
    result.usageRunFingerprints = [...new Set(pendingRun.usageRunFingerprints.filter((value): value is string => typeof value === "string" && Boolean(value)))];
  }
  if (isRecord(pendingRun.providerUsageLimit) && typeof pendingRun.providerUsageLimit.reason === "string" && pendingRun.providerUsageLimit.reason.trim()) {
    result.providerUsageLimit = {
      reason: pendingRun.providerUsageLimit.reason.trim(),
      retryAfter: typeof pendingRun.providerUsageLimit.retryAfter === "string" && pendingRun.providerUsageLimit.retryAfter ? pendingRun.providerUsageLimit.retryAfter : undefined,
    };
  }
  if (pendingRun.candidate) {
    result.candidate = normalizeRunCandidate(pendingRun.candidate);
  }
  return result;
}

function normalizeDecisionRecord(record: unknown): GoalDecisionRecord | undefined {
  if (!isRecord(record)) return undefined;
  if (typeof record.goalId !== "string" || typeof record.goalRevision !== "number" || typeof record.runId !== "string" || typeof record.evaluationRequestId !== "string" || typeof record.reason !== "string") {
    return undefined;
  }
  if (record.decision !== "complete" && record.decision !== "continue" && record.decision !== "blocked" && record.decision !== "needs_user") return undefined;
  if (record.confidence !== "low" && record.confidence !== "medium" && record.confidence !== "high") return undefined;
  return {
    goalId: record.goalId,
    goalRevision: Math.max(1, Math.trunc(record.goalRevision)),
    runId: record.runId,
    evaluationRequestId: record.evaluationRequestId,
    decision: record.decision,
    reason: record.reason,
    confidence: record.confidence,
  };
}

function normalizeRunCandidate(candidate: unknown): GoalRunCandidate | undefined {
  if (!isRecord(candidate) || typeof candidate.protocol !== "string") return undefined;
  if (candidate.protocol === "valid") {
    const worker = normalizeDecisionRecord(candidate.worker);
    if (!worker) return undefined;
    const evaluator = normalizeDecisionRecord(candidate.evaluator);
    return {
      protocol: "valid",
      worker,
      evaluator,
      source: candidate.source === "assistant_message" || candidate.source === "assistant_stop" ? candidate.source : undefined,
      reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
    };
  }
  if (candidate.protocol === "missing" || candidate.protocol === "malformed" || candidate.protocol === "stale" || candidate.protocol === "duplicate" || candidate.protocol === "conflict") {
    return {
      protocol: candidate.protocol,
      reason: typeof candidate.reason === "string" ? candidate.reason : "Protocol error.",
      source: candidate.source === "assistant_message" || candidate.source === "assistant_stop" ? candidate.source : undefined,
    };
  }
  return undefined;
}

export function recordEvidence(goal: GoalState, evidence: GoalEvidenceInput, now = new Date()): GoalState {
  const timestamp = nowIso(now);
  const goalRevision = typeof evidence.goalRevision === "number" && Number.isFinite(evidence.goalRevision)
    ? Math.max(1, Math.trunc(evidence.goalRevision))
    : goal.goalRevision;
  const entry: GoalEvidence = {
    at: timestamp,
    kind: evidence.kind,
    summary: evidence.summary,
    command: evidence.command,
    outcome: evidence.outcome,
    goalRevision,
    runId: evidence.runId,
  };

  const verification = entry.kind === "verification"
    ? {
        ...goal.verification,
        lastResult: `${entry.outcome ?? "unknown"}: ${entry.summary}`,
        proofs: [...(goal.verification.proofs ?? []), entry],
      }
    : goal.verification;

  const consecutiveFailedVerificationAttempts = entry.kind === "verification"
    ? entry.outcome === "failed"
      ? goal.consecutiveFailedVerificationAttempts + 1
      : entry.outcome === "passed"
        ? 0
        : goal.consecutiveFailedVerificationAttempts
    : goal.consecutiveFailedVerificationAttempts;

  return {
    ...goal,
    verification,
    evidence: [...goal.evidence, entry].slice(-MAX_EVIDENCE_ENTRIES),
    consecutiveFailedVerificationAttempts,
    updatedAt: timestamp,
  };
}

export function editGoalObjective(goal: GoalState, objective: string, now = new Date()): GoalState {
  return {
    ...goal,
    objective,
    goalRevision: goal.goalRevision + 1,
    status: "active",
    turns: 0,
    consecutiveFailedVerificationAttempts: 0,
    lastEvaluation: undefined,
    limitDetail: undefined,
    pendingRun: undefined,
    evidence: [],
    verification: {
      commands: [...goal.verification.commands],
      proofs: [],
    },
    updatedAt: nowIso(now),
  };
}

export type LeaseResult =
  | { ok: true; goal: GoalState }
  | { ok: false; goal: GoalState; ownerSessionId: string; expiresAt: string };

export function acquireGoalLease(goal: GoalState, sessionId: string, now = new Date()): LeaseResult {
  const timestamp = nowIso(now);
  const existing = goal.lease;
  if (existing && existing.sessionId !== sessionId && Date.parse(existing.expiresAt) > now.getTime()) {
    return { ok: false, goal, ownerSessionId: existing.sessionId, expiresAt: existing.expiresAt };
  }

  const acquiredAt = existing?.sessionId === sessionId ? existing.acquiredAt : timestamp;
  return {
    ok: true,
    goal: {
      ...goal,
      lease: {
        sessionId,
        acquiredAt,
        renewedAt: timestamp,
        expiresAt: new Date(now.getTime() + GOAL_LEASE_MS).toISOString(),
      },
      updatedAt: timestamp,
    },
  };
}

export function renewGoalLease(goal: GoalState, sessionId: string, now = new Date()): LeaseResult {
  return acquireGoalLease(goal, sessionId, now);
}

export function releaseGoalLease(goal: GoalState, sessionId: string, now = new Date()): GoalState {
  if (!goal.lease || goal.lease.sessionId !== sessionId) return goal;
  return {
    ...goal,
    lease: undefined,
    updatedAt: nowIso(now),
  };
}

export interface PendingRunInput {
  runId: string;
  evaluationRequestId: string;
}

export type PendingRunResult =
  | { ok: true; goal: GoalState }
  | { ok: false; goal: GoalState; reason: string };

export function createPendingRun(goal: GoalState, sessionId: string, now = new Date(), input: PendingRunInput): PendingRunResult {
  if (goal.status !== "active") {
    return { ok: false, goal, reason: `Goal is ${goal.status}.` };
  }
  if (!goal.lease || goal.lease.sessionId !== sessionId) {
    return { ok: false, goal, reason: "Lease not owned by this session." };
  }
  if (goal.pendingRun) {
    return { ok: false, goal, reason: "Pending run already exists." };
  }

  return {
    ok: true,
    goal: {
      ...goal,
      pendingRun: {
        runId: input.runId,
        evaluationRequestId: input.evaluationRequestId,
        goalRevision: goal.goalRevision,
        sessionId,
        dispatchedAt: nowIso(now),
      },
      updatedAt: nowIso(now),
    },
  };
}

export function recordRunCandidate(goal: GoalState, candidate: GoalRunCandidate, now = new Date()): GoalState {
  const pendingRun = goal.pendingRun;
  if (!pendingRun) return goal;

  const matches = candidate.protocol === "valid"
    ? candidate.worker.goalId === goal.goalId &&
      candidate.worker.goalRevision === pendingRun.goalRevision &&
      candidate.worker.runId === pendingRun.runId &&
      candidate.worker.evaluationRequestId === pendingRun.evaluationRequestId &&
      (!candidate.evaluator ||
        (candidate.evaluator.goalId === goal.goalId &&
          candidate.evaluator.goalRevision === pendingRun.goalRevision &&
          candidate.evaluator.runId === pendingRun.runId &&
          candidate.evaluator.evaluationRequestId === pendingRun.evaluationRequestId))
    : true;

  if (!matches) return goal;
  if (candidate.protocol !== "valid" && candidate.protocol !== "missing" && candidate.protocol !== "malformed" && candidate.protocol !== "stale" && candidate.protocol !== "duplicate" && candidate.protocol !== "conflict") {
    return goal;
  }

  if (JSON.stringify(pendingRun.candidate) === JSON.stringify(candidate)) return goal;
  return {
    ...goal,
    pendingRun: {
      ...pendingRun,
      candidate,
    },
    updatedAt: nowIso(now),
  };
}

export function recordRunUsage(goal: GoalState, usage: GoalUsage, now = new Date(), fingerprint = "current-run"): GoalState {
  const pendingRun = goal.pendingRun;
  if (!pendingRun || pendingRun.usageRunFingerprints?.includes(fingerprint)) return goal;
  return {
    ...goal,
    usage: addGoalUsage(goal.usage, usage),
    pendingRun: { ...pendingRun, usageRunFingerprints: [...(pendingRun.usageRunFingerprints ?? []), fingerprint] },
    updatedAt: nowIso(now),
  };
}

export function recordProviderUsageLimit(goal: GoalState, detail: PendingGoalRun["providerUsageLimit"] | undefined, now = new Date()): GoalState {
  const pendingRun = goal.pendingRun;
  if (!pendingRun) return goal;
  if (JSON.stringify(pendingRun.providerUsageLimit) === JSON.stringify(detail)) return goal;
  return {
    ...goal,
    pendingRun: { ...pendingRun, providerUsageLimit: detail },
    updatedAt: nowIso(now),
  };
}

export function markUsageLimited(goal: GoalState, reason: string, now = new Date(), detail: { runId?: string; retryAfter?: string } = {}): GoalState {
  return {
    ...goal,
    status: "usage_limited",
    lease: undefined,
    pendingRun: undefined,
    limitDetail: {
      kind: "usage_limited",
      reason,
      at: nowIso(now),
      runId: detail.runId,
      retryAfter: detail.retryAfter,
    },
    updatedAt: nowIso(now),
  };
}

function freshVerificationEvidence(goal: GoalState, runId: string): boolean {
  // Older persisted/test-created states predate the separate proof ledger.
  // Their compact evidence remains a safe compatibility fallback.
  const proofs = goal.verification.proofs ?? goal.evidence.filter((entry) => entry.kind === "verification");
  const freshPassedEvidence = proofs.some((entry) =>
    entry.kind === "verification" &&
    entry.goalRevision === goal.goalRevision &&
    entry.runId === runId &&
    entry.outcome === "passed",
  );
  if (!freshPassedEvidence) return false;

  return goal.verification.commands.every((command) => {
    for (let index = proofs.length - 1; index >= 0; index -= 1) {
      const entry = proofs[index];
      if (entry.kind === "verification" && entry.goalRevision === goal.goalRevision && entry.runId === runId && entry.command === command) {
        return entry.outcome === "passed";
      }
    }
    return false;
  });
}

function candidateDecision(candidate: GoalRunCandidate | undefined): GoalDecision | undefined {
  if (!candidate) return undefined;
  if (candidate.protocol !== "valid") return candidate.protocol === "missing" || candidate.protocol === "malformed" || candidate.protocol === "stale" || candidate.protocol === "duplicate" || candidate.protocol === "conflict" ? "needs_user" : undefined;
  return candidate.evaluator?.decision ?? candidate.worker.decision;
}

function candidateReason(candidate: GoalRunCandidate | undefined): string {
  if (!candidate) return "No candidate recorded.";
  if (candidate.protocol !== "valid") return candidate.reason;
  return candidate.evaluator?.reason ?? candidate.worker.reason;
}

function candidateConfidence(candidate: GoalRunCandidate | undefined): "low" | "medium" | "high" | undefined {
  if (!candidate || candidate.protocol !== "valid") return undefined;
  return candidate.evaluator?.confidence ?? candidate.worker.confidence;
}

export type SettleAction = "none" | "dispatch" | "complete" | "blocked" | "needs_user" | "usage_limited" | "token_budget_limited";

export interface SettleResult {
  goal: GoalState;
  action: SettleAction;
  reason?: string;
}

/**
 * A pending run cannot safely be correlated after its lease expires.  Mark it
 * for human attention instead of leaving the goal permanently busy.
 */
export function expireStalePendingRun(goal: GoalState, now = new Date()): GoalState {
  if (!goal.pendingRun || !goal.lease || Date.parse(goal.lease.expiresAt) > now.getTime()) return goal;
  return {
    ...goal,
    status: "needs_user",
    lease: undefined,
    pendingRun: undefined,
    lastEvaluation: {
      decision: "needs_user",
      reason: "Pending autonomous run expired before it could settle.",
      confidence: "low",
    },
    updatedAt: nowIso(now),
  };
}

export function settlePendingRun(goal: GoalState, now = new Date()): SettleResult {
  const pendingRun = goal.pendingRun;
  if (!pendingRun || !pendingRun.candidate) {
    return { goal, action: "none" };
  }

  const candidate = pendingRun.candidate;

  if (pendingRun.toolProposalConflict) {
    return {
      goal: {
        ...goal,
        status: "needs_user",
        lease: undefined,
        pendingRun: undefined,
        updatedAt: nowIso(now),
        lastEvaluation: {
          decision: "needs_user",
          reason: "Conflicting model terminal proposals were recorded for this run.",
          confidence: "low",
        },
      },
      action: "needs_user",
      reason: "Conflicting model terminal proposals were recorded for this run.",
    };
  }

  if (pendingRun.providerUsageLimit && candidate.source === "assistant_stop" && /Assistant turn ended with (aborted|error)\./.test(candidate.reason ?? "")) {
    return {
      goal: markUsageLimited(goal, pendingRun.providerUsageLimit.reason, now, {
        runId: pendingRun.runId,
        retryAfter: pendingRun.providerUsageLimit.retryAfter,
      }),
      action: "usage_limited",
      reason: pendingRun.providerUsageLimit.reason,
    };
  }

  if (candidate.protocol !== "valid") {
    const stopped = candidate.source === "assistant_stop" && /Assistant turn ended with (aborted|error)\./.test(candidate.reason);
    return {
      goal: {
        ...goal,
        status: stopped ? "blocked" : "needs_user",
        lease: undefined,
        lastEvaluation: {
          decision: stopped ? "blocked" : "needs_user",
          reason: candidateReason(candidate),
          confidence: "low",
        },
        pendingRun: undefined,
        updatedAt: nowIso(now),
      },
      action: stopped ? "blocked" : "needs_user",
      reason: candidateReason(candidate),
    };
  }

  if (pendingRun.toolProposal && candidate.worker.decision !== pendingRun.toolProposal) {
    return {
      goal: {
        ...goal,
        status: "needs_user",
        lease: undefined,
        pendingRun: undefined,
        updatedAt: nowIso(now),
        lastEvaluation: {
          decision: "needs_user",
          reason: "Worker decision does not match its stored terminal proposal.",
          confidence: "low",
        },
      },
      action: "needs_user",
      reason: "Worker decision does not match its stored terminal proposal.",
    };
  }

  if (
    candidate.evaluator &&
    candidate.evaluator.decision !== candidate.worker.decision &&
    !(candidate.worker.decision !== "continue" && candidate.evaluator.decision === "continue")
  ) {
    return {
      goal: {
        ...goal,
        status: "needs_user",
        lease: undefined,
        pendingRun: undefined,
        updatedAt: nowIso(now),
        lastEvaluation: {
          decision: "needs_user",
          reason: "Worker and evaluator decisions conflict.",
          confidence: "low",
        },
      },
      action: "needs_user",
      reason: "Worker and evaluator decisions conflict.",
    };
  }

  const effectiveDecision = candidateDecision(candidate);
  if (!effectiveDecision) {
    return {
      goal: {
        ...goal,
        status: "needs_user",
        lease: undefined,
        pendingRun: undefined,
        updatedAt: nowIso(now),
      },
      action: "needs_user",
      reason: "No decision found.",
    };
  }

  if (goal.consecutiveFailedVerificationAttempts >= goal.maxFailedVerificationAttempts) {
    return {
      goal: {
        ...goal,
        status: "blocked",
        lease: undefined,
        pendingRun: undefined,
        updatedAt: nowIso(now),
        lastEvaluation: {
          decision: "blocked",
          reason: "Verification failure limit reached.",
          confidence: "high",
        },
      },
      action: "blocked",
      reason: "Verification failure limit reached.",
    };
  }

  if (effectiveDecision === "continue") {
    const nextGoal: GoalState = {
      ...goal,
      turns: goal.turns + 1,
      lastEvaluation: {
        decision: "continue",
        reason: candidateReason(candidate),
        confidence: candidateConfidence(candidate) ?? "medium",
      },
      pendingRun: undefined,
      updatedAt: nowIso(now),
    };
    if (nextGoal.tokenBudget !== undefined && (nextGoal.usage?.totalTokens ?? 0) >= nextGoal.tokenBudget) {
      const reason = `Goal token budget reached (${nextGoal.usage?.totalTokens ?? 0}/${nextGoal.tokenBudget}).`;
      return {
        goal: {
          ...nextGoal,
          status: "token_budget_limited",
          lease: undefined,
          limitDetail: {
            kind: "token_budget_limited",
            reason,
            at: nowIso(now),
            runId: pendingRun.runId,
          },
        },
        action: "token_budget_limited",
        reason,
      };
    }
    if (nextGoal.turns >= nextGoal.maxTurns) {
      return {
        goal: {
          ...nextGoal,
          status: "blocked",
          lease: undefined,
        },
        action: "blocked",
        reason: "Goal turn budget exhausted.",
      };
    }
    return {
      goal: nextGoal,
      action: "dispatch",
      reason: candidateReason(candidate),
    };
  }

  if (effectiveDecision === "complete") {
    const evaluator = candidate.evaluator;
    if (!evaluator || evaluator.decision !== "complete" || evaluator.confidence !== "high") {
      return {
        goal: {
          ...goal,
          status: "needs_user",
          lease: undefined,
          pendingRun: undefined,
          updatedAt: nowIso(now),
          lastEvaluation: {
            decision: "needs_user",
            reason: "Completion lacks high-confidence evaluator approval.",
            confidence: "low",
          },
        },
        action: "needs_user",
        reason: "Completion lacks high-confidence evaluator approval.",
      };
    }
    if (!freshVerificationEvidence(goal, pendingRun.runId)) {
      return {
        goal: {
          ...goal,
          status: "needs_user",
          lease: undefined,
          pendingRun: undefined,
          updatedAt: nowIso(now),
          lastEvaluation: {
            decision: "needs_user",
            reason: "Fresh verification evidence is missing.",
            confidence: "low",
          },
        },
        action: "needs_user",
        reason: "Fresh verification evidence is missing.",
      };
    }
    return {
      goal: {
        ...goal,
        status: "complete",
        lease: undefined,
        lastEvaluation: {
          decision: "complete",
          reason: candidateReason(candidate),
          confidence: evaluator.confidence,
        },
        pendingRun: undefined,
        updatedAt: nowIso(now),
      },
      action: "complete",
      reason: candidateReason(candidate),
    };
  }

  if (effectiveDecision === "blocked") {
    const evaluator = candidate.evaluator;
    if (!evaluator || evaluator.decision !== "blocked") {
      return {
        goal: {
          ...goal,
          status: "needs_user",
          lease: undefined,
          pendingRun: undefined,
          updatedAt: nowIso(now),
          lastEvaluation: {
            decision: "needs_user",
            reason: "Blocked status lacks matching evaluator approval.",
            confidence: "low",
          },
        },
        action: "needs_user",
        reason: "Blocked status lacks matching evaluator approval.",
      };
    }
    return {
      goal: {
        ...goal,
        status: "blocked",
        lease: undefined,
        lastEvaluation: {
          decision: "blocked",
          reason: candidateReason(candidate),
          confidence: evaluator.confidence,
        },
        pendingRun: undefined,
        updatedAt: nowIso(now),
      },
      action: "blocked",
      reason: candidateReason(candidate),
    };
  }

  return {
    goal: {
      ...goal,
      status: "needs_user",
      lease: undefined,
      pendingRun: undefined,
      updatedAt: nowIso(now),
      lastEvaluation: {
        decision: "needs_user",
        reason: candidateReason(candidate),
        confidence: "low",
      },
    },
    action: "needs_user",
    reason: candidateReason(candidate),
  };
}

export function tokenBudgetAllowsResume(goal: GoalState): boolean {
  return goal.tokenBudget === undefined || (goal.usage?.totalTokens ?? 0) < goal.tokenBudget;
}

export function resumeGoal(goal: GoalState, now = new Date()): GoalState {
  if (!tokenBudgetAllowsResume(goal)) return goal;
  return {
    ...goal,
    status: "active",
    limitDetail: undefined,
    maxTurns: goal.turns >= goal.maxTurns ? goal.turns + DEFAULT_MAX_TURNS : goal.maxTurns,
    updatedAt: nowIso(now),
  };
}

export function shouldAutoContinue(goal: GoalState): boolean {
  return goal.status === "active" && goal.turns < goal.maxTurns;
}

export function goalStatusText(goal: GoalState | undefined, frame = 0): string | undefined {
  if (!goal || goal.status !== "active") return undefined;
  return `goal ${GOAL_STATUS_FRAMES[frame % GOAL_STATUS_FRAMES.length]} ${goal.turns}/${goal.maxTurns}`;
}
