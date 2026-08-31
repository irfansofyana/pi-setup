import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore, TimedCache } from "./storage.ts";

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

test("ArtifactStore reserves capacity for the new artifact before publishing it", async () => {
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

  await store.save({ url: "https://example.test/one", title: "One", content: "one", provider: "tavily" });
  await store.save({ url: "https://example.test/two", title: "Two", content: "two", provider: "tavily" });

  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".json")), ["artifact-2.json"]);
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

  await Promise.all([
    first.save({ url: "https://example.test/one", title: "One", content: "one", provider: "tavily" }),
    second.save({ url: "https://example.test/two", title: "Two", content: "two", provider: "exa" }),
  ]);

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
  await Promise.all([
    first.save({ url: "https://example.test/one", title: "One", content: "a".repeat(1_200), provider: "tavily" }),
    second.save({ url: "https://example.test/two", title: "Two", content: "b".repeat(1_200), provider: "exa" }),
  ]);

  const files = (await readdir(root)).filter((name) => name.endsWith(".json"));
  const totalBytes = (await Promise.all(files.map(async (name) => (await stat(join(root, name))).size)))
    .reduce((sum, size) => sum + size, 0);
  assert.ok(totalBytes <= maxBytes, `${totalBytes} exceeds ${maxBytes}`);
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

test("ArtifactStore times out when a crashed owner leaves the lock unpublished", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-ownerless-lock-"));
  await mkdir(join(root, ".capacity.lock"));
  const store = new ArtifactStore({
    root,
    now: () => 1_725_000_000_000,
    randomId: () => "must-not-publish",
    ttlMs: 60_000,
    maxEntries: 1,
    maxBytes: 10_000,
    lockTimeoutMs: 30,
  });
  const started = Date.now();
  await assert.rejects(
    store.save({ url: "https://example.test", title: "blocked", content: "blocked", provider: "tavily" }),
    /timed out/i,
  );
  assert.ok(Date.now() - started < 500);
});

test("ArtifactStore never reclaims a stale-looking lock owned by a live process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-artifact-live-owner-"));
  const lock = join(root, ".capacity.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "live-owner" })}\n`);
  await utimes(lock, new Date(0), new Date(0));
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
  assert.equal((await readFile(join(lock, "owner.json"), "utf8")).includes("live-owner"), true);
});
