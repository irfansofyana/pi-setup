import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  normalizeManagedSkillsConfig,
  readManagedSkillsConfig,
  writeManagedSkillsConfig,
} from "./config.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "managed-skills-config-"));
}

test("missing config uses defaults", async (t) => {
  const root = await tempRoot();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  assert.deepEqual(readManagedSkillsConfig(join(root, "missing.json")), { config: DEFAULT_CONFIG });
  assert.deepEqual(DEFAULT_CONFIG, {
    enabled: true,
    learnEnabled: false,
    autoCapture: true,
    autoContinue: false,
    minToolCalls: 8,
    maxSkillBytes: 64_000,
    maxMemoryChars: 12_000,
  });
});

test("invalid existing config fails closed with a diagnostic", async (t) => {
  const root = await tempRoot();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const path = join(root, "config.json");
  await writeFile(path, "{not-json");

  const result = readManagedSkillsConfig(path);

  assert.equal(result.config.enabled, false);
  assert.equal(result.config.learnEnabled, false);
  assert.equal(result.config.autoCapture, false);
  assert.equal(result.config.autoContinue, false);
  assert.match(result.diagnostic ?? "", /Invalid managed-skills config/);
});

test("wrong-typed and unknown config fields fail closed", async (t) => {
  const root = await tempRoot();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  for (const [name, value] of [
    ["wrong-type", { enabled: "false" }],
    ["unknown-key", { enabled: false, surprise: true }],
    ["invalid-range", { minToolCalls: -1 }],
    ["fractional-skill-limit", { maxSkillBytes: 0.5 }],
    ["fractional-memory-limit", { maxMemoryChars: 2.9 }],
    ["fractional-tool-limit", { minToolCalls: 2.9 }],
  ] as const) {
    const path = join(root, `${name}.json`);
    await writeFile(path, JSON.stringify(value));
    const result = readManagedSkillsConfig(path);
    assert.equal(result.config.enabled, false);
    assert.match(result.diagnostic ?? "", /Invalid managed-skills config/);
  }
});

test("config writes replace symlinks without overwriting their targets", async (t) => {
  const root = await tempRoot();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const target = join(root, "target.json");
  const path = join(root, "config.json");
  await writeFile(target, "keep");
  await symlink(target, path);

  await writeManagedSkillsConfig({ ...DEFAULT_CONFIG, autoCapture: true }, path);

  assert.equal(await readFile(target, "utf8"), "keep");
  assert.equal(JSON.parse(await readFile(path, "utf8")).autoCapture, true);
  assert.equal(readManagedSkillsConfig(path).diagnostic, undefined);
});

test("config normalization keeps defaults and clamps numeric values", () => {
  assert.deepEqual(normalizeManagedSkillsConfig({}), DEFAULT_CONFIG);
  assert.equal(normalizeManagedSkillsConfig({ minToolCalls: 2.9 }).minToolCalls, DEFAULT_CONFIG.minToolCalls);
  assert.equal(normalizeManagedSkillsConfig({ maxSkillBytes: -1 }).maxSkillBytes, DEFAULT_CONFIG.maxSkillBytes);
  assert.equal(normalizeManagedSkillsConfig({ maxSkillBytes: 0.5 }).maxSkillBytes, DEFAULT_CONFIG.maxSkillBytes);
  assert.equal(normalizeManagedSkillsConfig({ maxMemoryChars: 2.9 }).maxMemoryChars, DEFAULT_CONFIG.maxMemoryChars);
  assert.equal(normalizeManagedSkillsConfig({ maxSkillBytes: 1 }).maxSkillBytes, 1);
});
