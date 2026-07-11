import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile, readRegularFile } from "./filesystem.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "managed-skills-filesystem-"));
}

test("atomicWriteFile replaces a destination symlink without changing its target", async (t) => {
  const root = await tempRoot();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const target = join(root, "target.txt");
  const destination = join(root, "config.json");
  await writeFile(target, "keep");
  await symlink(target, destination);

  await atomicWriteFile(destination, "replacement", { mode: 0o600 });

  assert.equal(await readFile(target, "utf8"), "keep");
  assert.equal(await readFile(destination, "utf8"), "replacement");
});

test("atomicWriteFile preserves old content and cleans temp files on failure", async (t) => {
  const root = await tempRoot();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const destination = join(root, "SKILL.md");
  await writeFile(destination, "old");

  await assert.rejects(() => atomicWriteFile(destination, "new", {
    beforeRename: () => {
      throw new Error("injected failure");
    },
  }), /injected failure/);

  assert.equal(await readFile(destination, "utf8"), "old");
  assert.deepEqual((await readdir(root)).sort(), ["SKILL.md"]);
});

test("readRegularFile rejects hard links and oversized content", async (t) => {
  const root = await tempRoot();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const file = join(root, "SKILL.md");
  await writeFile(file, "content");
  await link(file, join(root, "LINK.md"));

  await assert.rejects(() => readRegularFile(file, { label: "skill", maxBytes: 100 }), /hard links/);
  await import("node:fs/promises").then(({ rm }) => rm(join(root, "LINK.md")));
  await assert.rejects(() => readRegularFile(file, { label: "skill", maxBytes: 3 }), /limit is 3/);
});

test("readRegularFile rejects symlinks before opening them", async (t) => {
  const root = await tempRoot();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const target = join(root, "target.txt");
  const linked = join(root, "linked.txt");
  await writeFile(target, "secret");
  await symlink(target, linked);

  await assert.rejects(() => readRegularFile(linked, { label: "skill", maxBytes: 100 }), /symlink/);
});
