import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));
const setupRoot = join(root, "../../docs/setup");

function read(name: string): string {
  return readFileSync(join(root, name), "utf8");
}

function readSetup(name: string): string {
  return readFileSync(join(setupRoot, name), "utf8");
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

test("all specialists use fresh context and portable runtime model selection", () => {
  for (const role of roles) {
    const fm = frontmatter(role);
    assert.match(fm, /^inherit_context: false$/m);
    assert.doesNotMatch(fm, /^model:/m);
  }
});

test("researcher gets only the 9router web tools and research skill", () => {
  const content = read("researcher.md");
  const fm = frontmatter("researcher");
  assert.match(fm, /^extensions: \[pi-9router-ext\]$/m);
  assert.match(
    fm,
    /^tools: "ext:pi-9router-ext\/ninerouter_web_search, ext:pi-9router-ext\/ninerouter_web_fetch"$/m,
  );
  assert.doesNotMatch(fm, /\b(read|grep|find|ls|edit|write|bash)\b/);
  assert.match(fm, /ext:pi-9router-ext\/ninerouter_web_search/);
  assert.match(fm, /ext:pi-9router-ext\/ninerouter_web_fetch/);
  assert.match(fm, /^skills: 9router-web-researcher$/m);
  assert.match(content, /sanitized questions, public identifiers, and public URLs/i);
  assert.match(content, /stop when every material claim/i);
  assert.match(content, /claim \| status \| primary source \| version\/date \| conflicts/i);
  assert.match(content, /never include local file contents, secrets, personal data, or proprietary identifiers in web requests/i);
});

test("code mapper preloads teaching and diagram skills without shell access", () => {
  const content = read("code-mapper.md");
  const fm = frontmatter("code-mapper");
  assert.match(fm, /^tools: read, grep, find, ls$/m);
  assert.match(fm, /^extensions: false$/m);
  assert.match(fm, /^skills: mermaid, teach$/m);
  assert.match(content, /entry point/i);
  assert.match(content, /call\/data path/i);
  assert.match(content, /state mutation/i);
  assert.match(content, /files that must change/i);
  assert.match(content, /files that must not change/i);
  assert.match(content, /Mermaid only when it clarifies/i);
});

test("builder is a fresh-context worktree agent with narrow local editing authority", () => {
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
  assert.match(content, /execution is pending/i);
  assert.match(content, /smallest assigned vertical slice/i);
  assert.match(content, /exact parent verification evidence/i);
  assert.match(content, /parent agent must run real verification/i);
});

test("reviewer has no shell, mutation, or extension authority", () => {
  const content = read("reviewer.md");
  const fm = frontmatter("reviewer");
  assert.match(fm, /^tools: read, grep, find, ls$/m);
  assert.match(fm, /^extensions: false$/m);
  assert.doesNotMatch(fm, /\bbash\b/);
  assert.match(content, /diff and verification evidence supplied by the parent/i);
  assert.match(content, /search for counterevidence/i);
  assert.match(content, /violated invariant/i);
  assert.match(content, /smallest fix/i);
  assert.match(content, /no material findings/i);
  assert.match(content, /parent agent owns command execution/i);
});

test("documents self-contained task packets and parent-owned completion gates", () => {
  const docs = readSetup("subagents.md");
  for (const field of [
    "Goal:",
    "Decision this result informs:",
    "Acceptance criteria:",
    "Relevant scope:",
    "Known constraints:",
    "Invariants:",
    "Evidence already collected:",
    "Explicit non-goals:",
    "Required deliverable:",
    "Effort/turn budget:",
  ]) {
    assert.match(docs, new RegExp(field));
  }
  assert.match(docs, /actual diff/i);
  assert.match(docs, /affected-file context/i);
  assert.match(docs, /exact command output/i);
  assert.match(docs, /steered[^\n]*aborted[^\n]*stopped[^\n]*incomplete/i);
  assert.match(docs, /at most two focused repair rounds/i);
});

test("documents native model selection, precedence, and scope caveats", () => {
  const docs = readSetup("subagents.md");
  assert.match(docs, /frontmatter model[^\n>]*>[^\n]*invocation model[^\n>]*>[^\n]*parent model/i);
  assert.match(docs, /Agent\(\{[\s\S]*subagent_type:[^\n]*builder[\s\S]*model:[^\n]*<provider>\/<model-id>/i);
  assert.match(docs, /exact `provider\/model-id`/i);
  assert.match(docs, /\/scoped-models/);
  assert.match(docs, /runtime-selected out-of-scope model[^\n]*hard error/i);
  assert.match(docs, /frontmatter-pinned out-of-scope model[^\n]*warning[^\n]*runs/i);
  assert.match(docs, /inherited out-of-scope parent model[^\n]*warning[^\n]*runs/i);
  assert.match(docs, /globs[^\n]*bare model IDs[^\n]*`:thinking` suffixes[^\n]*silently dropped/i);
  assert.match(docs, /empty exact allowlist[^\n]*no-op/i);
  assert.match(docs, /absent or empty[^\n]*no-op/i);
});

test("ships a lightweight frozen role scorecard without another runtime", () => {
  const fixture = JSON.parse(read("evaluation-scorecard.json"));
  assert.equal(fixture.version, 1);
  assert.deepEqual(Object.keys(fixture.scoring).sort(), [
    "actionability",
    "correctness",
    "evidence",
    "scopeDiscipline",
    "toolEfficiency",
  ]);
  assert.equal(fixture.cases.length, 8);
  for (const role of roles) {
    assert.equal(fixture.cases.filter((item: { role: string }) => item.role === role).length, 2);
  }
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
