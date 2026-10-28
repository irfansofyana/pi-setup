import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, loadCache, parseRange, parseSessionText, refreshCache, saveCache, type StatsCache } from "./stats.ts";

const sessionA = `
{"type":"session","version":3,"id":"s1","timestamp":"2026-06-01T10:00:00.000Z","cwd":"/work/pi-stats-ext"}
{"type":"message","id":"u1","timestamp":"2026-06-01T10:00:01.000Z","message":{"role":"user","content":"Build stats"}}
{"type":"message","id":"a1","timestamp":"2026-06-01T10:00:02.000Z","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet","timestamp":1780308002000,"usage":{"input":100,"output":50,"cacheRead":25,"cacheWrite":10,"totalTokens":185,"cost":{"total":0.02}}}}
{"type":"session_info","id":"n1","timestamp":"2026-06-01T10:00:03.000Z","name":"Stats MVP"}
`;

const sessionB = `
{"type":"session","version":3,"id":"s2","timestamp":"2026-06-02T10:00:00.000Z","cwd":"/work/other"}
{"type":"message","id":"a2","timestamp":"2026-06-02T10:00:02.000Z","message":{"role":"assistant","provider":"openai","model":"gpt-5","timestamp":1780394402000,"usage":{"input":200,"output":80,"cacheRead":0,"cacheWrite":20,"totalTokens":300,"cost":{"total":0.04}}}}
`;

test("parses Pi session usage events", () => {
  const parsed = parseSessionText(sessionA, "/tmp/s1.jsonl");
  assert.equal(parsed.sessionId, "s1");
  assert.equal(parsed.sessionName, "Stats MVP");
  assert.equal(parsed.project, "pi-stats-ext");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]!.eventId, "a1");
  assert.equal(parsed.events[0]!.freshTokens, 160);
  assert.equal(parsed.events[0]!.totalTokens, 185);
  assert.equal(parsed.events[0]!.cost, 0.02);
});

test("aggregates date range, models, projects, and sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-"));
  try {
    const sessionDir = join(root, "sessions");
    await writeFile(join(sessionDir, "one.jsonl"), sessionA, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      await import("node:fs/promises").then(({ mkdir }) => mkdir(sessionDir, { recursive: true }));
      await writeFile(join(sessionDir, "one.jsonl"), sessionA, "utf8");
    });
    await writeFile(join(sessionDir, "two.jsonl"), sessionB, "utf8");

    const result = await refreshCache(sessionDir, join(root, "cache.json"));
    assert.equal(result.totalFiles, 2);
    assert.equal(result.parsedFiles, 2);

    const stats = aggregate(result.cache, { label: "custom", start: Date.parse("2026-06-01T00:00:00.000Z"), end: Date.parse("2026-06-03T00:00:00.000Z") });
    assert.equal(stats.totals.input, 300);
    assert.equal(stats.totals.output, 130);
    assert.equal(stats.totals.cacheWrite, 30);
    assert.equal(stats.totals.freshTokens, 460);
    assert.equal(stats.totals.cost, 0.06);
    assert.equal(stats.activeDays, 2);
    assert.equal(stats.models[0]!.label, "gpt-5");
    assert.equal(stats.projects[0]!.label, "other");
    assert.equal(stats.sessions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses unchanged cached session files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-cache-"));
  try {
    const sessionDir = join(root, "sessions");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sessionDir, { recursive: true }));
    await writeFile(join(sessionDir, "one.jsonl"), sessionA, "utf8");
    const cachePath = join(root, "cache.json");

    await refreshCache(sessionDir, cachePath);
    const second = await refreshCache(sessionDir, cachePath);
    assert.equal(second.parsedFiles, 0);
    assert.equal(second.reusedFiles, 1);
    const raw = await readFile(cachePath, "utf8");
    assert.match(raw, /Stats MVP/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses supported ranges", () => {
  const now = Date.parse("2026-06-28T12:00:00.000Z");
  assert.equal(parseRange("", now).label, "last 30d");
  assert.equal(parseRange("today", now).label, "today");
  assert.equal(parseRange("today", now).start, Date.parse("2026-06-28T00:00:00.000Z"));
  assert.equal(parseRange("today", now).end, Date.parse("2026-06-29T00:00:00.000Z"));
  assert.equal(parseRange("7", now).label, "last 7d");
  assert.equal(parseRange("all", now).label, "all time");
  assert.equal(parseRange("2026-06-01..2026-06-03", now).label, "2026-06-01..2026-06-03");
  assert.equal(parseRange("2026-06-28..2026-06-28", now).start, Date.parse("2026-06-28T00:00:00.000Z"));
  assert.equal(parseRange("2026-06-28..2026-06-28", now).end, Date.parse("2026-06-29T00:00:00.000Z"));
  assert.equal(parseRange("2026-02-30..2026-03-05", now).label, "last 30d");
  assert.equal(parseRange("2025-02-29..2025-03-01", now).label, "last 30d");
});

test("does not deduplicate distinct events with identical usage", () => {
  const second = sessionA.replace('"id":"s1"', '"id":"s2"').replace('"id":"a1"', '"id":"a2"');
  const sessions = [parseSessionText(sessionA, "/tmp/one.jsonl"), parseSessionText(second, "/tmp/two.jsonl")];
  const cache: StatsCache = {
    version: 2,
    files: Object.fromEntries(sessions.map((session, index) => [session.sessionPath, {
      path: session.sessionPath,
      mtimeMs: index,
      size: 1,
      parsedAt: 0,
      session,
    }])),
  };

  const stats = aggregate(cache, parseRange("2026-06-01..2026-06-01"));
  assert.equal(stats.eventCount, 2);
  assert.equal(stats.sessionCount, 2);
  assert.equal(stats.totals.freshTokens, 320);
});

test("does not deduplicate unrelated events that reuse a session-local entry id", () => {
  const second = sessionA
    .replace('"id":"s1"', '"id":"s2"')
    .replace('"timestamp":1780308002000', '"timestamp":1780308003000')
    .replace('"input":100', '"input":101')
    .replace('"totalTokens":185', '"totalTokens":186');
  const sessions = [parseSessionText(sessionA, "/tmp/one.jsonl"), parseSessionText(second, "/tmp/two.jsonl")];
  const cache: StatsCache = {
    version: 2,
    files: Object.fromEntries(sessions.map((session, index) => [session.sessionPath, {
      path: session.sessionPath,
      mtimeMs: index,
      size: 1,
      parsedAt: 0,
      session,
    }])),
  };

  const stats = aggregate(cache, parseRange("2026-06-01..2026-06-01"));
  assert.equal(stats.eventCount, 2);
  assert.equal(stats.totals.input, 201);
});

test("deduplicates copied fork events by stable entry id", () => {
  const sessions = [parseSessionText(sessionA, "/tmp/original.jsonl"), parseSessionText(sessionA, "/tmp/fork.jsonl")];
  const cache: StatsCache = {
    version: 2,
    files: Object.fromEntries(sessions.map((session, index) => [session.sessionPath, {
      path: session.sessionPath,
      mtimeMs: index,
      size: 1,
      parsedAt: 0,
      session,
    }])),
  };

  const stats = aggregate(cache, parseRange("2026-06-01..2026-06-01"));
  assert.equal(stats.eventCount, 1);
  assert.equal(stats.totals.freshTokens, 160);
});

test("keeps a valid cache when the session root is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-missing-root-"));
  try {
    const sessionDir = join(root, "sessions");
    const cachePath = join(root, "cache.json");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "one.jsonl"), sessionA, "utf8");
    await refreshCache(sessionDir, cachePath);
    await rm(sessionDir, { recursive: true, force: true });

    const result = await refreshCache(sessionDir, cachePath);
    assert.equal(result.errors.length, 1);
    assert.equal(result.reusedFiles, 1);
    assert.equal(Object.keys(result.cache.files).length, 1);
    assert.equal(Object.keys((JSON.parse(await readFile(cachePath, "utf8")) as StatsCache).files).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps cached data when an append-only session file shrinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-shrunk-file-"));
  try {
    const sessionDir = join(root, "sessions");
    const cachePath = join(root, "cache.json");
    const sessionPath = join(sessionDir, "one.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, sessionA, "utf8");
    await refreshCache(sessionDir, cachePath);
    await writeFile(sessionPath, "", "utf8");

    const result = await refreshCache(sessionDir, cachePath);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /shrank/);
    assert.equal(result.cache.files[sessionPath]!.session.events.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects structurally malformed and legacy caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-bad-cache-"));
  try {
    const cachePath = join(root, "cache.json");
    await writeFile(cachePath, JSON.stringify({ version: 2, files: { bad: {} } }), "utf8");
    assert.deepEqual(await loadCache(cachePath), { version: 2, files: {} });
    await writeFile(cachePath, JSON.stringify({ version: 1, files: {} }), "utf8");
    assert.deepEqual(await loadCache(cachePath), { version: 2, files: {} });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports concurrent atomic cache saves", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-concurrent-save-"));
  try {
    const cachePath = join(root, "cache.json");
    const empty: StatsCache = { version: 2, files: {} };
    const results = await Promise.allSettled([saveCache(cachePath, empty), saveCache(cachePath, empty)]);
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
    assert.deepEqual(await loadCache(cachePath), empty);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes usage events without a valid timestamp", () => {
  const raw = JSON.stringify({ type: "message", id: "missing-time", message: { role: "assistant", provider: "p", model: "m", usage: { input: 10, output: 5 } } });
  const parsed = parseSessionText(raw);
  assert.equal(parsed.events.length, 0);
});
