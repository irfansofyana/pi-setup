import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, "pi/prompts");
const names = [
  "debug",
  "plan-change",
  "push-changes",
  "research",
  "research-fit",
  "research-gap",
  "review-change",
  "understand",
];

async function read(name) {
  return readFile(path.join(directory, `${name}.md`), "utf8");
}

function parse(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
  assert.ok(match, "template must have frontmatter and a body");
  return { frontmatter: match[1], body: match[2] };
}

test("ships discoverable, parameterized prompt commands", async () => {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md")).sort();
  assert.deepEqual(files, names.map((name) => `${name}.md`).sort());
  const descriptions = new Set();
  for (const name of names) {
    const { frontmatter, body } = parse(await read(name));
    const description = frontmatter.match(/^description: (.+)$/m)?.[1];
    assert.ok(description?.trim(), `${name} needs a command description`);
    assert.match(frontmatter, /^argument-hint: "[^"\n]+"$/m);
    assert.equal((body.match(/\$ARGUMENTS/g) ?? []).length, 1);
    assert.doesNotMatch(body, /\$\{|\$[1-9@]/, `${name} must not accidentally interpolate shell examples`);
    descriptions.add(description);
  }
  assert.equal(descriptions.size, names.length);
});

test("native Pi loader discovers commands and expands quoted or empty arguments", async () => {
  // Pi 0.84.1 does not expose its prompt loader through the package root API.
  const entrypoint = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const loaderPath = path.join(path.dirname(entrypoint), "core/prompt-templates.js");
  const { loadPromptTemplates, expandPromptTemplate } = await import(pathToFileURL(loaderPath).href);
  const loaded = loadPromptTemplates({
    cwd: root,
    agentDir: path.join(root, ".unused-agent-dir"),
    promptPaths: [directory],
    includeDefaults: false,
  });
  // Older Pi returns an array; current Pi also reports resource diagnostics.
  const templates = Array.isArray(loaded) ? loaded : loaded.templates;
  if (!Array.isArray(loaded)) assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(templates.map((template) => template.name).sort(), names);
  for (const template of templates) {
    assert.ok(template.description);
    const expanded = expandPromptTemplate(`/${template.name} "quoted multiword scope"`, templates);
    assert.ok(expanded.includes("quoted multiword scope"));
    assert.ok(!expanded.includes("$ARGUMENTS"));
    assert.ok(!expandPromptTemplate(`/${template.name}`, templates).includes("$ARGUMENTS"));
  }
});

test("delegating prompts use native bundled roles and bounded context boundaries", async () => {
  for (const name of names.filter((name) => name !== "push-changes")) {
    const { body } = parse(await read(name));
    assert.match(body, /package-owned native/);
    assert.match(body, /do not substitute[\s\S]*project agents/i);
    assert.match(body, /untrusted repositories/);
    assert.match(body, /agent_spawn with wait: false/);
    assert.match(body, /maxTurns: (?:15|20)/);
    assert.match(body, /fresh context and no persisted\s+child\s+transcripts/);
    assert.doesNotMatch(body, /Ciung|Laya|Prabu|trusted global|inherit_context:|output_transcript:|max_turns:/);
    assert.doesNotMatch(body, /^model:/m);
  }
});

test("research commands use focused parallel lanes and source evidence without editing", async () => {
  for (const name of ["research", "research-fit", "research-gap"]) {
    const { body } = parse(await read(name));
    assert.match(body, /parallel batch/);
    assert.match(body, /wait: false/);
    assert.match(body, /self-contained/);
    assert.match(body, /sanitized\s+public/);
    assert.match(body, /private URLs[\s\S]*local file\s+contents[\s\S]*credentials/);
    assert.match(body, /my-web-search/);
    assert.match(body, /evidence gate/);
    assert.match(body, /[Dd]o not edit files/);
    assert.match(body, /stopped[\s\S]*incomplete/i);
  }
  assert.match(await read("research"), /2–3 non-overlapping lanes/);
  assert.match(await read("research-fit"), /repository evidence with scout/);
  assert.match(await read("research-gap"), /at most three concurrent agents/);
  assert.match(await read("research-gap"), /Missing documentation is not proof/);
});

test("planning stops at approval and debugging stays diagnosis-first", async () => {
  const plan = await read("plan-change");
  assert.match(plan, /Planning only/);
  assert.match(plan, /files that must not change/);
  assert.match(plan, /wait for implementation approval/);
  const debug = await read("debug");
  assert.match(debug, /Diagnosis only unless the user explicitly requests a fix/);
  assert.match(debug, /do not install anything implicitly/);
  assert.match(debug, /safe local reproduction/);
  assert.match(debug, /Parent|parent/);
  assert.match(debug, /passed, failed, or not run/);
  assert.match(debug, /Never commit or push/);
});

test("review separates standards/spec lanes without giving reviewers shell authority", async () => {
  const review = await read("review-change");
  assert.match(review, /two package-owned native reviewer instances/);
  assert.match(review, /Standards lane/);
  assert.match(review, /Spec lane/);
  assert.match(review, /Reviewers cannot execute shell commands or tests/);
  assert.match(review, /read-only and[\s\S]*network-free/);
  assert.match(review, /actual diff, affected-file context/);
  assert.match(review, /do not start an automatic repair loop/);
  assert.match(review, /never claim proof of no bugs/);
});

test("understand uses bounded read-only scouts and synthesizes a focused answer", async () => {
  const { body } = parse(await read("understand"));
  assert.ok(body.trim().split(/\s+/).length <= 240, "keep code understanding lightweight");
  for (const pattern of [
    /topic.*missing.*ambiguous/, /one scout.*narrow/,
    /2–3 non-overlapping/, /independent lanes together/,
    /wait: false/, /self-contained/, /read-only and network-free/,
    /Do not invoke .*skill:understand/, /No file changes, graph artifacts/,
    /file:line/, /owning tests/, /observed behavior from inference/,
    /synthesize rather than concatenate/, /stopped[\s\S]*incomplete/,
  ]) assert.match(body, pattern);
  const skills = await readFile(path.join(root, "docs/setup/skills-and-tools.md"), "utf8");
  assert.match(skills, /\/skill:understand/);
  assert.match(skills, /package-owned .\/understand/);
});

test("push defaults to commit/push and a matching PR/MR with a push-only override", async () => {
  const push = await read("push-changes");
  assert.match(push, /Default: commit, push, create or reuse a PR\/MR/);
  assert.match(push, /"push only" skips PR\/MR/);
  assert.match(push, /current feature branch and existing upstream/);
  assert.match(push, /Proceed without another confirmation/);
  assert.match(push, /host from remote: GitHub .gh., GitLab .glab./);
  assert.match(push, /exact repo\/head\/base/);
  assert.match(push, /matching open PR\/MR/);
  assert.match(push, /already-pushed branch/);
  assert.match(push, /No duplicate requests or edits to existing metadata/);
  assert.match(push, /no automatic installs, login or forks/);
});

test("push stays short and reuses verification instead of adding ceremony", async () => {
  const { body } = parse(await read("push-changes"));
  assert.ok(body.trim().split(/\s+/).length <= 300, "keep push fast path within 300 words");
  assert.match(body, /Reuse fresh checks for unchanged content/);
  assert.match(body, /smallest required checks/);
  assert.match(body, /No optional full suites or CI waiting unless requested/);
  assert.match(body, /Ask only for unsafe or genuinely ambiguous/);
});

test("push preserves scoped work, required checks and non-destructive Git boundaries", async () => {
  const push = await read("push-changes");
  for (const pattern of [
    /including outgoing commits/, /secrets and artifacts/,
    /explicit paths\/hunks/, /preserve unrelated work/,
    /index or outgoing history includes unrelated changes/,
    /detached\/default\/protected/, /Stop on failures/,
    /ask before skipping required checks/, /honor hooks/,
    /explicit remote\/branch ref/, /verify remote SHA/,
    /Stop on divergence, drift or rejected push/,
    /Parent owns mutations; no delegation/,
    /No force-push, history rewrites, hook bypass/,
    /tags, releases, publishing, deployment or merge/,
  ]) assert.match(push, pattern);
});

test("operations documents all commands and native ownership without manual copying", async () => {
  const operations = await readFile(path.join(root, "docs/setup/operations.md"), "utf8");
  for (const name of names) assert.ok(operations.includes(`/${name}`));
  assert.match(operations, /do not copy them into `~\/\.pi\/agent\/prompts\/`/);
  assert.match(operations, /package prompts do not deploy agents/);
  assert.match(operations, /PR\/MR by default; .*push only/);
  assert.match(operations, /Adding the templates does not itself commit or push/);
});
