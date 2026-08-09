import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(root, name), "utf8");
}

function frontmatter(name: string): string {
  const content = read(`${name}.md`);
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${name} must have YAML frontmatter`);
  return match[1];
}

const roles = ["researcher", "code-mapper", "builder", "reviewer"] as const;

test("ships the four trusted global agent templates", () => {
  for (const role of roles) {
    assert.match(read(`${role}.md`), /Deliverable:/, `${role} needs an explicit result contract`);
  }
});

test("uses short Sundanese legend identities without changing role ids", () => {
  const identities = {
    researcher: "Ciung",
    "code-mapper": "Laya",
    builder: "Sangkur",
    reviewer: "Prabu",
  } as const;

  for (const [role, displayName] of Object.entries(identities)) {
    assert.match(frontmatter(role), new RegExp(`^display_name: ${displayName}$`, "m"));
  }
});

test("read-only specialists cannot write and have bounded turns", () => {
  for (const role of ["researcher", "code-mapper", "reviewer"] as const) {
    const fm = frontmatter(role);
    assert.doesNotMatch(fm, /^tools:.*\b(write|edit)\b/m);
    assert.match(fm, /^max_turns: (?:1[0-9]|2[0-5])$/m);
    assert.match(fm, /^output_transcript: false$/m);
  }
});

test("researcher gets only the 9router web tools and research skill", () => {
  const content = read("researcher.md");
  const fm = frontmatter("researcher");
  assert.match(fm, /^extensions: \[pi-9router-ext\]$/m);
  assert.match(fm, /ext:pi-9router-ext\/ninerouter_web_search/);
  assert.match(fm, /ext:pi-9router-ext\/ninerouter_web_fetch/);
  assert.match(fm, /^skills: 9router-web-researcher$/m);
  assert.match(content, /never include local file contents, secrets, personal data, or proprietary identifiers in web requests/i);
});

test("code mapper preloads teaching and diagram skills without shell access", () => {
  const fm = frontmatter("code-mapper");
  assert.match(fm, /^tools: read, grep, find, ls$/m);
  assert.match(fm, /^extensions: false$/m);
  assert.match(fm, /^skills: mermaid, teach$/m);
});

test("builder is an inherited-context worktree agent with narrow local editing authority", () => {
  const content = read("builder.md");
  const fm = frontmatter("builder");
  assert.match(fm, /^tools: read, grep, find, ls, edit, write$/m);
  assert.match(fm, /^extensions: false$/m);
  assert.match(fm, /^prompt_mode: append$/m);
  assert.match(fm, /^isolation: worktree$/m);
  assert.match(fm, /^skills: code-review$/m);
  assert.match(fm, /^run_in_background: true$/m);
  assert.match(fm, /^disallowed_tools: Agent, get_subagent_result, steer_subagent$/m);
  assert.match(content, /cannot execute tests/i);
  assert.match(content, /parent agent must run real verification/i);
});

test("reviewer has no shell, mutation, or extension authority", () => {
  const content = read("reviewer.md");
  const fm = frontmatter("reviewer");
  assert.match(fm, /^tools: read, grep, find, ls$/m);
  assert.match(fm, /^extensions: false$/m);
  assert.doesNotMatch(fm, /\bbash\b/);
  assert.match(content, /diff and verification evidence supplied by the parent/i);
  assert.match(content, /parent agent owns command execution/i);
});

test("global defaults favor bounded parallelism and private transcripts", () => {
  const settings = JSON.parse(read("subagents.json"));
  assert.deepEqual(settings, {
    maxConcurrent: 3,
    defaultMaxTurns: 40,
    graceTurns: 5,
    defaultJoinMode: "smart",
    scopeModels: true,
    toolDescriptionMode: "compact",
    fleetView: true,
    widgetMode: "background",
    outputTranscript: false,
  });
});
