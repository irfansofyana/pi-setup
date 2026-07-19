import { basename, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

import {
  GoalStorageAuditError,
  GoalStorageConflictError,
  GoalStorageCorruptError,
  createGoalStorage,
} from "./storage.ts";
import { createGoal, type GoalState } from "./state.ts";

const NOW = new Date("2026-07-12T00:00:00.000Z");

function createStorageFixture(options: {
  isProcessAlive?: (pid: number) => boolean;
  getProcessStartToken?: (pid: number) => string | undefined;
  onLockAcquired?: (lockPath: string) => void;
  onStaleLockObserved?: (lockPath: string) => void;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "goal-loop-storage-"));
  const storage = createGoalStorage({
    storageRoot: join(root, "state"),
    legacyStatePath: join(root, "legacy", "state.json"),
    auditRoot: join(root, "logs"),
    corruptRoot: join(root, "corrupt"),
    archiveRoot: join(root, "archive"),
    isProcessAlive: options.isProcessAlive ?? (() => false),
    getProcessStartToken: options.getProcessStartToken ?? (() => "test-process-start"),
    onLockAcquired: options.onLockAcquired,
    onStaleLockObserved: options.onStaleLockObserved,
  });
  return { root, storage };
}

test("write atomically replaces one project state and increments storage revision", () => {
  const { root, storage } = createStorageFixture();
  const goal = createGoal("/repo/app", "Ship", NOW, "goal-1");

  const written = storage.write(goal, 0, { type: "goal_created", at: NOW.toISOString(), reason: "created" });

  assert.equal(written.storageRevision, 1);
  assert.equal(storage.read("/repo/app")?.goalId, "goal-1");
  assert.deepEqual(storage.listTemporaryFiles(), []);
  rmSync(root, { recursive: true, force: true });
});

test("write rejects a stale storage revision", () => {
  const { root, storage } = createStorageFixture();
  const goal = createGoal("/repo", "Ship", NOW, "goal-1");
  const written = storage.write(goal, 0, { type: "goal_created", at: NOW.toISOString(), reason: "created" });

  assert.throws(
    () => storage.write({ ...written, objective: "stale" }, 0, { type: "goal_updated", at: NOW.toISOString(), reason: "stale" }),
    /stale storage revision/i,
  );
  rmSync(root, { recursive: true, force: true });
});

test("legacy migration leaves legacy text untouched and records audit", () => {
  const { root, storage } = createStorageFixture();
  writeFileSync(storage.legacyStatePath, JSON.stringify({
    goals: {
      "repo-key": createGoal("/repo/app", "Ship", NOW, "goal-1"),
    },
  }), "utf8");

  const before = readFileSync(storage.legacyStatePath, "utf8");
  const migrated = storage.read("/repo/app");

  assert.equal(migrated?.goalId, "goal-1");
  assert.equal(readFileSync(storage.legacyStatePath, "utf8"), before);
  assert.match(storage.readAuditText("/repo/app"), /legacy_migrated/);
  rmSync(root, { recursive: true, force: true });
});

test("equivalent project roots share one state file", () => {
  const { root, storage } = createStorageFixture();
  const written = storage.write(createGoal("/repo/app/", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() });

  assert.equal(written.projectRoot, "/repo/app");
  assert.equal(storage.read("/repo/app")?.goalId, "goal-1");
  rmSync(root, { recursive: true, force: true });
});

test("write fails closed while another writer holds the project lock", () => {
  const { root, storage } = createStorageFixture();
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, "locked", "utf8");

  assert.throws(
    () => storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() }),
    GoalStorageConflictError,
  );
  rmSync(root, { recursive: true, force: true });
});

test("write reclaims a crash-stale project lock", () => {
  const { root, storage } = createStorageFixture();
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, JSON.stringify({ ownerId: "dead-writer", createdAt: "2026-07-11T00:00:00.000Z", pid: 1 }), "utf8");

  const written = storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() });

  assert.equal(written.storageRevision, 1);
  assert.equal(storage.read("/repo/app")?.goalId, "goal-1");
  rmSync(root, { recursive: true, force: true });
});

test("write reclaims a stale lock whose JSON identity is incomplete", () => {
  const { root, storage } = createStorageFixture();
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, JSON.stringify({ pid: 1 }), "utf8");
  utimesSync(lockPath, new Date(0), new Date(0));

  const written = storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() });

  assert.equal(written.storageRevision, 1);
  assert.equal(existsSync(`${lockPath}.reclaim`), false);
  rmSync(root, { recursive: true, force: true });
});

test("an incomplete stale lock still preserves a live PID owner", () => {
  const livePid = 4242;
  const { root, storage } = createStorageFixture({ isProcessAlive: (pid) => pid === livePid });
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, JSON.stringify({ pid: livePid }), "utf8");
  utimesSync(lockPath, new Date(0), new Date(0));

  assert.throws(
    () => storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() }),
    /locked by another live writer/i,
  );
  assert.equal(readFileSync(lockPath, "utf8"), JSON.stringify({ pid: livePid }));
  rmSync(root, { recursive: true, force: true });
});

test("write fails closed on a stale lock with no process identity", () => {
  const { root, storage } = createStorageFixture();
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, "partial-json", "utf8");
  utimesSync(lockPath, new Date(0), new Date(0));

  assert.throws(
    () => storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() }),
    (error: unknown) => error instanceof GoalStorageConflictError && error.manualCleanupPath === lockPath,
  );
  assert.equal(readFileSync(lockPath, "utf8"), "partial-json");
  rmSync(root, { recursive: true, force: true });
});

test("stale-lock recovery fails closed when the lock path changes during inspection", () => {
  let replaced = false;
  const { root, storage } = createStorageFixture({
    onStaleLockObserved: (lockPath) => {
      if (replaced) return;
      replaced = true;
      rmSync(lockPath);
      writeFileSync(lockPath, JSON.stringify({ pid: 1 }), "utf8");
      utimesSync(lockPath, new Date(0), new Date(0));
    },
  });
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, "stale-lock", "utf8");
  utimesSync(lockPath, new Date(0), new Date(0));

  assert.throws(() => storage.write(
    createGoal("/repo/app", "Ship", NOW, "goal-1"),
    0,
    { type: "goal_created", at: NOW.toISOString() },
  ), /changed while it was being inspected/i);
  assert.equal(readFileSync(lockPath, "utf8"), JSON.stringify({ pid: 1 }));
  rmSync(root, { recursive: true, force: true });
});

test("stale lock is reclaimed when its PID was reused by a different process generation", () => {
  const reusedPid = 4242;
  const { root, storage } = createStorageFixture({
    isProcessAlive: (pid) => pid === reusedPid,
    getProcessStartToken: (pid) => pid === reusedPid ? "v1:replacement-process" : "v1:writer-process",
  });
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, JSON.stringify({
    ownerId: "dead-writer",
    createdAt: "2026-07-11T00:00:00.000Z",
    pid: reusedPid,
    processStartToken: "v1:original-process",
  }), "utf8");

  const written = storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() });

  assert.equal(written.storageRevision, 1);
  rmSync(root, { recursive: true, force: true });
});

test("an unknown process-generation lookup preserves a live stale lock", () => {
  const livePid = 4242;
  const { root, storage } = createStorageFixture({
    isProcessAlive: (pid) => pid === livePid,
    getProcessStartToken: (pid) => pid === livePid ? undefined : "writer-process",
  });
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, JSON.stringify({
    ownerId: "unknown-owner",
    createdAt: "2026-07-11T00:00:00.000Z",
    pid: livePid,
    processStartToken: "v1:original-process",
  }), "utf8");

  assert.throws(
    () => storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() }),
    GoalStorageConflictError,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a live PID with a legacy locale-sensitive token remains authoritative", () => {
  const livePid = 4242;
  const { root, storage } = createStorageFixture({
    isProcessAlive: (pid) => pid === livePid,
    getProcessStartToken: () => "v1:canonical-current-token",
  });
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  writeFileSync(lockPath, JSON.stringify({
    ownerId: "legacy-owner",
    createdAt: "2026-07-11T00:00:00.000Z",
    pid: livePid,
    processStartToken: "locale-sensitive-legacy-token",
  }), "utf8");

  assert.throws(
    () => storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() }),
    /locked by another live writer/i,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a crashed stale-lock reclaimer remains fail-closed despite PID reuse", () => {
  const reusedPid = 4242;
  const { root, storage } = createStorageFixture({
    isProcessAlive: (pid) => pid === reusedPid,
    getProcessStartToken: (pid) => pid === reusedPid ? "replacement-process" : "writer-process",
  });
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  const reclaimPath = `${lockPath}.reclaim`;
  const createdAt = "2026-07-11T00:00:00.000Z";
  writeFileSync(lockPath, JSON.stringify({ ownerId: "dead-writer", createdAt, pid: 1 }), "utf8");
  const lockStat = statSync(lockPath);
  writeFileSync(reclaimPath, JSON.stringify({
    ownerId: "crashed-reclaimer",
    pid: reusedPid,
    processStartToken: "original-process",
    claimedAt: createdAt,
    lock: { pid: 1, ownerId: "dead-writer", createdAt, dev: lockStat.dev, ino: lockStat.ino },
  }), "utf8");

  assert.throws(
    () => storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() }),
    /recovery is already claimed/i,
  );
  assert.equal(existsSync(reclaimPath), true);
  rmSync(root, { recursive: true, force: true });
});

test("lock acquisition publishes a complete owner record before work begins", () => {
  let observed: unknown;
  const { root, storage } = createStorageFixture({
    getProcessStartToken: () => "test-process-start",
    onLockAcquired: (lockPath) => {
      observed = JSON.parse(readFileSync(lockPath, "utf8"));
    },
  });

  storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() });

  assert.deepEqual(observed, {
    ownerId: (observed as { ownerId: string }).ownerId,
    createdAt: (observed as { createdAt: string }).createdAt,
    pid: process.pid,
    processStartToken: "test-process-start",
  });
  assert.match((observed as { ownerId: string }).ownerId, /./);
  assert.match((observed as { createdAt: string }).createdAt, /^\d{4}-\d{2}-\d{2}T/);
  rmSync(root, { recursive: true, force: true });
});

test("stale-lock recovery respects an old claim held by a live reclaimer", () => {
  const livePid = 4242;
  const { root, storage } = createStorageFixture({ isProcessAlive: (pid) => pid === livePid });
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  const reclaimPath = `${lockPath}.reclaim`;
  const stale = JSON.stringify({ ownerId: "dead-writer", createdAt: "2026-07-11T00:00:00.000Z", pid: 1 });
  writeFileSync(lockPath, stale, "utf8");
  const lockStat = statSync(lockPath);
  writeFileSync(reclaimPath, JSON.stringify({
    ownerId: "live-reclaimer",
    pid: livePid,
    claimedAt: "2026-07-01T00:00:00.000Z",
    lock: { pid: 1, ownerId: "dead-writer", createdAt: "2026-07-11T00:00:00.000Z", dev: lockStat.dev, ino: lockStat.ino },
  }), "utf8");

  assert.throws(
    () => storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() }),
    GoalStorageConflictError,
  );
  assert.equal(readFileSync(lockPath, "utf8"), stale);
  assert.match(readFileSync(reclaimPath, "utf8"), /live-reclaimer/);
  rmSync(root, { recursive: true, force: true });
});

test("stale-lock recovery preserves a dead recovery claimant for manual cleanup", () => {
  const { root, storage } = createStorageFixture();
  const statePath = storage.statePathFor("/repo/app");
  const lockPath = join(root, "state", `.${basename(statePath, ".json")}.lock`);
  const reclaimPath = `${lockPath}.reclaim`;
  const createdAt = "2026-07-11T00:00:00.000Z";
  writeFileSync(lockPath, JSON.stringify({ ownerId: "dead-writer", createdAt, pid: 1 }), "utf8");
  const lockStat = statSync(lockPath);
  writeFileSync(reclaimPath, JSON.stringify({
    ownerId: "crashed-reclaimer",
    pid: 4242,
    claimedAt: createdAt,
    lock: { pid: 1, ownerId: "dead-writer", createdAt, dev: lockStat.dev, ino: lockStat.ino },
  }), "utf8");

  assert.throws(
    () => storage.write(createGoal("/repo/app", "Ship", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() }),
    /recovery is already claimed/i,
  );
  assert.equal(existsSync(reclaimPath), true);
  rmSync(root, { recursive: true, force: true });
});

test("clear cannot resurrect a legacy goal when audit append fails", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-loop-storage-"));
  const auditBlocker = join(root, "audit-blocker");
  const legacyStatePath = join(root, "legacy", "state.json");
  const storage = createGoalStorage({
    storageRoot: join(root, "state"),
    legacyStatePath,
    auditRoot: auditBlocker,
    corruptRoot: join(root, "corrupt"),
    archiveRoot: join(root, "archive"),
    getProcessStartToken: () => "test-process-start",
  });
  writeFileSync(auditBlocker, "not a directory", "utf8");
  writeFileSync(legacyStatePath, JSON.stringify({ goals: { legacy: createGoal("/repo/app", "Legacy", NOW, "legacy-goal") } }), "utf8");

  let committed: GoalState | undefined;
  try {
    storage.write(createGoal("/repo/app", "Current", NOW, "goal-1"), 0, { type: "goal_created", at: NOW.toISOString() });
    assert.fail("write should report the audit failure");
  } catch (error) {
    assert.ok(error instanceof GoalStorageAuditError);
    committed = error.committedState;
  }
  if (!committed) assert.fail("state commit should be observable after the audit failure");
  assert.throws(
    () => storage.clear("/repo/app", committed!.storageRevision, { type: "goal_cleared", at: NOW.toISOString() }),
    (error: unknown) => error instanceof GoalStorageAuditError && error.cleared,
  );
  assert.equal(storage.read("/repo/app"), undefined);
  rmSync(root, { recursive: true, force: true });
});

test("archive snapshots are atomic, idempotent, private, and expose the latest completion", () => {
  const { root, storage } = createStorageFixture();
  const first = { ...createGoal("/repo/app", "First", NOW, "goal/one"), status: "complete" as const, storageRevision: 3 };
  const laterAt = new Date(NOW.getTime() + 1_000).toISOString();
  const second = { ...createGoal("/repo/app", "Second", NOW, "goal-two"), status: "complete" as const, storageRevision: 5, updatedAt: laterAt };

  assert.equal(storage.archive(first).goalId, "goal/one");
  assert.equal(storage.archive(first).goalId, "goal/one");
  assert.equal(storage.archive({ ...first, storageRevision: 99 }).storageRevision, 3);
  storage.archive(second);

  assert.equal(storage.readLatestCompleted("/repo/app")?.goalId, "goal-two");
  assert.equal(statSync(storage.archivePathFor("/repo/app", "goal/one")).mode & 0o777, 0o600);
  assert.deepEqual(storage.listTemporaryFiles(), []);
  rmSync(root, { recursive: true, force: true });
});

test("archive rejects conflicting normalized completion snapshots with the same goal ID", () => {
  const { root, storage } = createStorageFixture();
  const receipt = {
    ...createGoal("/repo/app", "Original objective", NOW, "goal-one"),
    status: "complete" as const,
    storageRevision: 3,
    lastEvaluation: { decision: "complete" as const, reason: "verified original", confidence: "high" as const },
  };
  storage.archive(receipt);

  assert.throws(() => storage.archive({ ...receipt, objective: "Different objective" }), GoalStorageConflictError);
  assert.throws(() => storage.archive({ ...receipt, goalRevision: 2 }), GoalStorageConflictError);
  assert.throws(() => storage.archive({
    ...receipt,
    lastEvaluation: { ...receipt.lastEvaluation, reason: "different completion receipt" },
  }), GoalStorageConflictError);
  assert.equal(storage.readLatestCompleted("/repo/app")?.lastEvaluation?.reason, "verified original");
  rmSync(root, { recursive: true, force: true });
});

test("listActive validates independent worktree state files and ignores lock, temp, and history files", () => {
  const { root, storage } = createStorageFixture();
  storage.write(createGoal("/repo/worktree-a", "A", NOW, "goal-a"), 0, { type: "created", at: NOW.toISOString() });
  storage.write(createGoal("/repo/worktree-b", "B", NOW, "goal-b"), 0, { type: "created", at: NOW.toISOString() });
  writeFileSync(join(root, "state", ".unrelated.lock"), "not-json", "utf8");
  writeFileSync(join(root, "state", ".unrelated.tmp"), "not-json", "utf8");
  writeFileSync(join(root, "state", ".unrelated.history"), "not-json", "utf8");

  const listed = storage.listActive();

  assert.deepEqual(listed.map((goal) => goal.projectRoot), ["/repo/worktree-a", "/repo/worktree-b"]);
  assert.equal(storage.corruptFiles().length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("listActive quarantines a malformed active JSON file without touching unrelated files", () => {
  const { root, storage } = createStorageFixture();
  const unrelated = join(root, "state", ".unrelated.lock");
  writeFileSync(unrelated, "not-json", "utf8");
  writeFileSync(storage.statePathFor("/repo/bad"), "{not-json", "utf8");

  assert.throws(() => storage.listActive(), GoalStorageCorruptError);
  assert.equal(existsSync(unrelated), true);
  assert.equal(storage.corruptFiles().length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("read accepts old schema-v2 active files without additive budget or usage fields", () => {
  const { root, storage } = createStorageFixture();
  const old = createGoal("/repo/app", "Old compatible goal", NOW, "old-goal");
  const { tokenBudget: _budget, usage: _usage, limitDetail: _limit, ...persisted } = old;
  writeFileSync(storage.statePathFor("/repo/app"), JSON.stringify({ ...persisted, storageRevision: 1 }), "utf8");

  const read = storage.read("/repo/app");

  assert.equal(read?.goalId, "old-goal");
  assert.equal(read?.tokenBudget, undefined);
  assert.equal(read?.usage, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("read quarantines invalid lease timestamps", () => {
  const { root, storage } = createStorageFixture();
  const goal = { ...createGoal("/repo/app", "Ship", NOW, "goal-1"), storageRevision: 1, lease: { sessionId: "session-a", acquiredAt: NOW.toISOString(), renewedAt: NOW.toISOString(), expiresAt: "not-a-date" } };
  writeFileSync(storage.statePathFor("/repo/app"), JSON.stringify(goal), "utf8");

  assert.throws(() => storage.read("/repo/app"), GoalStorageCorruptError);
  assert.equal(storage.stateExists("/repo/app"), false);
  rmSync(root, { recursive: true, force: true });
});

test("read quarantines malformed steering state", () => {
  const { root, storage } = createStorageFixture();
  const goal = {
    ...createGoal("/repo/app", "Ship", NOW, "goal-1"),
    storageRevision: 1,
    steering: [{ at: NOW.toISOString(), text: "", goalRevision: 2 }],
    pendingSteer: { sessionId: "", requestedAt: NOW.toISOString() },
  };
  writeFileSync(storage.statePathFor("/repo/app"), JSON.stringify(goal), "utf8");

  assert.throws(() => storage.read("/repo/app"), GoalStorageCorruptError);
  assert.equal(storage.stateExists("/repo/app"), false);
  rmSync(root, { recursive: true, force: true });
});

test("read quarantines corrupt state", () => {
  const { root, storage } = createStorageFixture();
  writeFileSync(storage.statePathFor("/repo/app"), "{not-json", "utf8");

  assert.throws(() => storage.read("/repo/app"), GoalStorageCorruptError);
  assert.equal(storage.stateExists("/repo/app"), false);
  assert.equal(storage.corruptFiles().length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("read quarantines malformed legacy state instead of treating it as missing", () => {
  const { root, storage } = createStorageFixture();
  writeFileSync(storage.legacyStatePath, "{not-json", "utf8");

  assert.throws(() => storage.read("/repo/app"), GoalStorageCorruptError);
  assert.equal(storage.corruptFiles().length, 1);
  rmSync(root, { recursive: true, force: true });
});
