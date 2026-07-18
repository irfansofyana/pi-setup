import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { canonicalProjectRoot, goalKey, normalizeGoalState, type GoalDecisionRecord, type GoalRunCandidate, type GoalState } from "./state.ts";

export interface GoalAuditEvent {
  type: string;
  at: string;
  reason?: string;
  [key: string]: unknown;
}

export interface GoalStorageOptions {
  storageRoot?: string;
  legacyStatePath?: string;
  auditRoot?: string;
  corruptRoot?: string;
  archiveRoot?: string;
  /** Test seam. Production uses a same-host `kill(pid, 0)` liveness check. */
  isProcessAlive?: (pid: number) => boolean;
  /** Test seam. Production reads the OS process start time via `ps`. */
  getProcessStartToken?: (pid: number) => string | undefined;
  /** Test seam invoked only after a fully initialized lock record is published. */
  onLockAcquired?: (lockPath: string) => void;
}

const LOCK_STALE_MS = 15 * 60 * 1000;

interface LockRecord {
  ownerId: string;
  createdAt: string;
  pid: number;
  processStartToken: string;
}

interface LockReclaimRecord {
  ownerId: string;
  pid: number;
  processStartToken?: string;
  claimedAt: string;
  lock: {
    ownerId: string;
    createdAt: string;
    processStartToken?: string;
    dev: number;
    ino: number;
  };
}

export class GoalStorageCorruptError extends Error {
  readonly originalPath: string;
  readonly quarantinedPath: string;

  constructor(originalPath: string, quarantinedPath: string) {
    super(`Goal loop state was corrupt and quarantined: ${quarantinedPath}`);
    this.name = "GoalStorageCorruptError";
    this.originalPath = originalPath;
    this.quarantinedPath = quarantinedPath;
  }
}

export class GoalStorageConflictError extends Error {
  constructor(message = "Stale storage revision; reload goal state before writing.") {
    super(message);
    this.name = "GoalStorageConflictError";
  }
}

/** The state transition committed, but its append-only audit record did not. */
export class GoalStorageAuditError extends Error {
  readonly committedState?: GoalState;
  readonly cleared: boolean;

  constructor(message: string, options: { committedState?: GoalState; cleared?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "GoalStorageAuditError";
    this.committedState = options.committedState;
    this.cleared = options.cleared === true;
  }
}

export interface GoalStorage {
  readonly legacyStatePath: string;
  statePathFor(projectRoot: string): string;
  archivePathFor(projectRoot: string, goalId: string): string;
  read(projectRoot: string): GoalState | undefined;
  readLatestCompleted(projectRoot: string): GoalState | undefined;
  listActive(): GoalState[];
  write(goal: GoalState, expectedStorageRevision: number, event: GoalAuditEvent): GoalState;
  archive(goal: GoalState): GoalState;
  clear(projectRoot: string, expectedStorageRevision: number, event: GoalAuditEvent): void;
  stateExists(projectRoot: string): boolean;
  readAuditText(projectRoot: string): string;
  listTemporaryFiles(): string[];
  corruptFiles(): string[];
}

function defaultPath(...parts: string[]): string {
  return join(homedir(), ".pi", "agent", "goal-loop", ...parts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isLockReclaimRecord(value: unknown): value is LockReclaimRecord {
  if (!isRecord(value) || typeof value.ownerId !== "string" || !value.ownerId || !isIntegerAtLeast(value.pid, 1) || !isTimestamp(value.claimedAt) || !isRecord(value.lock)) return false;
  return (value.processStartToken === undefined || typeof value.processStartToken === "string") &&
    typeof value.lock.ownerId === "string" &&
    Boolean(value.lock.ownerId) &&
    isTimestamp(value.lock.createdAt) &&
    typeof value.lock.dev === "number" &&
    Number.isInteger(value.lock.dev) &&
    typeof value.lock.ino === "number" &&
    Number.isInteger(value.lock.ino) &&
    (value.lock.processStartToken === undefined || typeof value.lock.processStartToken === "string");
}

/**
 * `kill(pid, 0)` does not signal the process; it only asks the OS whether the
 * PID exists. EPERM still means the process exists, so fail closed there and
 * on every unexpected platform error.
 */
function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ESRCH");
  }
}

/**
 * PIDs are reusable. On macOS `lstart` is stable for one process generation,
 * so pairing it with a PID distinguishes a dead owner from a later process
 * that inherited its PID. Failure to inspect a live PID is intentionally
 * represented as `undefined` and handled fail-closed by `isLiveOwner`.
 */
function getProcessStartToken(pid: number): string | undefined {
  try {
    const token = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function assertDecisionRecord(value: unknown): asserts value is GoalDecisionRecord {
  if (!isRecord(value)) throw new TypeError("Goal decision record is invalid.");
  if (typeof value.goalId !== "string" || !value.goalId || !isIntegerAtLeast(value.goalRevision, 1)) throw new TypeError("Goal decision identity is invalid.");
  if (typeof value.runId !== "string" || !value.runId || typeof value.evaluationRequestId !== "string" || !value.evaluationRequestId) throw new TypeError("Goal decision run identity is invalid.");
  if (!(value.decision === "complete" || value.decision === "continue" || value.decision === "blocked" || value.decision === "needs_user")) throw new TypeError("Goal decision is invalid.");
  if (typeof value.reason !== "string" || !value.reason.trim()) throw new TypeError("Goal decision reason is invalid.");
  if (!(value.confidence === "low" || value.confidence === "medium" || value.confidence === "high")) throw new TypeError("Goal decision confidence is invalid.");
}

function assertRunCandidate(value: unknown): asserts value is GoalRunCandidate {
  if (!isRecord(value)) throw new TypeError("Pending goal candidate is invalid.");
  if (!(value.source === undefined || value.source === "assistant_message" || value.source === "assistant_stop")) throw new TypeError("Goal candidate source is invalid.");
  if (value.protocol === "valid") {
    assertDecisionRecord(value.worker);
    if (value.evaluator !== undefined) assertDecisionRecord(value.evaluator);
    if (value.reason !== undefined && typeof value.reason !== "string") throw new TypeError("Goal candidate reason is invalid.");
    return;
  }
  if (!(value.protocol === "missing" || value.protocol === "malformed" || value.protocol === "stale" || value.protocol === "duplicate" || value.protocol === "conflict")) throw new TypeError("Goal candidate protocol is invalid.");
  if (typeof value.reason !== "string" || !value.reason.trim() || value.worker !== undefined || value.evaluator !== undefined) throw new TypeError("Goal protocol error is invalid.");
}

function assertStoredGoal(value: unknown, expectedProjectRoot: string): GoalState {
  if (!isRecord(value)) throw new TypeError("Goal state must be an object.");
  if (value.schemaVersion !== 2) throw new TypeError("Unsupported goal state schema.");
  if (typeof value.goalId !== "string" || !value.goalId) throw new TypeError("Goal ID is missing.");
  if (!isIntegerAtLeast(value.goalRevision, 1) || !isIntegerAtLeast(value.storageRevision, 0)) throw new TypeError("Goal revisions are invalid.");
  if (typeof value.projectRoot !== "string" || canonicalProjectRoot(value.projectRoot) !== canonicalProjectRoot(expectedProjectRoot) || typeof value.objective !== "string" || !value.objective.trim()) throw new TypeError("Goal identity is invalid.");
  if (!(["active", "paused", "complete", "blocked", "needs_user", "usage_limited", "token_budget_limited"] as unknown[]).includes(value.status)) throw new TypeError("Goal status is invalid.");
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) throw new TypeError("Goal timestamps are invalid.");
  if (!isIntegerAtLeast(value.turns, 0) || !isIntegerAtLeast(value.maxTurns, 1)) throw new TypeError("Goal turn budget is invalid.");
  if (value.evaluatedRuns !== undefined && !isIntegerAtLeast(value.evaluatedRuns, 0)) throw new TypeError("Goal evaluated-run count is invalid.");
  if (!isIntegerAtLeast(value.maxFailedVerificationAttempts, 1) || !isIntegerAtLeast(value.consecutiveFailedVerificationAttempts, 0)) throw new TypeError("Goal verification counters are invalid.");
  if (!isRecord(value.verification) || !Array.isArray(value.verification.commands) || !value.verification.commands.every((item) => typeof item === "string" && Boolean(item.trim()))) throw new TypeError("Goal verification configuration is invalid.");
  if (value.verification.lastResult !== undefined && typeof value.verification.lastResult !== "string") throw new TypeError("Goal verification result is invalid.");
  if (value.verification.proofs !== undefined && (!Array.isArray(value.verification.proofs) || !value.verification.proofs.every((entry) => isRecord(entry) && entry.kind === "verification" && isTimestamp(entry.at) && typeof entry.summary === "string" && isIntegerAtLeast(entry.goalRevision, 1) && (entry.command === undefined || typeof entry.command === "string") && (entry.outcome === undefined || (["passed", "failed", "unknown"] as unknown[]).includes(entry.outcome)) && (entry.runId === undefined || typeof entry.runId === "string")))) throw new TypeError("Goal verification proof is invalid.");
  if (!Array.isArray(value.evidence)) throw new TypeError("Goal evidence is invalid.");
  for (const entry of value.evidence) {
    if (!isRecord(entry) || !isTimestamp(entry.at) || typeof entry.summary !== "string" || !(["note", "verification", "tool"] as unknown[]).includes(entry.kind) || !isIntegerAtLeast(entry.goalRevision, 1)) throw new TypeError("Goal evidence entry is invalid.");
    if (entry.command !== undefined && typeof entry.command !== "string") throw new TypeError("Goal evidence command is invalid.");
    if (entry.outcome !== undefined && !(["passed", "failed", "unknown"] as unknown[]).includes(entry.outcome)) throw new TypeError("Goal evidence outcome is invalid.");
    if (entry.runId !== undefined && typeof entry.runId !== "string") throw new TypeError("Goal evidence run ID is invalid.");
  }
  if (value.steering !== undefined) {
    if (!Array.isArray(value.steering) || value.steering.length > 20) throw new TypeError("Goal steering history is invalid.");
    for (const entry of value.steering) {
      if (!isRecord(entry) || !isTimestamp(entry.at) || typeof entry.text !== "string" || !entry.text.trim() || !isIntegerAtLeast(entry.goalRevision, 1)) throw new TypeError("Goal steering entry is invalid.");
    }
  }
  if (value.pendingSteer !== undefined) {
    if (!isRecord(value.pendingSteer) || typeof value.pendingSteer.sessionId !== "string" || !value.pendingSteer.sessionId || !isTimestamp(value.pendingSteer.requestedAt)) throw new TypeError("Pending goal steering is invalid.");
    if (value.pendingSteer.interruptedRunId !== undefined && (typeof value.pendingSteer.interruptedRunId !== "string" || !value.pendingSteer.interruptedRunId)) throw new TypeError("Pending goal steering run ID is invalid.");
    if (value.pendingSteer.usageRunFingerprints !== undefined && (!Array.isArray(value.pendingSteer.usageRunFingerprints) || !value.pendingSteer.usageRunFingerprints.every((fingerprint) => typeof fingerprint === "string" && Boolean(fingerprint)))) throw new TypeError("Pending goal steering usage fingerprints are invalid.");
  }

  if (value.lease !== undefined) {
    if (!isRecord(value.lease) || typeof value.lease.sessionId !== "string" || !value.lease.sessionId || !isTimestamp(value.lease.acquiredAt) || !isTimestamp(value.lease.renewedAt) || !isTimestamp(value.lease.expiresAt)) throw new TypeError("Goal lease is invalid.");
    if (Date.parse(value.lease.acquiredAt) > Date.parse(value.lease.renewedAt) || Date.parse(value.lease.renewedAt) >= Date.parse(value.lease.expiresAt)) throw new TypeError("Goal lease chronology is invalid.");
  }
  if (value.pendingRun !== undefined) {
    if (!isRecord(value.pendingRun) || typeof value.pendingRun.runId !== "string" || !value.pendingRun.runId || typeof value.pendingRun.evaluationRequestId !== "string" || !value.pendingRun.evaluationRequestId || !isIntegerAtLeast(value.pendingRun.goalRevision, 1) || typeof value.pendingRun.sessionId !== "string" || !value.pendingRun.sessionId || !isTimestamp(value.pendingRun.dispatchedAt)) throw new TypeError("Pending goal run is invalid.");
    if (!(value.pendingRun.toolProposal === undefined || value.pendingRun.toolProposal === "complete" || value.pendingRun.toolProposal === "blocked" || value.pendingRun.toolProposal === "needs_user")) throw new TypeError("Pending goal proposal is invalid.");
    if (!(value.pendingRun.toolProposalConflict === undefined || value.pendingRun.toolProposalConflict === true)) throw new TypeError("Pending goal proposal conflict is invalid.");
    if (value.pendingRun.usageRunFingerprints !== undefined && (!Array.isArray(value.pendingRun.usageRunFingerprints) || !value.pendingRun.usageRunFingerprints.every((fingerprint) => typeof fingerprint === "string" && Boolean(fingerprint)))) throw new TypeError("Pending goal usage fingerprints are invalid.");
    if (value.pendingRun.providerUsageLimit !== undefined && (!isRecord(value.pendingRun.providerUsageLimit) || typeof value.pendingRun.providerUsageLimit.reason !== "string" || !value.pendingRun.providerUsageLimit.reason.trim() || (value.pendingRun.providerUsageLimit.retryAfter !== undefined && typeof value.pendingRun.providerUsageLimit.retryAfter !== "string"))) throw new TypeError("Pending provider usage limit is invalid.");
    if (value.pendingRun.evaluationContext !== undefined && (typeof value.pendingRun.evaluationContext !== "string" || value.pendingRun.evaluationContext.length > 32_000)) throw new TypeError("Pending goal evaluation context is invalid.");
    if (value.pendingRun.candidate !== undefined) assertRunCandidate(value.pendingRun.candidate);
  }

  if (value.tokenBudget !== undefined && !isIntegerAtLeast(value.tokenBudget, 1)) throw new TypeError("Goal token budget is invalid.");
  if (value.usage !== undefined) {
    if (!isRecord(value.usage) || !isIntegerAtLeast(value.usage.input, 0) || !isIntegerAtLeast(value.usage.output, 0) || !isIntegerAtLeast(value.usage.cacheRead, 0) || !isIntegerAtLeast(value.usage.cacheWrite, 0) || !isIntegerAtLeast(value.usage.totalTokens, 0) || !isRecord(value.usage.cost) || typeof value.usage.cost.total !== "number" || !Number.isFinite(value.usage.cost.total) || value.usage.cost.total < 0) throw new TypeError("Goal usage is invalid.");
  }
  if (value.limitDetail !== undefined) {
    if (!isRecord(value.limitDetail) || !(value.limitDetail.kind === "usage_limited" || value.limitDetail.kind === "token_budget_limited") || typeof value.limitDetail.reason !== "string" || !value.limitDetail.reason.trim() || !isTimestamp(value.limitDetail.at) || (value.limitDetail.runId !== undefined && typeof value.limitDetail.runId !== "string") || (value.limitDetail.retryAfter !== undefined && typeof value.limitDetail.retryAfter !== "string")) throw new TypeError("Goal limit detail is invalid.");
  }

  const normalized = normalizeGoalState(value);
  if (value.lastEvaluation !== undefined && normalized.lastEvaluation === undefined) throw new TypeError("Goal evaluation is invalid.");
  if (value.usage !== undefined && normalized.usage === undefined) throw new TypeError("Goal usage is invalid.");
  if (value.limitDetail !== undefined && normalized.limitDetail === undefined) throw new TypeError("Goal limit detail is invalid.");
  if (normalized.pendingRun && normalized.pendingRun.goalRevision !== normalized.goalRevision) throw new TypeError("Pending goal run revision is stale.");
  if (normalized.pendingRun?.candidate?.protocol === "valid") {
    const records = [normalized.pendingRun.candidate.worker, normalized.pendingRun.candidate.evaluator].filter((record): record is GoalDecisionRecord => Boolean(record));
    if (records.some((record) => record.goalId !== normalized.goalId || record.goalRevision !== normalized.goalRevision || record.runId !== normalized.pendingRun?.runId || record.evaluationRequestId !== normalized.pendingRun?.evaluationRequestId)) throw new TypeError("Pending goal candidate identity is stale.");
  }
  return normalized;
}

function appendAudit(auditRoot: string, projectRoot: string, event: GoalAuditEvent): void {
  mkdirSync(auditRoot, { recursive: true, mode: 0o700 });
  const path = join(auditRoot, `${goalKey(projectRoot)}.jsonl`);
  writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) normalized[key] = stableJsonValue(value[key]);
  }
  return normalized;
}

function completionSnapshotKey(goal: GoalState): string {
  // The active slot may acquire a different storage revision while recovering
  // from a partial archive/clear sequence. Every other normalized field is part
  // of the immutable completion receipt.
  const { storageRevision: _storageRevision, ...snapshot } = goal;
  return JSON.stringify(stableJsonValue(snapshot));
}

function assertMatchingArchive(existing: GoalState, snapshot: GoalState): GoalState {
  if (existing.status !== "complete" || completionSnapshotKey(existing) !== completionSnapshotKey(snapshot)) {
    throw new GoalStorageConflictError("Archived goal snapshot conflicts with the completed goal receipt.");
  }
  return existing;
}

/** Best-effort directory sync; some filesystems do not allow opening a directory. */
function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Windows and a few virtual filesystems do not support directory fsync.
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

export function createGoalStorage(options: GoalStorageOptions = {}): GoalStorage {
  const storageRoot = options.storageRoot ?? defaultPath("state");
  const legacyStatePath = options.legacyStatePath ?? defaultPath("state.json");
  const auditRoot = options.auditRoot ?? defaultPath("logs");
  const corruptRoot = options.corruptRoot ?? defaultPath("corrupt");
  const archiveRoot = options.archiveRoot ?? defaultPath("archive");
  const processIsAlive = options.isProcessAlive ?? isLiveProcess;
  const processStartToken = options.getProcessStartToken ?? getProcessStartToken;
  if (options.storageRoot) mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  if (options.legacyStatePath) mkdirSync(dirname(legacyStatePath), { recursive: true, mode: 0o700 });

  const statePathFor = (projectRoot: string) => {
    if (options.storageRoot) mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
    return join(storageRoot, `${goalKey(projectRoot)}.json`);
  };
  const auditPathFor = (projectRoot: string) => join(auditRoot, `${goalKey(projectRoot)}.jsonl`);
  const archiveDirectoryFor = (projectRoot: string) => join(archiveRoot, goalKey(projectRoot));
  const archivePathFor = (projectRoot: string, goalId: string) => join(archiveDirectoryFor(projectRoot), `${encodeURIComponent(goalId)}.json`);
  const historyPathFor = (projectRoot: string) => join(storageRoot, `.${goalKey(projectRoot)}.history`);
  const lockPathFor = (projectRoot: string) => join(storageRoot, `.${goalKey(projectRoot)}.lock`);
  const reclaimPathFor = (projectRoot: string) => join(storageRoot, `.${goalKey(projectRoot)}.lock.reclaim`);

  /** Publish one complete owner record without ever exposing a partial lock. */
  const publishExclusiveRecord = (path: string, record: LockRecord | LockReclaimRecord): void => {
    const directory = dirname(path);
    const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let published = false;
    try {
      descriptor = openSync(tempPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      // `link` succeeds only if `path` does not already exist. It makes the
      // complete, fsynced temp inode visible in a single filesystem operation.
      linkSync(tempPath, path);
      published = true;
      syncDirectory(directory);
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      try { unlinkSync(tempPath); } catch {}
      if (published) syncDirectory(directory);
    }
  };

  const isLiveOwner = (pid: number, recordedStartToken: string | undefined): boolean => {
    let alive: boolean;
    try {
      alive = processIsAlive(pid);
    } catch {
      return true;
    }
    if (!alive) return false;
    // Legacy records did not include a generation token. A currently-live
    // PID remains authoritative rather than risking deletion of a real lock.
    if (!recordedStartToken) return true;
    let currentStartToken: string | undefined;
    try {
      currentStartToken = processStartToken(pid);
    } catch {
      return true;
    }
    // Permission failures, unsupported hosts, and empty ps output are all
    // uncertain; preserve the lock rather than reclaiming it.
    return currentStartToken === undefined || currentStartToken === recordedStartToken;
  };

  const withProjectLock = <T>(projectRoot: string, operation: () => T): T => {
    mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
    const lockPath = lockPathFor(projectRoot);
    const reclaimPath = reclaimPathFor(projectRoot);
    const ownerId = randomUUID();
    let ownProcessStartToken: string | undefined;
    try {
      ownProcessStartToken = processStartToken(process.pid);
    } catch {}
    if (!ownProcessStartToken) {
      throw new GoalStorageConflictError("Could not determine this process generation for goal state lock ownership.");
    }
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      try {
        const record: LockRecord = { ownerId, createdAt: new Date().toISOString(), pid: process.pid, processStartToken: ownProcessStartToken };
        publishExclusiveRecord(lockPath, record);
        acquired = true;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST")) {
          throw new GoalStorageConflictError(`Could not acquire goal state lock: ${error instanceof Error ? error.message : String(error)}`);
        }

        let staleOwnerId: string | undefined;
        let staleCreatedAt: string | undefined;
        let stalePid: number | undefined;
        let staleProcessStartToken: string | undefined;
        let createdAt: number | undefined;
        try {
          const raw = readJson(lockPath);
          if (isRecord(raw) && isTimestamp(raw.createdAt) && typeof raw.ownerId === "string") {
            staleOwnerId = raw.ownerId;
            staleCreatedAt = raw.createdAt;
            stalePid = isIntegerAtLeast(raw.pid, 1) ? raw.pid : undefined;
            staleProcessStartToken = typeof raw.processStartToken === "string" && raw.processStartToken ? raw.processStartToken : undefined;
            createdAt = Date.parse(raw.createdAt);
          }
        } catch {}
        if (createdAt === undefined) {
          try { createdAt = statSync(lockPath).mtimeMs; } catch {}
        }
        if (createdAt === undefined || Date.now() - createdAt <= LOCK_STALE_MS) {
          throw new GoalStorageConflictError("Goal state is locked by another writer.");
        }
        // A slow but still-live writer must never be reclaimed solely because
        // its timestamp is old. Existing pre-PID/malformed locks retain the
        // timestamp fallback below so crashed older versions can recover.
        if (stalePid !== undefined && isLiveOwner(stalePid, staleProcessStartToken)) {
          throw new GoalStorageConflictError("Goal state is locked by another live writer.");
        }
        let staleDev: number | undefined;
        let staleIno: number | undefined;
        try {
          const staleStat = statSync(lockPath);
          staleDev = staleStat.dev;
          staleIno = staleStat.ino;
        } catch {
          continue;
        }

        // The recovery marker is an independently timestamped, exclusive
        // claim.  Unlike a hard link to the stale lock, it can be reclaimed
        // after the claimant crashes.  The recorded inode and lock identity
        // are verified immediately before unlinking so a delayed reclaimer
        // can never remove a replacement writer's lock.
        const reclaimOwnerId = randomUUID();
        try {
          const claim: LockReclaimRecord = {
            ownerId: reclaimOwnerId,
            pid: process.pid,
            processStartToken: ownProcessStartToken,
            claimedAt: new Date().toISOString(),
            lock: { ownerId: staleOwnerId ?? "", createdAt: staleCreatedAt ?? "", processStartToken: staleProcessStartToken, dev: staleDev, ino: staleIno },
          };
          publishExclusiveRecord(reclaimPath, claim);
        } catch (claimError) {
          if (claimError && typeof claimError === "object" && "code" in claimError) {
            const code = (claimError as { code?: unknown }).code;
            if (code === "ENOENT") continue;
            if (code === "EEXIST") {
              let reclaimableClaim = false;
              try {
                const existingClaim = readJson(reclaimPath);
                // Reclaim markers are ownership, not leases. An old marker
                // from a live process remains authoritative indefinitely;
                // only a dead claimant (or an unreadable/malformed marker)
                // may be recovered.
                reclaimableClaim = !isLockReclaimRecord(existingClaim) || !isLiveOwner(existingClaim.pid, existingClaim.processStartToken);
              } catch {
                continue;
              }
              if (reclaimableClaim) {
                try {
                  unlinkSync(reclaimPath);
                  syncDirectory(storageRoot);
                  continue;
                } catch {
                  continue;
                }
              }
            }
          }
          throw new GoalStorageConflictError("Goal state stale-lock recovery is already in progress.");
        }
        try {
          const claimed = readJson(reclaimPath);
          if (!isLockReclaimRecord(claimed) || claimed.ownerId !== reclaimOwnerId || claimed.processStartToken !== ownProcessStartToken || claimed.lock.ownerId !== staleOwnerId || claimed.lock.createdAt !== staleCreatedAt || claimed.lock.processStartToken !== staleProcessStartToken || claimed.lock.dev !== staleDev || claimed.lock.ino !== staleIno) {
            throw new GoalStorageConflictError("Goal state lock changed while stale-lock recovery was claimed.");
          }
          let original;
          let currentRecord: unknown;
          try {
            original = statSync(lockPath);
            currentRecord = readJson(lockPath);
          } catch {
            continue;
          }
          if (!isRecord(currentRecord) || currentRecord.ownerId !== staleOwnerId || currentRecord.createdAt !== staleCreatedAt || currentRecord.processStartToken !== staleProcessStartToken || original.ino !== staleIno || original.dev !== staleDev) {
            throw new GoalStorageConflictError("Goal state lock changed during stale-lock recovery.");
          }
          unlinkSync(lockPath);
          syncDirectory(storageRoot);
        } finally {
          try {
            const claim = readJson(reclaimPath);
            if (isLockReclaimRecord(claim) && claim.ownerId === reclaimOwnerId) {
              unlinkSync(reclaimPath);
              syncDirectory(storageRoot);
            }
          } catch {}
        }
      }
    }
    if (!acquired) throw new GoalStorageConflictError("Goal state is locked by another writer.");
    try {
      options.onLockAcquired?.(lockPath);
      return operation();
    } finally {
      try {
        const record = readJson(lockPath);
        if (isRecord(record) && record.ownerId === ownerId) {
          unlinkSync(lockPath);
          syncDirectory(storageRoot);
        }
      } catch {}
    }
  };

  const markProjectHistory = (projectRoot: string): void => {
    const descriptor = openSync(historyPathFor(projectRoot), "a", 0o600);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };

  const quarantine = (path: string): never => {
    mkdirSync(corruptRoot, { recursive: true, mode: 0o700 });
    const destination = join(corruptRoot, `${basename(path)}.${Date.now()}.${randomUUID()}.corrupt`);
      renameSync(path, destination);
      syncDirectory(dirname(path));
    throw new GoalStorageCorruptError(path, destination);
  };

  const hasProjectHistory = (projectRoot: string): boolean => {
    if (existsSync(historyPathFor(projectRoot)) || existsSync(auditPathFor(projectRoot))) return true;
    if (!existsSync(corruptRoot)) return false;
    const prefix = `${basename(statePathFor(projectRoot))}.`;
    return readdirSync(corruptRoot).some((name) => name.startsWith(prefix));
  };

  const readLatestCompleted = (projectRoot: string): GoalState | undefined => {
    const directory = archiveDirectoryFor(projectRoot);
    if (!existsSync(directory)) return undefined;
    const completed: GoalState[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const path = join(directory, name);
      try {
        const goal = assertStoredGoal(readJson(path), projectRoot);
        if (goal.status === "complete" && archivePathFor(projectRoot, goal.goalId) === path) completed.push(goal);
      } catch {
        // Invalid archive entries do not hide other durable achievements or
        // disturb the independently validated active slot.
      }
    }
    return completed.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.goalId.localeCompare(left.goalId))[0];
  };

  const listActive = (): GoalState[] => {
    if (!existsSync(storageRoot)) return [];
    const goals: GoalState[] = [];
    for (const name of readdirSync(storageRoot)) {
      if (!/^[0-9a-f]{16}\.json$/.test(name)) continue;
      const path = join(storageRoot, name);
      try {
        const raw = readJson(path);
        if (!isRecord(raw) || typeof raw.projectRoot !== "string" || `${goalKey(raw.projectRoot)}.json` !== name) throw new TypeError("Goal state filename does not match its working root.");
        goals.push(assertStoredGoal(raw, raw.projectRoot));
      } catch (error) {
        if (error instanceof GoalStorageCorruptError || error instanceof GoalStorageAuditError) throw error;
        return quarantine(path);
      }
    }
    return goals.sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
  };

  const read = (projectRoot: string): GoalState | undefined => {
    const statePath = statePathFor(projectRoot);
    if (existsSync(statePath)) {
      try {
        return assertStoredGoal(readJson(statePath), projectRoot);
      } catch (error) {
        if (error instanceof GoalStorageCorruptError || error instanceof GoalStorageAuditError) throw error;
        return quarantine(statePath);
      }
    }
    // Migration is one-shot. Audit/corruption history prevents a cleared or
    // quarantined project from resurrecting an old monolithic state entry.
    if (hasProjectHistory(projectRoot) || !existsSync(legacyStatePath)) return undefined;
    let legacy: unknown;
    try {
      legacy = readJson(legacyStatePath);
    } catch {
      return quarantine(legacyStatePath);
    }
    if (!isRecord(legacy) || !isRecord(legacy.goals)) return quarantine(legacyStatePath);
    const entries = Object.entries(legacy.goals);
    const rawGoal = legacy.goals[goalKey(projectRoot)] ?? entries
      .find(([, item]) => isRecord(item) && item.projectRoot === projectRoot)?.[1];
    if (!isRecord(rawGoal)) return undefined;
    const migrated = normalizeGoalState({ ...rawGoal, projectRoot });
    if (!migrated.objective.trim()) return undefined;
    return write(migrated, 0, { type: "legacy_migrated", at: new Date().toISOString(), reason: "Migrated legacy project goal." });
  };

  const write = (goal: GoalState, expectedStorageRevision: number, event: GoalAuditEvent): GoalState => withProjectLock(goal.projectRoot, () => {
    const path = statePathFor(goal.projectRoot);
    let actualRevision = 0;
    if (existsSync(path)) {
      try {
        actualRevision = assertStoredGoal(readJson(path), goal.projectRoot).storageRevision;
      } catch (error) {
        if (error instanceof GoalStorageCorruptError || error instanceof GoalStorageAuditError) throw error;
        return quarantine(path);
      }
    }
    if (actualRevision !== expectedStorageRevision) throw new GoalStorageConflictError();
    const next = assertStoredGoal({ ...goal, storageRevision: actualRevision + 1 }, goal.projectRoot);
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const descriptor = openSync(tempPath, "wx", 0o600);
    let descriptorOpen = true;
    let renamed = false;
    try {
      writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptorOpen = false;
      renameSync(tempPath, path);
      renamed = true;
      syncDirectory(dirname(path));
    } catch (error) {
      if (descriptorOpen) {
        try { closeSync(descriptor); } catch {}
      }
      if (!renamed) {
        try { unlinkSync(tempPath); } catch {}
      }
      throw error;
    }
    try {
      appendAudit(auditRoot, goal.projectRoot, { ...event, storageRevision: next.storageRevision, goalId: next.goalId, goalRevision: next.goalRevision });
    } catch (error) {
      throw new GoalStorageAuditError("Goal state committed, but the audit record could not be appended.", { committedState: next, cause: error });
    }
    return next;
  });

  const archive = (goal: GoalState): GoalState => withProjectLock(goal.projectRoot, () => {
    if (goal.status !== "complete") throw new TypeError("Only completed goals can be archived.");
    const snapshot = assertStoredGoal(goal, goal.projectRoot);
    const path = archivePathFor(snapshot.projectRoot, snapshot.goalId);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      const existing = assertStoredGoal(readJson(path), snapshot.projectRoot);
      return assertMatchingArchive(existing, snapshot);
    }
    const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(tempPath, path);
        syncDirectory(directory);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error;
        const existing = assertStoredGoal(readJson(path), snapshot.projectRoot);
        return assertMatchingArchive(existing, snapshot);
      }
      return snapshot;
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      try { unlinkSync(tempPath); } catch {}
    }
  });

  const clear = (projectRoot: string, expectedStorageRevision: number, event: GoalAuditEvent): void => withProjectLock(projectRoot, () => {
    const path = statePathFor(projectRoot);
    if (!existsSync(path)) return;
    let current: GoalState;
    try {
      current = assertStoredGoal(readJson(path), projectRoot);
    } catch (error) {
      if (error instanceof GoalStorageCorruptError || error instanceof GoalStorageAuditError) throw error;
      return quarantine(path);
    }
    if (current.storageRevision !== expectedStorageRevision) throw new GoalStorageConflictError();
    markProjectHistory(projectRoot);
    unlinkSync(path);
    syncDirectory(dirname(path));
    try {
      appendAudit(auditRoot, projectRoot, { ...event, goalId: current.goalId, goalRevision: current.goalRevision, storageRevision: current.storageRevision });
    } catch (error) {
      throw new GoalStorageAuditError("Goal state cleared, but the audit record could not be appended.", { cleared: true, cause: error });
    }
  });

  return {
    legacyStatePath,
    statePathFor,
    archivePathFor,
    read,
    readLatestCompleted,
    listActive,
    write,
    archive,
    clear,
    stateExists: (projectRoot) => existsSync(statePathFor(projectRoot)),
    readAuditText: (projectRoot) => existsSync(auditPathFor(projectRoot)) ? readFileSync(auditPathFor(projectRoot), "utf8") : "",
    listTemporaryFiles: () => existsSync(storageRoot) ? readdirSync(storageRoot).filter((name) => name.endsWith(".tmp")) : [],
    corruptFiles: () => existsSync(corruptRoot) ? readdirSync(corruptRoot).map((name) => join(corruptRoot, name)) : [],
  };
}
