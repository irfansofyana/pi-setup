import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { aggregate, loadCache, parseRange, parseSessionText, refreshCache, saveCache, type SessionSummary, type StatsCache } from "./stats.ts";

const timestamp = "2026-06-01T10:00:00.000Z";
const usage: Usage = {
  input: 100,
  output: 50,
  cacheRead: 30,
  cacheWrite: 20,
  totalTokens: 200,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

function nativeSession(): string {
  const manager = SessionManager.inMemory("/work/example");
  const message: AssistantMessage = {
    role: "assistant", api: "openai-completions", provider: "parent", model: "parent-model",
    content: [{ type: "text", text: "Done" }], stopReason: "stop",
    timestamp: Date.parse(timestamp), usage,
  };
  const first = manager.appendMessage(message);
  manager.appendMessage({
    role: "toolResult", toolCallId: "t", toolName: "nested-model",
    content: [{ type: "text", text: "Result" }], isError: false,
    timestamp: Date.parse(timestamp), usage,
  });
  manager.appendUsage("cache_warm", "cache-provider", "cache-model", usage);
  manager.appendCompaction("summary", first, 9000, { usage }, false, usage);
  manager.branchWithSummary(first, "branch summary", { usage }, false, usage);
  manager.appendSessionInfo("Native usage");
  const entries = manager.getEntries().map((entry) => entry.type === "message"
    ? { ...entry, timestamp, message: { ...entry.message, timestamp: Date.parse(timestamp) } }
    : { ...entry, timestamp });
  return [
    { type: "session", version: 3, id: "usage-session", timestamp, cwd: "/work/example" },
    ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n");
}

function cacheOf(...sessions: SessionSummary[]): StatsCache {
  return {
    version: 2,
    files: Object.fromEntries(sessions.map((session) => [session.sessionPath, {
      path: session.sessionPath, mtimeMs: 1, size: 1, parsedAt: 0, session,
    }])),
  };
}

async function withLegacyCache(
  parserVersion: number | undefined,
  run: (fixture: { sessionDir: string; sessionPath: string; cachePath: string; raw: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-accounting-"));
  try {
    const sessionDir = join(root, "sessions");
    const sessionPath = join(sessionDir, "one.jsonl");
    const cachePath = join(root, "pi-stats", "cache.json");
    const raw = nativeSession();
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, raw, "utf8");
    const info = await stat(sessionPath);
    const session = parseSessionText(raw, sessionPath);
    // Simulate the old assistant-only parser without changing session mtime/size.
    session.events = session.events.slice(0, 1);
    const cache: StatsCache = { version: 2, files: {
      [sessionPath]: { path: sessionPath, mtimeMs: info.mtimeMs, size: info.size, parsedAt: 1, session },
    } };
    if (parserVersion !== undefined) Object.assign(cache.files[sessionPath]!, { parserVersion });
    await saveCache(cachePath, cache);
    await run({ sessionDir, sessionPath, cachePath, raw });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("counts all five native usage sources once, without counting nested details or tokensBefore", () => {
  const session = parseSessionText(nativeSession(), "/sessions/all.jsonl");
  const stats = aggregate(cacheOf(session), parseRange("all"));
  assert.equal(session.events.length, 5);
  assert.equal(stats.eventCount, 5);
  assert.equal(stats.totals.input, 500);
  assert.equal(stats.totals.output, 250);
  assert.equal(stats.totals.cacheRead, 150);
  assert.equal(stats.totals.cacheWrite, 100);
  assert.equal(stats.totals.totalTokens, 1000);
  assert.equal(stats.totals.freshTokens, 850);
  assert.ok(Math.abs(stats.totals.cost - 1.65) < 1e-10);
  assert.equal(stats.totals.messages, 2, "only assistant/tool-result records are messages");
  assert.equal(stats.projects[0]!.freshTokens, 850);
  assert.equal(stats.sessions[0]!.freshTokens, 850);
  assert.equal(stats.daily.get("2026-06-01")!.freshTokens, 850);
  assert.equal(stats.sessionCount, 1);
  assert.equal(session.sessionName, "Native usage");
});

test("keeps explicit usage attribution and does not guess summary/tool models", () => {
  const session = parseSessionText(nativeSession());
  const stats = aggregate(cacheOf(session), parseRange("all"));
  assert.equal(stats.models.find((model) => model.key === "parent/parent-model")!.cost, 0.33);
  assert.equal(stats.models.find((model) => model.key === "cache-provider/cache-model")!.cost, 0.33);
  const unknown = stats.models.find((model) => model.key === "unknown/unknown")!;
  assert.ok(Math.abs(unknown.cost - 0.99) < 1e-10);
  assert.equal(unknown.messages, 1);
});

test("filters supplemental usage by each record's timestamp", () => {
  const records = [
    { type: "usage", id: "u", timestamp: "2026-06-02T10:00:00Z", provider: "p", model: "m", usage },
    { type: "compaction", id: "c", timestamp: "2026-06-03T10:00:00Z", usage },
    { type: "branch_summary", id: "b", timestamp: "2026-06-04T10:00:00Z", usage },
    { type: "message", id: "t", timestamp: "2026-06-05T10:00:00Z", message: { role: "toolResult", usage } },
  ];
  const session = parseSessionText(records.map((entry) => JSON.stringify(entry)).join("\n"));
  for (const day of ["02", "03", "04", "05"]) {
    const stats = aggregate(cacheOf(session), parseRange(`2026-06-${day}..2026-06-${day}`));
    assert.equal(stats.eventCount, 1);
    assert.equal(stats.totals.cost, 0.33);
  }
});

test("ignores unsupported, missing and malformed usage records", () => {
  const records = [
    null, [], 7,
    { type: "message", message: { role: "user", usage } },
    { type: "custom", timestamp, usage },
    { type: "message", timestamp, message: { role: "toolResult" } },
    { type: "message", timestamp, message: { role: "toolResult", usage: "invalid" } },
    { type: "compaction", timestamp, tokensBefore: 9000 },
    { type: "branch_summary", timestamp, usage: null },
    { type: "usage", timestamp, usage: [] },
    { type: "usage", usage }, // No usable timestamp or session-header fallback.
  ];
  const session = parseSessionText(records.map((entry) => JSON.stringify(entry)).join("\n") + "\n{broken");
  assert.equal(session.events.length, 0);
});

test("deduplicates fork copies while retaining distinct native usage entry IDs", () => {
  const raw = nativeSession();
  const original = parseSessionText(raw, "/sessions/original.jsonl");
  const fork = parseSessionText(raw, "/sessions/fork.jsonl");
  const stats = aggregate(cacheOf(original, fork), parseRange("all"));
  assert.equal(stats.eventCount, 5);
  assert.ok(Math.abs(stats.totals.cost - 1.65) < 1e-10);
  assert.equal(stats.totals.freshTokens, 850);
});

test("reparses unchanged legacy/stale parser caches, then reuses refreshed files", async () => {
  for (const parserVersion of [undefined, 0]) {
    await withLegacyCache(parserVersion, async ({ sessionDir, sessionPath, cachePath, raw }) => {
      assert.equal((await loadCache(cachePath)).files[sessionPath]!.session.events.length, 1);
      const result = await refreshCache(sessionDir, cachePath);
      assert.equal(result.parsedFiles, 1);
      assert.equal(result.reusedFiles, 0);
      assert.equal(result.errors.length, 0);
      assert.equal(result.cache.version, 2, "cache path/format remain compatible");
      assert.equal(result.cache.files[sessionPath]!.session.events.length, 5);
      assert.equal((await loadCache(cachePath)).files[sessionPath]!.session.events.length, 5);
      assert.equal(await readFile(sessionPath, "utf8"), raw, "session history is read-only");
      const again = await refreshCache(sessionDir, cachePath);
      assert.equal(again.parsedFiles, 0);
      assert.equal(again.reusedFiles, 1);
    });
  }
});

test("preserves legacy cache while session root is unavailable and reparses after recovery", async () => {
  await withLegacyCache(undefined, async ({ sessionDir, sessionPath, cachePath, raw }) => {
    const before = await readFile(cachePath, "utf8");
    await rm(sessionDir, { recursive: true });
    const result = await refreshCache(sessionDir, cachePath);
    assert.equal(result.errors.length, 1);
    assert.equal(result.reusedFiles, 1);
    assert.equal(result.cache.files[sessionPath]!.session.events.length, 1);
    assert.equal(await readFile(cachePath, "utf8"), before);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, raw, "utf8");
    const recovered = await refreshCache(sessionDir, cachePath);
    assert.equal(recovered.parsedFiles, 1);
    assert.equal(recovered.cache.files[sessionPath]!.session.events.length, 5);
  });
});

test("preserves stale file cache after failed reparse without marking it current", async () => {
  await withLegacyCache(undefined, async ({ sessionDir, sessionPath, cachePath, raw }) => {
    const before = (await loadCache(cachePath)).files[sessionPath]!;
    await writeFile(sessionPath, "", "utf8");
    const result = await refreshCache(sessionDir, cachePath);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /shrank/);
    assert.equal(result.reusedFiles, 1);
    assert.deepEqual(result.cache.files[sessionPath], before);
    await writeFile(sessionPath, raw, "utf8");
    const recovered = await refreshCache(sessionDir, cachePath);
    assert.equal(recovered.parsedFiles, 1);
    assert.equal(recovered.cache.files[sessionPath]!.session.events.length, 5);
  });
});
