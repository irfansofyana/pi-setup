import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "./filesystem.ts";
import {
  deleteManagedSkill,
  discoverManagedSkillFiles,
  ensureManagedRootSafe,
  listManagedSkills,
  sanitizeSkillName,
  viewManagedSkill,
  writeManagedSkill,
} from "./skill-store.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "managed-skills-store-"));
}

test("skill store supports validated CRUD", async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = await writeManagedSkill({ action: "create", name: "demo", description: "Use for demos", body: "# Demo", root });
  assert.equal(sanitizeSkillName(" Demo "), "demo");
  assert.equal((await listManagedSkills(root)).length, 1);
  assert.match((await viewManagedSkill("demo", root)).content, /# Demo/);

  await writeManagedSkill({ action: "update", name: "demo", description: "Use after update", body: "# Updated", root });
  assert.match(await readFile(created.path, "utf8"), /# Updated/);
  await deleteManagedSkill("demo", root);
  assert.deepEqual(await listManagedSkills(root), []);
});

test("skill store rejects unsafe names and create/update contract violations", async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["", "-bad", "bad/skill", "../bad", "bad_skill", "a".repeat(65)]) {
    assert.throws(() => sanitizeSkillName(name), /Invalid skill name/);
  }
  await writeManagedSkill({ action: "create", name: "demo", description: "d", body: "body", root });
  await assert.rejects(() => writeManagedSkill({ action: "create", name: "demo", description: "d", body: "body", root }), /already exists/);
  await assert.rejects(() => writeManagedSkill({ action: "update", name: "missing", description: "d", body: "body", root }), /does not exist/);
});

test("skill store rejects symlinked roots and skill directories", async (t) => {
  const base = await tempRoot();
  const outside = await tempRoot();
  t.after(() => Promise.all([rm(base, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const rootLink = join(base, "root-link");
  await symlink(outside, rootLink, "dir");
  await assert.rejects(() => ensureManagedRootSafe(rootLink), /root is a symlink/);

  const root = join(base, "root");
  await ensureManagedRootSafe(root);
  await symlink(outside, join(root, "demo"), "dir");
  await assert.rejects(() => writeManagedSkill({ action: "create", name: "demo", description: "d", body: "body", root }), /symlink/);
});

test("failed atomic update preserves existing skill content", async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = await writeManagedSkill({ action: "create", name: "demo", description: "d", body: "old", root });

  await assert.rejects(() => writeManagedSkill(
    { action: "update", name: "demo", description: "d", body: "new", root },
    { atomicWrite: async () => { throw new Error("injected update failure"); } },
  ), /injected update failure/);

  assert.match(await readFile(created.path, "utf8"), /old/);
});

test("configured byte limits are consistent for list and view", async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeManagedSkill({
    action: "create",
    name: "large-skill",
    description: "large",
    body: `# Large\n\n${"x".repeat(70_000)}`,
    root,
    maxBytes: 80_000,
  });

  assert.equal((await listManagedSkills(root, 80_000)).length, 1);
  assert.equal((await listManagedSkills(root, 64_000)).length, 0);
  await assert.rejects(() => viewManagedSkill("large-skill", root, 64_000), /limit is 64000/);
});

test("discovery and reads reject linked skill files", async (t) => {
  const root = await tempRoot();
  const outside = await tempRoot();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await ensureManagedRootSafe(root);
  await writeManagedSkill({ action: "create", name: "linked", description: "d", body: "body", root });
  await link(join(root, "linked", "SKILL.md"), join(root, "linked", "LINK.md"));
  await symlink(outside, join(root, "linked-dir"));

  assert.deepEqual(await discoverManagedSkillFiles(root), []);
  await assert.rejects(() => viewManagedSkill("linked", root), /hard links/);
});

test("same-skill concurrent updates are serialized", async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeManagedSkill({ action: "create", name: "demo", description: "d", body: "initial", root });
  let active = 0;
  let maxActive = 0;
  const serializedWriter = async (path: string, content: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await atomicWriteFile(path, content);
    active -= 1;
  };

  await Promise.all([
    writeManagedSkill({ action: "update", name: "demo", description: "d", body: "first", root }, { atomicWrite: serializedWriter }),
    writeManagedSkill({ action: "update", name: "demo", description: "d", body: "second", root }, { atomicWrite: serializedWriter }),
  ]);

  assert.equal(maxActive, 1);
  assert.match((await viewManagedSkill("demo", root)).content, /second/);
});
