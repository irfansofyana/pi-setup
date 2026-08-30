import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
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
