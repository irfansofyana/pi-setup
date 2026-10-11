import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const roles = ["builder", "researcher", "reviewer", "scout"];

test("bundled role colors match reviewed personal defaults", () => {
  for (const [role, color] of Object.entries({ researcher: "syntaxVariable", scout: "success", builder: "mdCodeBlockBorder", reviewer: "mdLink" })) {
    assert.match(read(role), new RegExp(`^color: ${color}$`, "m"));
  }
});
const read = (role: string) => readFileSync(new URL(`./agents/${role}.md`, import.meta.url), "utf8");
const tools = (role: string) => {
  const match = read(role).match(/\n  allow: \[([^\]]+)\]/);
  assert.ok(match, `${role} needs an explicit tool allowlist`);
  return match[1].split(",").map(tool => tool.trim());
};

test("only four model-neutral native roles ship; no global deployment is required", () => {
  assert.deepEqual(readdirSync(new URL("./agents/", import.meta.url)).sort(), roles.map(role => `${role}.md`));
  for (const role of roles) {
    const source = read(role);
    assert.match(source, new RegExp(`^name: ${role}$`, "m"));
    assert.doesNotMatch(source, /^models?:/m);
    assert.match(source, /Return /);
  }
});

test("researcher has only public web tools and a sanitized evidence handoff", () => {
  assert.deepEqual(tools("researcher"), ["web_search", "web_fetch"]);
  const source = read("researcher");
  assert.match(source, /sanitized questions, public identifiers and public URLs/);
  assert.match(source, /Never send\s+local file contents, credentials, personal data or proprietary identifiers/);
  assert.match(source, /claim\/status\/source\/version ledger/);
});

test("scout and reviewer remain read-only, shell-free and network-free", () => {
  for (const role of ["scout", "reviewer"]) {
    assert.deepEqual(tools(role), ["read", "grep", "find", "ls", "fffind", "ffgrep", "fff-multi-grep"]);
    assert.doesNotMatch(tools(role).join(","), /bash|write|edit|web_search|web_fetch/);
  }
  assert.match(read("scout"), /Do not modify files, run shell commands, execute tests or access the network/);
  assert.match(read("reviewer"), /parent owns shell commands, Git inspection\s+and test execution/i);
});

test("builder requires owned worktree scope and parent-owned verification", () => {
  assert.deepEqual(tools("builder"), ["read", "grep", "find", "ls", "edit", "write", "fffind", "ffgrep", "fff-multi-grep"]);
  const source = read("builder");
  assert.match(source, /owned Git\s+worktree and explicit file scopes/);
  assert.match(source, /no shell, test runner or network/);
  assert.match(source, /Never push, merge, deploy, publish, handle\s+secrets/);
  assert.match(source, /explicit tests-not-run status/);
});

test("native scorecard preserves eight public/synthetic cases across native roles", () => {
  const fixture = JSON.parse(readFileSync(new URL("./evaluation-scorecard.json", import.meta.url), "utf8"));
  assert.equal(fixture.version, 1);
  assert.equal(fixture.cases.length, 8);
  assert.deepEqual(Object.keys(fixture.scoring).sort(), ["actionability", "correctness", "evidence", "scopeDiscipline", "toolEfficiency"]);
  for (const role of roles) assert.equal(fixture.cases.filter((item: { role: string }) => item.role === role).length, 2);
});

test("setup procedure covers safe migration and self-contained task packets", () => {
  const docs = readFileSync(new URL("../../../docs/setup/subagents.md", import.meta.url), "utf8");
  for (const field of ["Goal:", "Decision this result informs:", "Acceptance criteria:", "Relevant scope:", "Known constraints:", "Invariants:", "Evidence already collected:", "Explicit non-goals:", "Required deliverable:", "Effort/turn budget:"]) assert.ok(docs.includes(field), field);
  assert.match(docs, /at most two focused repair rounds/i);
  assert.match(docs, /stop on drift/);
  assert.match(docs, /Legacy `Explore.md` is user-owned/);
  assert.doesNotMatch(docs, /install -m 600|node --test pi\/agents\//);
});
