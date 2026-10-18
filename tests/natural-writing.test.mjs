import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { DEFAULT_CONFIG, LEVELS, promptTriggerDecision } from "../pi/extensions/caveman/index.ts";

const root = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(root, "pi/skills/natural-writing");
const read = file => readFile(path.join(skillRoot, file), "utf8");
async function skill() {
  const source = await read("SKILL.md");
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
  assert.ok(match, "skill needs frontmatter and instructions");
  return { source, metadata: parse(match[1]), body: match[2] };
}

test("natural-writing is model-discoverable through existing package skill resources", async () => {
  const { metadata } = await skill();
  assert.equal(metadata.name, "natural-writing");
  assert.notEqual(metadata["disable-model-invocation"], true);
  assert.ok(metadata.description.split(/\s+/).length <= 35, "keep discovery focused on triggers");
  assert.doesNotMatch(metadata.description, /Preserve facts|Caveman/);
  for (const term of ["drafting", "revising", "humanize", "code-only", "exact-output"]) assert.ok(metadata.description.includes(term));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.skills, ["./pi/skills"]);
  assert.ok(manifest.files.includes("pi/skills"));
});

test("writing policy preserves facts, literals and existing style without verbose audits", async () => {
  const { body } = await skill();
  assert.ok(body.trim().split(/\s+/).length <= 320, "keep writing policy small");
  for (const pattern of [
    /numbers, units, negation, uncertainty, attribution/, /Do not invent/,
    /em dashes in generated prose/, /verbatim quoted text byte-for-byte/,
    /Caveman owns compression/, /fragments, shorthand and length/,
    /Never toggle Caveman/, /full clarity for safety warnings/,
    /Return only/, /not grammar bans/, /code-only tasks, exact-output requests/,
    /Keep qualifiers[\s\S]*evidence or confidence[\s\S]*even under compression/,
    /compare every material claim and protected literal against the source/,
    /correct changed certainty, unsupported additions and altered literals/,
    /When modifying or evaluating this skill, read/,
  ]) assert.match(body, pattern);
  assert.doesNotMatch(body, /\u2014/);
});

test("explicit skill expansion never trips Caveman's real phrase-trigger logic", async () => {
  const { source } = await skill();
  for (const level of LEVELS) {
    const config = { ...DEFAULT_CONFIG, defaultLevel: level, triggerLevel: level === "off" ? "full" : level };
    assert.equal(promptTriggerDecision("be brief", config), config.triggerLevel, "positive control");
    assert.equal(promptTriggerDecision("normal mode", config), "off", "negative control");
    assert.equal(promptTriggerDecision(source, config), undefined, `skill text must not change ${level}`);
    assert.equal(promptTriggerDecision(`/skill:natural-writing\n${source}\nRewrite this PR description.`, config), undefined);
  }
});

test("prose routing is documented without claiming global activation or guaranteed selection", async () => {
  const instructions = await readFile(path.join(root, "AGENTS.md"), "utf8");
  const docs = await readFile(path.join(root, "docs/setup/skills-and-tools.md"), "utf8");
  assert.match(instructions, /pi\/skills\/natural-writing\/SKILL\.md/);
  assert.match(docs, /\/skill:natural-writing/);
  assert.match(docs, /best-effort/);
  assert.match(docs, /global.*AGENTS\.md.*separate approval/);
  assert.match(docs, /No global settings or Caveman preferences/);
});

test("original skill discloses provenance and separates authored cases from executed evaluations", async () => {
  const { body } = await skill();
  assert.match(body, /references\/sources\.md/);
  await access(path.join(skillRoot, "references/sources.md"));
  const sources = await read("references/sources.md");
  for (const term of ["Original", "blader/humanizer", "hardikpandya/stop-slop", "obra/the-elements-of-style", "not copied", "not run"]) assert.ok(sources.includes(term));
  const corpus = JSON.parse(await read("evals/evals.json"));
  assert.equal(corpus.skill_name, "natural-writing");
  assert.equal(corpus.status, "not_run");
  assert.ok(corpus.evals.length >= 10);
  assert.equal(new Set(corpus.evals.map(item => item.id)).size, corpus.evals.length);
  for (const level of LEVELS) assert.ok(corpus.evals.some(item => item.active_caveman === level));
  for (const level of LEVELS.filter(level => level !== "off")) {
    assert.ok(corpus.evals.some(item => item.active_caveman === level && item.category === "uncertainty"));
  }
  for (const category of ["facts", "literals", "punctuation", "voice", "safety", "trigger-negative"]) assert.ok(corpus.evals.some(item => item.category === category));
  for (const item of corpus.evals) {
    assert.ok(Number.isInteger(item.id));
    assert.ok(item.prompt.length > 20 && item.expected_output.length > 20);
    assert.ok(item.expectations.length >= 2);
  }
});
