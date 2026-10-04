import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, "pi/prompts");
const names = [
  "debug", "plan-change", "push-changes", "research", "research-fit",
  "research-gap", "review-change",
];

async function read(name) {
  return readFile(path.join(directory, `${name}.md`), "utf8");
}

function parse(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
  assert.ok(match, "template must have frontmatter and a body");
  return { frontmatter: match[1], body: match[2] };
}

test("ships exactly seven discoverable, parameterized prompt commands", async () => {
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

test("delegating prompts retain trusted global role and bounded context boundaries", async () => {
  for (const name of names.filter((name) => name !== "push-changes")) {
    const { body } = parse(await read(name));
    assert.match(body, /trusted global/);
    assert.match(body, /do not substitute[\s\S]*project agents/i);
    assert.match(body, /untrusted repositories/);
    assert.match(body, /inherit_context: false/);
    assert.match(body, /max_turns: (?:15|20)/);
    assert.match(body, /output_transcript: false[\s\S]*global role/);
    assert.match(body, /not as an Agent argument|do not pass it as an Agent argument/);
    assert.doesNotMatch(body, /max_turns: \d+,\s*(?:and\s+)?output_transcript:/);
    assert.doesNotMatch(body, /^model:/m);
  }
});

test("research commands use focused parallel lanes and source evidence without editing", async () => {
  for (const name of ["research", "research-fit", "research-gap"]) {
    const { body } = parse(await read(name));
    assert.match(body, /parallel batch/);
    assert.match(body, /run_in_background: true/);
    assert.match(body, /self-contained/);
    assert.match(body, /sanitized\s+public/);
    assert.match(body, /private URLs[\s\S]*local file\s+contents[\s\S]*credentials/);
    assert.match(body, /my-web-search/);
    assert.match(body, /evidence gate/);
    assert.match(body, /[Dd]o not edit files/);
    assert.match(body, /stopped[\s\S]*incomplete/i);
  }
  assert.match(await read("research"), /2–3 non-overlapping lanes/);
  assert.match(await read("research-fit"), /repository evidence with Laya/);
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
  assert.match(review, /two trusted global reviewer \(Prabu\) instances/);
  assert.match(review, /Standards lane/);
  assert.match(review, /Spec lane/);
  assert.match(review, /Reviewers cannot execute shell commands or tests/);
  assert.match(review, /read-only and[\s\S]*network-free/);
  assert.match(review, /actual diff, affected-file context/);
  assert.match(review, /do not start an automatic repair loop/);
  assert.match(review, /never claim proof of no bugs/);
});

test("push defaults to scoped commit/push with explicit optional PR/MR provider selection", async () => {
  const push = await read("push-changes");
  assert.match(push, /Create a pull request \(PR\) or merge request \(MR\) only when explicitly requested/);
  assert.match(push, /parent owns every Git and host CLI action/);
  assert.match(push, /GitHub: use gh/);
  assert.match(push, /GitLab: use glab/);
  assert.match(push, /hosting service from the selected[\s\S]*repository\/remote/);
  assert.match(push, /self-hosted or unclear providers, ask/);
  assert.match(push, /source repository\/branch and target repository\/branch match/);
  assert.match(push, /--head\/--base/);
  assert.match(push, /--source-branch\/--target-branch/);
  assert.match(push, /Avoid auto-push flags such as glab --fill or --push/);
});

test("push preserves unrelated work and stops on verification or Git failures", async () => {
  const push = await read("push-changes");
  assert.match(push, /Review every outgoing commit and its diff/);
  assert.match(push, /outgoing history includes unrelated work, ask/);
  assert.match(push, /Stop on failures/);
  assert.match(push, /required checks cannot run[\s\S]*explicit approval/);
  assert.match(push, /Stage only explicit approved paths or hunks/);
  assert.match(push, /Preserve unrelated working-tree and staged changes/);
  assert.match(push, /out-of-scope changes, stop and ask/);
  assert.match(push, /detached HEAD or a default\/protected branch/);
  assert.match(push, /do not use --no-verify or amend existing commits/);
  assert.match(push, /Never force-push, rewrite history, rebase, reset, clean/);
  assert.match(push, /no package publishing, releases, tags, deployment, merge/);
  assert.match(push, /remote branch resolves to the pushed local commit/);
  assert.match(push, /never undo a successful push automatically/);
});

test("operations documents all commands and native ownership without manual copying", async () => {
  const operations = await readFile(path.join(root, "docs/setup/operations.md"), "utf8");
  for (const name of names) assert.ok(operations.includes(`/${name}`));
  assert.match(operations, /do not copy them into `~\/\.pi\/agent\/prompts\/`/);
  assert.match(operations, /package prompts do not deploy agents/);
  assert.match(operations, /No PR\/MR unless explicitly requested/);
  assert.match(operations, /Adding the templates does not itself commit or push/);
});
