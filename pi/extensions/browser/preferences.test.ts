import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserPreferences } from "./preferences.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const agent = await mkdtemp(join(tmpdir(), "pi-browser-preferences-"));
  t.after(() => rm(agent, { recursive: true, force: true }));
  return { agent, store: new BrowserPreferences(agent) };
}

test("missing preferences remain off and reading creates nothing", async (t) => {
  const { store } = await fixture(t);
  const saved = await store.read();
  assert.equal(saved.enabled, false);
  assert.equal(saved.exists, false);
  await assert.rejects(access(store.directory), { code: "ENOENT" });
  await store.setEnabled(saved, false);
  await assert.rejects(access(store.directory), { code: "ENOENT" });
});

test("explicit enable creates global private settings; disable preserves unknown keys and exact backup", async (t) => {
  const { agent, store } = await fixture(t);
  const enabled = await store.setEnabled(await store.read(), true);
  assert.equal(enabled.snapshot.enabled, true);
  assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), { schemaVersion: 1, enabled: true });
  if (process.platform !== "win32") {
    assert.equal((await lstat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(store.path)).mode & 0o777, 0o600);
  }
  const raw = '{"schemaVersion":1,"enabled":true,"custom":{"preserve":[1,2,3]}}\n';
  await writeFile(store.path, raw);
  const result = await store.setEnabled(await store.read(), false);
  assert.ok(result.backup?.startsWith(join(agent, "browser", "backups")));
  assert.equal(await readFile(result.backup!, "utf8"), raw);
  if (process.platform !== "win32") assert.equal((await lstat(result.backup!)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), { schemaVersion: 1, enabled: false, custom: { preserve: [1, 2, 3] } });
  await assert.rejects(access(join(store.directory, ".config.lock")), { code: "ENOENT" });
});

test("invalid or future settings fail closed without exposing their contents", async (t) => {
  const { store } = await fixture(t);
  await mkdir(store.directory);
  for (const source of ['{"private":"test-sensitive-marker",', '[]', 'null', '{"enabled":"true"}', '{"schemaVersion":2,"enabled":true}']) {
    await writeFile(store.path, source);
    await assert.rejects(store.read(), (error: Error) => {
      assert.doesNotMatch(error.message, /test-sensitive-marker/);
      assert.match(error.message, /invalid|object|Unsupported/);
      return true;
    });
    assert.equal(await readFile(store.path, "utf8"), source);
  }
});

test("settings exceeding 64 KiB are rejected without rewriting", async (t) => {
  const { store } = await fixture(t);
  await mkdir(store.directory);
  await writeFile(store.path, JSON.stringify({ enabled: true, custom: "x".repeat(65536) }));
  await assert.rejects(store.read(), /64 KiB/);
});

test("drift since consent stops save and preserves external changes", async (t) => {
  const { store } = await fixture(t);
  const reviewed = await store.read();
  await mkdir(store.directory);
  const external = '{"enabled":false,"custom":"external"}\n';
  await writeFile(store.path, external);
  await assert.rejects(store.setEnabled(reviewed, true), /changed since review/);
  assert.equal(await readFile(store.path, "utf8"), external);
  assert.deepEqual((await readdir(store.directory)).sort(), ["config.json"]);
});

test("uncertain lock is never removed or bypassed", async (t) => {
  const { store } = await fixture(t);
  const reviewed = await store.read();
  await mkdir(store.directory);
  const lock = join(store.directory, ".config.lock");
  await mkdir(lock);
  await assert.rejects(store.setEnabled(reviewed, true), /busy or locked/);
  await access(lock);
  await assert.rejects(access(store.path), { code: "ENOENT" });
});

test("independent writers do not overwrite another process's preference update", async (t) => {
  const { agent, store } = await fixture(t);
  const second = new BrowserPreferences(agent);
  const reviewed = await store.read();
  const results = await Promise.allSettled([store.setEnabled(reviewed, true), second.setEnabled(reviewed, true)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await store.read()).enabled, true);
  assert.deepEqual((await readdir(store.directory)).sort(), ["config.json"]);
});

test("already-aborted save creates no files", async (t) => {
  const { store } = await fixture(t);
  const signal = new AbortController(); signal.abort();
  await assert.rejects(store.setEnabled(await store.read(), true, signal.signal), /cancelled/);
  await assert.rejects(access(store.directory), { code: "ENOENT" });
});

test("symlinked settings and feature directory are rejected", { skip: process.platform === "win32" }, async (t) => {
  const { agent, store } = await fixture(t);
  const external = join(agent, "external.json");
  await writeFile(external, '{"enabled":true}');
  await mkdir(store.directory);
  await symlink(external, store.path);
  await assert.rejects(store.read(), /regular JSON file/);
  await rm(store.directory, { recursive: true });
  const other = join(agent, "other"); await mkdir(other);
  await symlink(other, store.directory);
  await assert.rejects(store.read(), /real directory/);
  assert.equal(await readFile(external, "utf8"), '{"enabled":true}');
});
