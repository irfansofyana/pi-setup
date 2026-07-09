import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  computeHindsightScope,
  deleteManagedSkill,
  ensureManagedRootSafe,
  listManagedSkills,
  normalizeManagedSkillsConfig,
  parseSkillFrontmatter,
  projectKey,
  redactSecrets,
  retainHindsightLesson,
  sanitizeLearnText,
  sanitizeManagedDescription,
  sanitizeSkillName,
  serializeManagedSkill,
  viewManagedSkill,
  writeManagedSkill,
} from "./index.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-managed-skills-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

test("sanitizeSkillName accepts safe kebab-case names", () => {
  assert.equal(sanitizeSkillName("foo-bar-123"), "foo-bar-123");
  assert.equal(sanitizeSkillName(" Foo-Bar "), "foo-bar");
});

test("sanitizeSkillName rejects unsafe names", () => {
  for (const name of ["", "-bad", "bad/skill", "../bad", "bad_skill", "a".repeat(65)]) {
    assert.throws(() => sanitizeSkillName(name), /Invalid skill name/);
  }
});

test("sanitizeManagedDescription strips prompt-breaking characters", () => {
  assert.equal(sanitizeManagedDescription("hello <skills> `x` ~~~\nworld"), "hello skills x ~ world");
});

test("serializeManagedSkill generates valid frontmatter", () => {
  const content = serializeManagedSkill({ name: "demo-skill", description: "Use for demos", body: "# Demo\n\nDo thing." });
  assert.match(content, /^---\nname: demo-skill\ndescription: "Use for demos"\n---\n\n# Demo/);
  assert.deepEqual(parseSkillFrontmatter(content), { name: "demo-skill", description: "Use for demos" });
});

test("normalizeManagedSkillsConfig fills defaults and clamps numbers", () => {
  assert.deepEqual(normalizeManagedSkillsConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(normalizeManagedSkillsConfig({ enabled: false, learnEnabled: false, autoCapture: true, autoContinue: true, minToolCalls: 0, maxSkillBytes: 10, maxMemoryChars: 20 }), {
    enabled: false,
    learnEnabled: false,
    autoCapture: true,
    autoContinue: true,
    minToolCalls: 0,
    maxSkillBytes: 10,
    maxMemoryChars: 20,
  });
  assert.equal(normalizeManagedSkillsConfig({ minToolCalls: -1 }).minToolCalls, DEFAULT_CONFIG.minToolCalls);
});

test("writeManagedSkill creates, lists, views, updates, and deletes", async () => {
  const root = tempRoot();
  try {
    const created = await writeManagedSkill({ action: "create", name: "demo-skill", description: "Use for demos", body: "# Demo", root });
    assert.ok(existsSync(created.path));
    assert.equal(readFileSync(created.path, "utf8").includes("# Demo"), true);

    const listed = await listManagedSkills(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "demo-skill");
    assert.equal(listed[0].description, "Use for demos");

    const viewed = await viewManagedSkill("demo-skill", root);
    assert.match(viewed.content, /# Demo/);

    await writeManagedSkill({ action: "update", name: "demo-skill", description: "Use after update", body: "# Updated", root });
    assert.match(readFileSync(created.path, "utf8"), /# Updated/);

    await deleteManagedSkill("demo-skill", root);
    assert.equal(existsSync(created.path), false);
  } finally {
    cleanup(root);
  }
});

test("writeManagedSkill enforces create/update contracts", async () => {
  const root = tempRoot();
  try {
    await writeManagedSkill({ action: "create", name: "demo", description: "d", body: "body", root });
    await assert.rejects(() => writeManagedSkill({ action: "create", name: "demo", description: "d", body: "body", root }), /already exists/);
    await assert.rejects(() => writeManagedSkill({ action: "update", name: "missing", description: "d", body: "body", root }), /does not exist/);
    await assert.rejects(() => writeManagedSkill({ action: "create", name: "too-big", description: "d", body: "body", root, maxBytes: 10 }), /limit is 10/);
  } finally {
    cleanup(root);
  }
});

test("ensureManagedRootSafe rejects symlinked roots", async () => {
  const base = tempRoot();
  const target = join(base, "target");
  const link = join(base, "link");
  try {
    await ensureManagedRootSafe(target);
    symlinkSync(target, link, "dir");
    await assert.rejects(() => ensureManagedRootSafe(link), /root is a symlink/);
  } finally {
    cleanup(base);
  }
});

test("writeManagedSkill rejects symlinked skill directories", async () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    symlinkSync(outside, join(root, "demo"), "dir");
    await assert.rejects(() => writeManagedSkill({ action: "create", name: "demo", description: "d", body: "body", root }), /symlink/);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test("writeManagedSkill rejects hard-linked files on update", async () => {
  const root = tempRoot();
  try {
    const created = await writeManagedSkill({ action: "create", name: "demo", description: "d", body: "body", root });
    const linked = join(root, "linked.md");
    try {
      linkSync(created.path, linked);
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return;
      throw err;
    }
    await assert.rejects(() => writeManagedSkill({ action: "update", name: "demo", description: "d", body: "next", root }), /hard links/);
  } finally {
    cleanup(root);
  }
});

test("redactSecrets and sanitizeLearnText protect memory content", () => {
  assert.equal(redactSecrets("token=supersecretvalue"), "[REDACTED]");
  assert.equal(sanitizeLearnText("  keep\nthis\tlesson  "), "keep this lesson");
  assert.throws(() => sanitizeLearnText("", 10), /empty/);
  assert.throws(() => sanitizeLearnText("too long", 3), /limit is 3/);
});

test("computeHindsightScope matches supported scoping modes", () => {
  const key = projectKey("/tmp/example");
  assert.equal(projectKey("/tmp/example"), key);
  assert.deepEqual(computeHindsightScope({ bankId: "coding-agent", scoping: "global" }, "/tmp/example"), { bankId: "coding-agent" });
  assert.deepEqual(computeHindsightScope({ bankId: "coding-agent", scoping: "per-project" }, "/tmp/example"), { bankId: `coding-agent-${key}` });
  assert.deepEqual(computeHindsightScope({ bankId: "coding-agent", scoping: "per-project-tagged" }, "/tmp/example"), { bankId: "coding-agent", tags: [`project:${key}`], tagsMatch: "any" });
});

test("retainHindsightLesson posts redacted lesson to Hindsight", async () => {
  let capturedUrl = "";
  let capturedBody: any;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response("{}", { status: 200 });
  };

  const retained = await retainHindsightLesson({
    cwd: "/tmp/example",
    memory: "API_KEY=supersecretvalue and durable lesson",
    context: "Bearer abcdefghijklmnop",
    config: {
      apiUrl: "http://127.0.0.1:9999",
      bankId: "coding-agent",
      scoping: "per-project-tagged",
      requestTimeoutMs: 1000,
    },
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(capturedUrl, "http://127.0.0.1:9999/v1/default/banks/coding-agent/memories");
  assert.equal(retained.bankId, "coding-agent");
  assert.deepEqual(retained.tags, capturedBody.items[0].tags);
  assert.equal(capturedBody.items[0].content, "[REDACTED] and durable lesson");
  assert.equal(capturedBody.items[0].context, "[REDACTED]");
  assert.equal(capturedBody.items[0].metadata.source, "managed-skills-learn");
  assert.equal(capturedBody.async, true);
});

