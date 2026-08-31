import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ArtifactStore, TimedCache } from "./storage.ts";

const execFileAsync = promisify(execFile);

test("TimedCache expires entries and evicts the least recently used entry", () => {
  let now = 1_000;
  const cache = new TimedCache<string>(() => now, 100, 2);
  cache.set("a", "A");
  cache.set("b", "B");
  assert.equal(cache.get("a"), "A");
  cache.set("c", "C");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "A");
  now = 1_101;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
});

test("TimedCache sweeps unrelated expired entries during ordinary access", () => {
  let now = 1_000;
  const cache = new TimedCache<string>(() => now, 10, 10);
  cache.set("sensitive-plaintext-key", "secret");
  now = 1_011;
  assert.equal(cache.get("different-key"), undefined);
  assert.equal((cache as any).entries.has("sensitive-plaintext-key"), false);
});

test("TimedCache expires idle entries without later cache access", async () => {
  const cache = new TimedCache<string>(() => Date.now(), 10, 10);
  cache.set("idle-sensitive-key", "secret");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((cache as any).entries.has("idle-sensitive-key"), false);
});

test("ArtifactStore preserves valid artifacts and rejects a save when the entry cap is full", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-capacity-"));
  let id = 0;
  let now = 1_725_000_000_000;
  const store = new ArtifactStore({
    root,
    now: () => now++,
    randomId: () => `artifact-${++id}`,
    ttlMs: 60_000,
    maxEntries: 1,
    maxBytes: 10_000,
  });

  const first = await store.save({ url: "https://example.test/one", title: "One", content: "one", provider: "tavily" });
  await assert.rejects(
    store.save({ url: "https://example.test/two", title: "Two", content: "two", provider: "tavily" }),
    /capacity is full/i,
  );

  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".json")), ["artifact-1.json"]);
  assert.equal(JSON.parse(await readFile(first.path, "utf8")).content, "one");
});

test("ArtifactStore honors persisted expiresAt across process TTL changes", async () => {
  const base = 1_725_000_000_000;

  const validRoot = await mkdtemp(join(tmpdir(), "pi-web-artifact-valid-expiry-"));
  const original = new ArtifactStore({ root: validRoot, now: () => base, randomId: () => "original-valid", ttlMs: 86_400_000, maxEntries: 2, maxBytes: 10_000 });
  const valid = await original.save({ url: "https://example.test/valid", title: "valid", content: "valid", provider: "tavily" });
  await utimes(valid.path, new Date(base), new Date(base));
  const shorterConfig = new ArtifactStore({ root: validRoot, now: () => base + 1_000, randomId: () => "new-valid", ttlMs: 1, maxEntries: 2, maxBytes: 10_000 });
  await shorterConfig.save({ url: "https://example.test/new", title: "new", content: "new", provider: "tavily" });
  assert.deepEqual((await readdir(validRoot)).filter((name) => name.endsWith(".json")).sort(), ["new-valid.json", "original-valid.json"]);

  const expiredRoot = await mkdtemp(join(tmpdir(), "pi-web-artifact-expired-record-"));
  const shortLived = new ArtifactStore({ root: expiredRoot, now: () => base, randomId: () => "expired", ttlMs: 1, maxEntries: 1, maxBytes: 10_000 });
  const expired = await shortLived.save({ url: "https://example.test/expired", title: "expired", content: "expired", provider: "tavily" });
  await utimes(expired.path, new Date(base + 86_400_000), new Date(base + 86_400_000));
  const longerConfig = new ArtifactStore({ root: expiredRoot, now: () => base + 1_000, randomId: () => "replacement", ttlMs: 86_400_000, maxEntries: 1, maxBytes: 10_000 });
  await longerConfig.save({ url: "https://example.test/replacement", title: "replacement", content: "replacement", provider: "exa" });
  assert.deepEqual((await readdir(expiredRoot)).filter((name) => name.endsWith(".json")), ["replacement.json"]);
});

test("ArtifactStore fails closed on ambiguous artifact expiry metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-invalid-expiry-"));
  await writeFile(join(root, "invalid.json"), "not-json", { mode: 0o600 });
  const store = new ArtifactStore({ root, now: () => Date.now(), randomId: () => "must-not-publish", ttlMs: 60_000, maxEntries: 2, maxBytes: 10_000 });
  await assert.rejects(
    store.save({ url: "https://example.test", title: "blocked", content: "blocked", provider: "tavily" }),
    /invalid|metadata|JSON/i,
  );
  assert.equal(await readFile(join(root, "invalid.json"), "utf8"), "not-json");
});

test("ArtifactStore refuses an ID collision without overwriting the existing artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-collision-"));
  const store = new ArtifactStore({
    root,
    now: () => 1_725_000_000_000,
    randomId: () => "same-id",
    ttlMs: 60_000,
    maxEntries: 10,
    maxBytes: 10_000,
  });

  const first = await store.save({ url: "https://example.test/one", title: "One", content: "original", provider: "tavily" });
  await assert.rejects(
    store.save({ url: "https://example.test/two", title: "Two", content: "replacement", provider: "exa" }),
  );
  const stored = JSON.parse(await readFile(first.path, "utf8"));
  assert.equal(stored.content, "original");
  assert.equal(stored.url, "https://example.test/one");
});

test("ArtifactStore serializes concurrent entry-cap reservations across store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-concurrent-entries-"));
  const options = {
    root,
    now: () => 1_725_000_000_000,
    ttlMs: 60_000,
    maxEntries: 1,
    maxBytes: 10_000,
  };
  const first = new ArtifactStore({ ...options, randomId: () => "concurrent-one" });
  const second = new ArtifactStore({ ...options, randomId: () => "concurrent-two" });

  const outcomes = await Promise.allSettled([
    first.save({ url: "https://example.test/one", title: "One", content: "one", provider: "tavily" }),
    second.save({ url: "https://example.test/two", title: "Two", content: "two", provider: "exa" }),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".json")).length, 1);
});

test("ArtifactStore serializes concurrent byte-cap reservations across store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-concurrent-bytes-"));
  const maxBytes = 2_000;
  const options = {
    root,
    now: () => 1_725_000_000_000,
    ttlMs: 60_000,
    maxEntries: 10,
    maxBytes,
  };
  const first = new ArtifactStore({ ...options, randomId: () => "bytes-one" });
  const second = new ArtifactStore({ ...options, randomId: () => "bytes-two" });
  const outcomes = await Promise.allSettled([
    first.save({ url: "https://example.test/one", title: "One", content: "a".repeat(1_200), provider: "tavily" }),
    second.save({ url: "https://example.test/two", title: "Two", content: "b".repeat(1_200), provider: "exa" }),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const files = (await readdir(root)).filter((name) => name.endsWith(".json"));
  const totalBytes = (await Promise.all(files.map(async (name) => (await stat(join(root, name))).size)))
    .reduce((sum, size) => sum + size, 0);
  assert.ok(totalBytes <= maxBytes, `${totalBytes} exceeds ${maxBytes}`);
});

test("ArtifactStore serializes capacity reservations across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-cross-process-"));
  const moduleUrl = new URL("./storage.ts", import.meta.url).href;
  const script = `
    import { ArtifactStore } from ${JSON.stringify(moduleUrl)};
    const [root, id] = process.argv.slice(1);
    const store = new ArtifactStore({ root, now: () => Date.now(), randomId: () => id, ttlMs: 60000, maxEntries: 1, maxBytes: 10000 });
    await store.save({ url: 'https://example.test/' + id, title: id, content: id, provider: 'tavily' });
  `;
  const outcomes = await Promise.allSettled([
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script, root, "process-one"]),
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script, root, "process-two"]),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".json")).length, 1);
});

test("ArtifactStore retrieves bounded content by opaque ID and rejects unsafe IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-read-"));
  const store = new ArtifactStore({
    root,
    now: () => 1_725_000_000_000,
    randomId: () => "readable-artifact",
    ttlMs: 60_000,
    maxEntries: 10,
    maxBytes: 10_000,
  });
  await store.save({
    url: "https://example.test/page",
    title: "Page",
    content: "0123456789",
    provider: "tavily",
    context: { focus: "claim", maxCharactersPerResult: 50_000 },
  });

  const page = await store.read("readable-artifact", 3, 4);
  assert.equal(page.content, "3456");
  assert.equal(page.offset, 3);
  assert.equal(page.nextOffset, 7);
  assert.equal(page.hasMore, true);
  assert.match(page.contextKey, /^[a-f0-9]{64}$/);
  await assert.rejects(store.read("../escape", 0, 10), /unsafe artifact ID/i);
});

test("ArtifactStore cancellation while waiting for a stale lock never publishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-cancel-lock-"));
  const lock = join(root, ".capacity.lock");
  await mkdir(lock);
  await utimes(lock, new Date(0), new Date(0));
  const controller = new AbortController();
  controller.abort();
  const store = new ArtifactStore({
    root,
    now: () => 1_725_000_000_000,
    randomId: () => "cancelled-artifact",
    ttlMs: 60_000,
    maxEntries: 1,
    maxBytes: 10_000,
  });

  await assert.rejects(
    store.save({ url: "https://example.test", title: "cancelled", content: "never publish", provider: "tavily" }, controller.signal),
    /cancelled/i,
  );
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".json")), []);
});

test("ArtifactStore uses no SQLite runtime or control file", async () => {
  const source = await readFile(new URL("./storage.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:sqlite|DatabaseSync|\.capacity\.sqlite/);
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-no-sqlite-"));
  const store = new ArtifactStore({ root, now: () => Date.now(), randomId: () => "filesystem-only", ttlMs: 60_000, maxEntries: 2, maxBytes: 10_000 });
  await store.save({ url: "https://example.test", title: "saved", content: "saved", provider: "tavily" });
  assert.equal((await readdir(root)).some((name) => name.includes("sqlite")), false);
});

test("ArtifactStore fails closed instead of reclaiming an uncertain filesystem lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-uncertain-lock-"));
  const lock = join(root, ".capacity.lock");
  await mkdir(lock);
  let monotonic = 0;
  const store = new ArtifactStore({ root, now: () => Date.now(), monotonicNow: () => (monotonic += 10), randomId: () => "must-not-publish", ttlMs: 60_000, maxEntries: 1, maxBytes: 10_000, lockTimeoutMs: 30 });
  await assert.rejects(
    store.save({ url: "https://example.test", title: "blocked", content: "blocked", provider: "tavily" }),
    /timed out/i,
  );
  assert.equal((await stat(lock)).isDirectory(), true);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".json")), []);
});

test("ArtifactStore lock timeout uses monotonic elapsed time", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-monotonic-lock-"));
  const lockPath = join(root, ".capacity.lock");
  await mkdir(lockPath);
  let monotonic = 0;
  const controller = new AbortController();
  const safetyTimer = setTimeout(() => controller.abort(), 100);
  const originalDateNow = Date.now;
  Date.now = () => 0;
  try {
    const store = new ArtifactStore({
      root,
      now: () => 1_725_000_000_000,
      monotonicNow: () => (monotonic += 10),
      randomId: () => "must-not-publish",
      ttlMs: 60_000,
      maxEntries: 1,
      maxBytes: 10_000,
      lockTimeoutMs: 30,
    });
    await assert.rejects(
      store.save({ url: "https://example.test", title: "blocked", content: "blocked", provider: "tavily" }, controller.signal),
      /timed out/i,
    );
  } finally {
    clearTimeout(safetyTimer);
    Date.now = originalDateNow;
  }
});

test("ArtifactStore never reclaims a stale-looking lock owned by a live process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-live-owner-"));
  const lockPath = join(root, ".capacity.lock");
  await mkdir(lockPath);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const store = new ArtifactStore({
    root,
    now: () => 1_725_000_000_000,
    randomId: () => "must-not-publish",
    ttlMs: 60_000,
    maxEntries: 1,
    maxBytes: 10_000,
  });

  await assert.rejects(
    store.save({ url: "https://example.test", title: "blocked", content: "blocked", provider: "tavily" }, controller.signal),
    /cancelled/i,
  );
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".json")), []);
});

test("ArtifactStore removes every pre-existing artifact temporary while holding capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-orphan-temp-"));
  await writeFile(join(root, ".orphan.999999.tmp"), "x".repeat(2_000));
  let id = 0;
  const store = new ArtifactStore({
    root,
    now: () => 1_725_000_000_000,
    randomId: () => `after-orphan-${++id}`,
    ttlMs: 60_000,
    maxEntries: 2,
    maxBytes: 1_000,
  });
  await store.save({ url: "https://example.test", title: "saved", content: "small", provider: "tavily" });
  assert.equal((await readdir(root)).includes(".orphan.999999.tmp"), false);

  const reusedPid = join(root, `.live.${process.pid}.tmp`);
  await writeFile(reusedPid, "x".repeat(2_000));
  await store.save({ url: "https://example.test/two", title: "saved", content: "small", provider: "tavily" });
  assert.equal((await readdir(root)).includes(`.live.${process.pid}.tmp`), false);
});
