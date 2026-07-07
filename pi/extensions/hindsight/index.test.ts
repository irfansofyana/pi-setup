import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";

import {
  appendMemory,
  clearMemories,
  dedupMemories,
  ensureDirs,
  jaccard,
  loadMemories,
  formatMemoryBlock,
  makeMemoryEntry,
  memoriesPath,
  memoryDocPath,
  memoryGuidanceBlock,
  memorySourceText,
  memorySummaryBlock,
  memorySummaryPath,
  readMemoryUrl,
  skillsDir,
  writeMemoryArtifacts,
  projectBasename,
  projectDir,
  projectKey,
  redactSecrets,
  searchMemories,
} from "./store.ts";
import { buildRuleFromMarkdown, builtinDefaultRules, discoverRules, parseFrontmatter, splitBuckets } from "./rules.ts";
import hindsight, {
  handleHindsightCommand,
  rebuildAutonomousMemory,
  markRuleInjected,
  promptBlocks,
  matchesRule,
  projectRootFrom,
  reminderForRule,
  ruleAllows,
  rulebookPromptBlock,
  ruleMatchesGlobs,
  ruleStateKey,
  shouldInjectRule,
} from "./index.ts";
import type { Rule } from "./types.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "hindsight-"));
}

test("appendMemory + loadMemories roundtrip writes and reads back an entry", () => {
  const root = tempRoot();
  const cwd = "/home/user/projects/demo-app";
  const entry = makeMemoryEntry(cwd, "prefer tabs over spaces", "style", "retain");
  appendMemory(cwd, entry, root);
  assert.equal(existsSync(memoriesPath(cwd, root)), true);
  const loaded = loadMemories(cwd, root);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, entry.id);
  assert.equal(loaded[0].text, "prefer tabs over spaces");
  assert.equal(loaded[0].project, projectBasename(cwd));
  assert.equal(projectBasename(cwd), "demo-app");
  assert.ok(projectKey(cwd).startsWith("demo-app-"));
  assert.equal(projectDir(cwd, root), join(root, projectKey(cwd)));
});

test("loadMemories skips malformed lines and returns [] when absent", () => {
  const root = tempRoot();
  const cwd = "/x/missing-proj";
  assert.deepEqual(loadMemories(cwd, root), []);
});

test("jaccard scores near-duplicate text above threshold", () => {
  assert.equal(jaccard("identical", "identical"), 1);
  assert.ok(jaccard("the quick brown fox jumps", "the quick brown fox jumps over") >= 0.8);
  assert.ok(jaccard("completely different text", "totally unrelated words") < 0.3);
});

test("dedupMemories merges near-duplicate text keeping earliest", () => {
  const root = tempRoot();
  const cwd = "/x/proj";
  const a = makeMemoryEntry(cwd, "always run tests before commit", "flow", "retain");
  const b = makeMemoryEntry(cwd, "always run tests before commit please", "flow", "retain");
  const c = makeMemoryEntry(cwd, "deploy on fridays", "ops", "retain");
  const merged = dedupMemories([a, b, c]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, a.id);
  assert.equal(merged[1].id, c.id);
});

test("clearMemories removes generated memory artifacts", () => {
  const root = tempRoot();
  const cwd = "/x/proj";
  appendMemory(cwd, makeMemoryEntry(cwd, "note", "general", "retain"), root);
  writeMemoryArtifacts(cwd, "# MEMORY\nStale", "Stale summary", root);
  assert.equal(existsSync(memoriesPath(cwd, root)), true);
  assert.equal(existsSync(memoryDocPath(cwd, root)), true);
  assert.equal(existsSync(memorySummaryPath(cwd, root)), true);

  clearMemories(cwd, root);

  assert.equal(existsSync(memoriesPath(cwd, root)), false);
  assert.equal(existsSync(memoryDocPath(cwd, root)), false);
  assert.equal(existsSync(memorySummaryPath(cwd, root)), false);
  assert.equal(memorySummaryBlock(cwd, root), "");
  assert.equal(readMemoryUrl(cwd, "memory://root/MEMORY.md", root), "not found: memory://root/MEMORY.md");
});

test("parseFrontmatter parses mdc with alwaysApply, globs, condition", () => {
  const raw = [
    "---",
    "description: no console in source",
    "alwaysApply: true",
    "globs:",
    "  - \"*.ts\"",
    "condition:",
    "  - no-console",
    "---",
    "",
    "Body line one.",
    "Body line two.",
  ].join("\n");
  const { data, body } = parseFrontmatter(raw);
  assert.equal(data.alwaysApply, "true");
  assert.deepEqual(data.globs, ["*.ts"]);
  assert.deepEqual(data.condition, ["no-console"]);
  assert.equal(data.description, "no console in source");
  assert.equal(body, "Body line one.\nBody line two.");
});

test("parseFrontmatter returns raw body when no frontmatter", () => {
  const raw = "just text\nmore text";
  const { data, body } = parseFrontmatter(raw);
  assert.deepEqual(data, {});
  assert.equal(body, raw);
});

test("buildRuleFromMarkdown strips frontmatter and maps condition from legacy ttsr_trigger", () => {
  const raw = [
    "---",
    "ttsr_trigger: legacy-trigger",
    "alwaysApply: false",
    "---",
    "",
    "Rule body here.",
  ].join("\n");
  const rule = buildRuleFromMarkdown("legacy", "/r/legacy.mdc", raw, "native", 100);
  assert.equal(rule.name, "legacy");
  assert.equal(rule.content, "Rule body here.");
  assert.deepEqual(rule.condition, ["legacy-trigger"]);
  assert.equal(rule.alwaysApply, false);
  assert.equal(rule.provider, "native");
  assert.equal(rule.priority, 100);
});

test("buildRuleFromMarkdown parses repeat gap fields", () => {
  const rule = buildRuleFromMarkdown("gap", "/r/gap.mdc", "---\nrepeat: gap\nrepeatGap: 3\n---\nbody", "native", 100);
  assert.equal(rule.repeat, "gap");
  assert.equal(rule.repeatGap, 3);
});

test("rulebookPromptBlock includes alwaysApply and rulebook, excludes TTSR content", () => {
  const block = rulebookPromptBlock([
    { name: "always", path: "/a", content: "always body", alwaysApply: true, provider: "native", priority: 100 },
    { name: "book", path: "/b", content: "secret full body", description: "book desc", provider: "native", priority: 100 },
    { name: "ttsr", path: "/t", content: "ttsr body", condition: ["danger"], provider: "native", priority: 100 },
  ]);
  assert.ok(block.includes("always body"));
  assert.ok(block.includes("book desc"));
  assert.ok(block.includes("rule://book"));
  assert.ok(!block.includes("secret full body"));
  assert.ok(!block.includes("ttsr body"));
});

test("rulebookPromptBlock honors globs before injection", () => {
  const scoped: Rule = { name: "python", path: "/a", content: "python body", alwaysApply: true, globs: ["*.py"], provider: "native", priority: 100 };
  const recursive: Rule = { name: "recursive", path: "/b", content: "recursive body", alwaysApply: true, globs: ["**/*.py"], provider: "native", priority: 100 };
  const brace: Rule = { name: "brace", path: "/c", content: "brace body", alwaysApply: true, globs: ["src/*.{ts,tsx}", "test?.md"], provider: "native", priority: 100 };
  assert.equal(ruleMatchesGlobs(scoped, ["src/app.py"]), true);
  assert.equal(ruleMatchesGlobs(scoped, ["README.md"]), false);
  assert.equal(ruleMatchesGlobs(recursive, ["app.py"]), true);
  assert.equal(ruleMatchesGlobs(recursive, ["src/app.py"]), true);
  assert.equal(ruleMatchesGlobs(brace, ["src/app.tsx"]), true);
  assert.equal(ruleMatchesGlobs(brace, ["test1.md"]), true);
  assert.equal(rulebookPromptBlock([scoped]), "");
  assert.ok(rulebookPromptBlock([scoped], ["src/app.py"]).includes("python body"));
});

test("matchesRule catches bad regex and matches valid condition", () => {
  assert.equal(matchesRule({ name: "bad", path: "/r", content: "", condition: ["["], provider: "native", priority: 100 }, "x"), false);
  assert.equal(matchesRule({ name: "ok", path: "/r", content: "", condition: ["hello\\s+world"], provider: "native", priority: 100 }, "hello world"), true);
  assert.equal(matchesRule({ name: "ast", path: "/r", content: "", astCondition: ["CallExpression"], provider: "native", priority: 100 }, "CallExpression"), true);
});

test("repeat helpers handle once gap always by attempt number", () => {
  const state = new Map<string, number>();
  const once: Rule = { name: "once", path: "/r/once.mdc", content: "", provider: "native", priority: 100 };
  assert.equal(shouldInjectRule(once, undefined, 1), true);
  markRuleInjected(state, "once-key", 1);
  assert.equal(shouldInjectRule(once, state.get("once-key"), 2), false);

  const always: Rule = { name: "always", path: "/r/always.mdc", content: "", repeat: "always", provider: "native", priority: 100 };
  assert.equal(shouldInjectRule(always, 1, 2), true);

  const gap: Rule = { name: "gap", path: "/r/gap.mdc", content: "", repeat: "gap", repeatGap: 3, provider: "native", priority: 100 };
  assert.equal(shouldInjectRule(gap, undefined, 1), true);
  assert.equal(shouldInjectRule(gap, 1, 2), false);
  assert.equal(shouldInjectRule(gap, 1, 4), true);
});

test("ruleStateKey isolates cwd and path", () => {
  const a: Rule = { name: "same", path: "/r/a.mdc", content: "", provider: "native", priority: 100 };
  const b: Rule = { name: "same", path: "/r/b.mdc", content: "", provider: "native", priority: 100 };
  assert.notEqual(ruleStateKey("/a", a), ruleStateKey("/b", a));
  assert.notEqual(ruleStateKey("/a", a), ruleStateKey("/a", b));
});

test("projectRootFrom prefers event systemPromptOptions cwd", () => {
  assert.equal(projectRootFrom({ systemPromptOptions: { cwd: "/event" } }, { cwd: "/ctx" }), "/event");
  assert.equal(projectRootFrom({}, { cwd: "/ctx" }), "/ctx");
});

test("ruleAllows and reminderForRule are defensive small helpers", () => {
  const rule: Rule = { name: "tool-rule", path: "/r", content: "x".repeat(2000), scope: ["tool"], provider: "native", priority: 100 };
  const bashRule: Rule = { ...rule, scope: ["tool:bash"] };
  assert.equal(ruleAllows(rule, "tool"), true);
  assert.equal(ruleAllows(rule, "prose"), false);
  assert.equal(ruleAllows(bashRule, "tool", "read"), false);
  assert.equal(ruleAllows(bashRule, "tool", "mcp"), false);
  assert.equal(ruleAllows(bashRule, "tool", "bash"), true);
  assert.ok(reminderForRule(rule).startsWith("Hindsight rule matched: tool-rule"));
  assert.ok(reminderForRule(rule).length <= 1201);
});

test("splitBuckets routes rules into ttsr / alwaysApply / rulebook", () => {
  const rules: Rule[] = [
    { name: "ttsr-rule", path: "/r/t.mdc", content: "c", condition: ["x"], provider: "native", priority: 100 },
    { name: "always-rule", path: "/r/a.mdc", content: "c", alwaysApply: true, description: "d", provider: "native", priority: 100 },
    { name: "book-rule", path: "/r/b.mdc", content: "c", description: "d", provider: "native", priority: 100 },
  ];
  const buckets = splitBuckets(rules);
  assert.equal(buckets.ttsr.length, 1);
  assert.equal(buckets.ttsr[0].name, "ttsr-rule");
  assert.equal(buckets.alwaysApply.length, 1);
  assert.equal(buckets.alwaysApply[0].name, "always-rule");
  assert.equal(buckets.rulebook.length, 1);
  assert.equal(buckets.rulebook[0].name, "book-rule");
});

test("splitBuckets dedups by name keeping first encountered", () => {
  const rules: Rule[] = [
    { name: "dup", path: "/r/first.mdc", content: "first", description: "d", provider: "native", priority: 100 },
    { name: "dup", path: "/r/second.mdc", content: "second", description: "d", provider: "native", priority: 100 },
    { name: "other", path: "/r/o.mdc", content: "o", description: "d", provider: "native", priority: 100 },
  ];
  const buckets = splitBuckets(rules);
  const total = buckets.ttsr.length + buckets.alwaysApply.length + buckets.rulebook.length;
  assert.equal(total, 2);
  assert.equal(buckets.rulebook[0].content, "first");
});

test("discoverRules reads native *.md and *.mdc from a temp rules dir", () => {
  const root = tempRoot();
  writeFileSync(join(root, "alpha.md"), "---\ndescription: a\n---\nalpha body");
  writeFileSync(join(root, "beta.mdc"), "---\nalwaysApply: true\n---\nbeta body");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "nested.md"), "nested");
  const rules = discoverRules(tempRoot(), root);
  assert.equal(rules.length, 4);
  assert.ok(rules.some((r) => r.name === "alpha"));
  assert.ok(rules.some((r) => r.name === "beta"));
  assert.ok(rules.some((r) => r.provider === "builtin-defaults"));
  rmSync(root, { recursive: true, force: true });
});

test("discoverRules reads project cursor, windsurf, cline, AGENTS, and RULES", () => {
  const cwd = tempRoot();
  const native = tempRoot();
  mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
  mkdirSync(join(cwd, ".windsurf", "rules"), { recursive: true });
  mkdirSync(join(cwd, ".cline", "rules"), { recursive: true });
  writeFileSync(join(native, "native.md"), "native");
  writeFileSync(join(cwd, ".cursor", "rules", "cursor.mdc"), "cursor");
  writeFileSync(join(cwd, ".windsurf", "rules", "wind.md"), "wind");
  writeFileSync(join(cwd, ".cline", "rules", "cline.md"), "cline");
  writeFileSync(join(cwd, "AGENTS.md"), "agents body");
  writeFileSync(join(cwd, "RULES.md"), "rules body");

  const rules = discoverRules(cwd, native);
  const byName = new Map(rules.map((rule) => [rule.name, rule]));
  assert.equal(byName.get("native")?.provider, "native");
  assert.equal(byName.get("native")?.priority, 100);
  assert.equal(byName.get("cursor")?.provider, "cursor");
  assert.equal(byName.get("cursor")?.priority, 50);
  assert.equal(byName.get("wind")?.provider, "windsurf");
  assert.equal(byName.get("wind")?.priority, 50);
  assert.equal(byName.get("cline")?.provider, "cline");
  assert.equal(byName.get("cline")?.priority, 40);
  assert.equal(byName.get("AGENTS")?.provider, "agents");
  assert.equal(byName.get("AGENTS")?.priority, 70);
  assert.equal(byName.get("AGENTS")?.alwaysApply, true);
  assert.equal(byName.get("RULES")?.provider, "rules");
  assert.equal(byName.get("RULES")?.priority, 100);
  assert.deepEqual(rules.map((rule) => rule.priority), [...rules].map((rule) => rule.priority).sort((a, b) => b - a));
  rmSync(cwd, { recursive: true, force: true });
  rmSync(native, { recursive: true, force: true });
});

test("discoverRules includes builtin-defaults when project and native dirs absent", () => {
  const rules = discoverRules("/nonexistent/hindsight-rules-xyz", "/nonexistent/hindsight-native-rules-xyz");
  assert.equal(rules.length, 2);
  assert.ok(rules.every((rule) => rule.provider === "builtin-defaults"));
  assert.ok(rules.every((rule) => rule.priority === 1));
});

test("builtinDefaultRules split into alwaysApply and rulebook", () => {
  const rules = builtinDefaultRules();
  const buckets = splitBuckets(rules);
  assert.equal(buckets.alwaysApply.some((rule) => rule.name === "hindsight-secret-safety"), true);
  assert.equal(buckets.rulebook.some((rule) => rule.name === "hindsight-memory-staleness"), true);
});

test("loadMemories skips malformed lines and keeps valid ones", () => {
  const root = tempRoot();
  const cwd = "/x/malformed-proj";
  ensureDirs(cwd, root);
  const valid1 = JSON.stringify(makeMemoryEntry(cwd, "first valid", "general", "retain"));
  const valid2 = JSON.stringify(makeMemoryEntry(cwd, "second valid", "general", "retain"));
  writeFileSync(memoriesPath(cwd, root), `${valid1}\nthis is not json\n${valid2}\n`, "utf8");
  const loaded = loadMemories(cwd, root);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].text, "first valid");
  assert.equal(loaded[1].text, "second valid");
  rmSync(root, { recursive: true, force: true });
});

test("projectBasename guards traversal", () => {
  assert.equal(projectBasename("/foo/../.."), "root");
  assert.equal(projectBasename("/home/user/projects/demo-app"), "demo-app");
});

test("projectDir avoids basename collisions while preserving readable prefix", () => {
  const root = tempRoot();
  const a = projectDir("/work/a/demo", root);
  const b = projectDir("/work/b/demo", root);
  assert.notEqual(a, b);
  assert.ok(a.startsWith(join(root, "demo-")));
  assert.ok(b.startsWith(join(root, "demo-")));
  rmSync(root, { recursive: true, force: true });
});

test("redactSecrets scrubs sk-, bearer, env secrets, and common token prefixes", () => {
  const out = redactSecrets([
    "key is sk-abcdefghijklmnopqrstuvwxyz",
    "project key sk-proj-abcdefghijklmnopqrstuvwxyz_123456789",
    "Authorization: Bearer xyz1234567890",
    "OPENAI_API_KEY=openaisecret12345",
    "GITHUB_TOKEN=githubsecret12345",
    "DATABASE_PASSWORD=dbsecret12345",
    "ghp_abcdefghijklmnopqrstuvwxyz1234",
    "github_pat_abcdefghijklmnopqrstuvwxyz1234",
    "xoxb-1234567890-abcdefghijkl",
    "AKIA1234567890ABCDEF",
  ].join("\n"));
  assert.ok(out.includes("[REDACTED]"));
  for (const secret of ["sk-abcdefghijklmnopqrstuvwxyz", "sk-proj-abcdefghijklmnopqrstuvwxyz_123456789", "xyz1234567890", "openaisecret12345", "githubsecret12345", "dbsecret12345", "ghp_", "github_pat_", "xoxb-", "AKIA1234567890ABCDEF"]) {
    assert.ok(!out.includes(secret));
  }
});

test("searchMemories returns relevant memories and keeps newest duplicate", () => {
  const root = tempRoot();
  const cwd = "/x/search-proj";
  const old = { ...makeMemoryEntry(cwd, "use mocha for tests", "testing", "retain"), createdAt: "2024-01-01T00:00:00.000Z" };
  const staleRelevant = { ...makeMemoryEntry(cwd, "prefer tsx node:test for hindsight", "testing", "retain"), createdAt: "2024-02-01T00:00:00.000Z" };
  const relevant = { ...makeMemoryEntry(cwd, "prefer tsx node:test for hindsight now", "testing", "retain"), createdAt: "2024-02-15T00:00:00.000Z" };
  const newest = { ...makeMemoryEntry(cwd, "deploy notes", "ops", "retain"), createdAt: "2024-03-01T00:00:00.000Z" };
  appendMemory(cwd, old, root);
  appendMemory(cwd, staleRelevant, root);
  appendMemory(cwd, relevant, root);
  appendMemory(cwd, newest, root);

  assert.equal(searchMemories(cwd, "hindsight tests", 1, root)[0].id, relevant.id);
  assert.deepEqual(searchMemories(cwd, "nonexistent-token", 5, root), []);
  assert.deepEqual(searchMemories(cwd, "", 2, root).map((entry) => entry.id), [newest.id, relevant.id]);
  rmSync(root, { recursive: true, force: true });
});

test("formatMemoryBlock uses OMP header and caps output", () => {
  const cwd = "/x/format-proj";
  const entries = Array.from({ length: 10 }, (_, i) => ({
    ...makeMemoryEntry(cwd, `${i} ${"x".repeat(1000)}`, "general", "retain"),
    createdAt: "2024-01-02T03:04:05.000Z",
  }));
  const block = formatMemoryBlock(entries);
  assert.ok(block.startsWith("Relevant memories from past conversations (prioritize recent when conflicting):"));
  assert.ok(block.includes("- [general @ 2024-01-02]"));
  assert.ok(block.length <= 4000);
});

test("memoryGuidanceBlock includes OMP heuristic/stale instructions + project dir", () => {
  const cwd = "/home/user/projects/demo-app";
  const block = memoryGuidanceBlock(cwd);
  assert.ok(block.includes(projectDir(cwd)));
  assert.ok(block.includes(memoriesPath(cwd)));
  assert.ok(block.includes("heuristic context"));
  assert.ok(block.includes("memory artifact path"));
  assert.ok(block.includes("stale"));
});

test("writeMemoryArtifacts redacts files and creates skills dir", () => {
  const root = tempRoot();
  const cwd = "/x/memory-artifacts";
  writeMemoryArtifacts(cwd, "# MEMORY\napi_key=supersecret123", "Bearer abcdefghijk", root);
  assert.equal(existsSync(memoryDocPath(cwd, root)), true);
  assert.equal(existsSync(memorySummaryPath(cwd, root)), true);
  assert.equal(existsSync(skillsDir(cwd, root)), true);
  assert.ok(readFileSync(memoryDocPath(cwd, root), "utf8").includes("[REDACTED]"));
  assert.ok(readFileSync(memorySummaryPath(cwd, root), "utf8").includes("[REDACTED]"));
  rmSync(root, { recursive: true, force: true });
});

test("memorySummaryBlock is empty when absent and injects Memory Guidance when present", () => {
  const root = tempRoot();
  const cwd = "/x/summary-block";
  assert.equal(memorySummaryBlock(cwd, root), "");
  writeMemoryArtifacts(cwd, "# MEMORY", "- Prefer node:test", root);
  const block = memorySummaryBlock(cwd, root);
  assert.ok(block.startsWith("Memory Guidance:"));
  assert.ok(block.includes("- Prefer node:test"));
  assert.ok(block.includes("heuristic/stale"));
  rmSync(root, { recursive: true, force: true });
});

test("promptBlocks gates generic memory guidance and avoids duplicates", () => {
  const root = tempRoot();
  const cwd = "/x/prompt-block";
  const rule: Rule = { name: "always", path: "/r", content: "always body", alwaysApply: true, provider: "native", priority: 100 };
  assert.equal(promptBlocks(cwd, [], false, root), "");
  assert.ok(promptBlocks(cwd, [], true, root).startsWith("Hindsight memory guidance"));
  writeMemoryArtifacts(cwd, "# MEMORY", "- Prefer node:test", root);
  assert.equal(promptBlocks(cwd, [], false, root), "");
  const block = promptBlocks(cwd, [rule], true, root);
  assert.equal((block.match(/Memory Guidance:/g) ?? []).length, 1);
  assert.ok(!block.includes("Hindsight memory guidance"));
  assert.ok(block.includes("always body"));
  rmSync(root, { recursive: true, force: true });
});

test("memorySourceText combines newest deduped memories and caps", () => {
  const root = tempRoot();
  const cwd = "/x/source-text";
  const old = { ...makeMemoryEntry(cwd, "same retained fact", "general", "retain"), createdAt: "2024-01-01T00:00:00.000Z" };
  const newerDup = { ...makeMemoryEntry(cwd, "same retained fact", "general", "retain"), createdAt: "2024-03-01T00:00:00.000Z" };
  const newest = { ...makeMemoryEntry(cwd, "use tsx tests", "testing", "auto-retain"), createdAt: "2024-04-01T00:00:00.000Z" };
  appendMemory(cwd, old, root);
  appendMemory(cwd, newerDup, root);
  appendMemory(cwd, newest, root);
  const text = memorySourceText(cwd, 120, root);
  assert.ok(text.includes("testing @ 2024-04-01 (auto-retain)"));
  assert.ok(text.includes("general @ 2024-03-01 (retain)"));
  assert.ok(!text.includes("2024-01-01"));
  assert.ok(text.length <= 120);
  rmSync(root, { recursive: true, force: true });
});

test("readMemoryUrl browses root and memory artifacts", () => {
  const root = tempRoot();
  const cwd = "/x/url";
  writeMemoryArtifacts(cwd, "# MEMORY\nFact", "Summary", root);
  assert.ok(readMemoryUrl(cwd, "memory://root", root).includes("memory://root/MEMORY.md"));
  assert.equal(readMemoryUrl(cwd, "memory://root/MEMORY.md", root), "# MEMORY\nFact");
  assert.equal(readMemoryUrl(cwd, "memory://root/memory_summary.md", root), "Summary");
  assert.equal(readMemoryUrl(cwd, "memory://root/skills", root), "(empty)");
  rmSync(root, { recursive: true, force: true });
});

test("handleHindsightCommand stats notify mentions memories and rules", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let captured = "";
  const ctx = { cwd, hasUI: true, ui: { notify: (msg: string, _kind: string) => { captured = msg; } } };
  handleHindsightCommand("stats", ctx);
  assert.ok(captured.includes("memories"));
  assert.ok(captured.includes("rules"));
  rmSync(cwd, { recursive: true, force: true });
});

test("handleHindsightCommand diagnose notify mentions project dir and MEMORY.md", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let captured = "";
  const ctx = { cwd, hasUI: true, ui: { notify: (msg: string, _kind: string) => { captured = msg; } } };
  await handleHindsightCommand("diagnose", ctx);
  assert.ok(captured.includes(`project dir: ${cwd}`));
  assert.ok(captured.includes("MEMORY.md"));
  rmSync(cwd, { recursive: true, force: true });
});

test("handleHindsightCommand enqueue invokes callback and no-ops when unavailable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let queued = false;
  let captured = "";
  const ctx = { cwd, hasUI: true, ui: { notify: (msg: string, _kind: string) => { captured = msg; } } };
  await assert.doesNotReject(handleHindsightCommand("enqueue", ctx, { enqueueMemory: () => { queued = true; } }));
  assert.equal(queued, true);
  assert.ok(captured.includes("queued"));
  await assert.doesNotReject(handleHindsightCommand("enqueue", ctx));
  assert.ok(captured.includes("unavailable"));
  rmSync(cwd, { recursive: true, force: true });
});

test("hindsight clear suppresses in-flight memory rebuild artifact writes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-clear-"));
  appendMemory(cwd, makeMemoryEntry(cwd, "durable fact", "general", "retain"));

  const pending = rebuildAutonomousMemory({ cwd });
  await handleHindsightCommand("clear", { cwd, ui: { notify() {} } });
  await pending;

  assert.equal(existsSync(memoryDocPath(cwd)), false);
  assert.equal(existsSync(memorySummaryPath(cwd)), false);
  rmSync(projectDir(cwd), { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("auto-recall requires memory backend opt-in", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-auto-recall-"));
  const commands: Record<string, any> = {};
  const handlers: Record<string, Function> = {};
  appendMemory(cwd, makeMemoryEntry(cwd, "remember this hidden fact", "general", "retain"));
  hindsight({
    registerTool() {},
    registerCommand(name: string, command: any) { commands[name] = command; },
    on(name: string, handler: Function) { handlers[name] = handler; },
  } as any);

  await commands.hindsight.handler("memory disable", { cwd, ui: { notify() {} } });
  assert.equal(await handlers.context({ messages: [{ role: "user", content: "hidden fact" }] }, { cwd }), undefined);
  await commands.hindsight.handler("memory enable", { cwd, ui: { notify() {} } });
  const result = await handlers.context({ messages: [{ role: "user", content: "hidden fact" }] }, { cwd });
  assert.ok(result.messages[0].content.includes("hidden fact"));
  await commands.hindsight.handler("memory disable", { cwd, ui: { notify() {} } });

  rmSync(projectDir(cwd), { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("session shutdown auto-retain requires memory backend opt-in", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-auto-retain-"));
  const commands: Record<string, any> = {};
  const handlers: Record<string, Function> = {};
  hindsight({
    registerTool() {},
    registerCommand(name: string, command: any) { commands[name] = command; },
    on(name: string, handler: Function) { handlers[name] = handler; },
  } as any);

  await commands.hindsight.handler("memory disable", { cwd, ui: { notify() {} } });
  await handlers.session_shutdown({}, {
    cwd,
    sessionManager: { getEntries: () => [{ role: "user", content: "do not retain without opt-in" }] },
  });
  assert.equal(existsSync(memoriesPath(cwd)), false);

  await commands.hindsight.handler("memory enable", { cwd, ui: { notify() {} } });
  await handlers.session_shutdown({}, {
    cwd,
    sessionManager: { getEntries: () => [{ role: "user", content: "retain after opt-in" }] },
  });
  assert.equal(loadMemories(cwd).some((entry) => entry.text.includes("retain after opt-in")), true);
  await commands.hindsight.handler("memory disable", { cwd, ui: { notify() {} } });

  rmSync(projectDir(cwd), { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("hindsight clear drops queued retain entries and skips shutdown auto-retain", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-clear-"));
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const handlers: Record<string, Function> = {};
  hindsight({
    registerTool(tool: any) { tools[tool.name] = tool; },
    registerCommand(name: string, command: any) { commands[name] = command; },
    on(name: string, handler: Function) { handlers[name] = handler; },
  } as any);

  await tools.hindsight_retain.execute("retain", { text: "cleared queued memory", category: "test" }, undefined, undefined, { cwd });
  await commands.hindsight.handler("clear", { cwd, ui: { notify() {} } });
  await handlers.session_shutdown({}, {
    cwd,
    sessionManager: { getEntries: () => [{ role: "user", content: "do not recreate cleared memory" }] },
  });

  assert.equal(existsSync(memoriesPath(cwd)), false);
  rmSync(projectDir(cwd), { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("portable TTSR tool_result prepends first matching rule reminder", async () => {
  const cwd = tempRoot();
  mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(cwd, ".cursor", "rules", "tool-hit.mdc"), "---\ncondition: danger\ninterruptMode: tool-only\nscope: tool\n---\nStop and reconsider.");
  const handlers: Record<string, Function> = {};
  hindsight({
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: Function) { handlers[name] = handler; },
  } as any);

  const result = await handlers.tool_result({ content: [{ type: "text", text: "danger output" }] }, { cwd });
  assert.equal(result.details.hindsightRule, "tool-hit");
  assert.ok(result.content[0].text.includes("Hindsight rule matched: tool-hit"));
  assert.ok(result.content[0].text.includes("danger output"));
  rmSync(cwd, { recursive: true, force: true });
});

test("portable TTSR tool_result honors tool-specific scope", async () => {
  const cwd = tempRoot();
  mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(cwd, ".cursor", "rules", "bash-hit.mdc"), "---\ncondition: danger\ninterruptMode: tool-only\nscope: tool:bash\n---\nStop and reconsider.");
  const handlers: Record<string, Function> = {};
  hindsight({
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: Function) { handlers[name] = handler; },
  } as any);

  const readResult = await handlers.tool_result({ toolName: "read", content: [{ type: "text", text: "danger output" }] }, { cwd });
  assert.equal(readResult, undefined);
  const bashResult = await handlers.tool_result({ toolName: "bash", content: [{ type: "text", text: "danger output" }] }, { cwd });
  assert.equal(bashResult.details.hindsightRule, "bash-hit");
  assert.ok(bashResult.content[0].text.includes("Hindsight rule matched: bash-hit"));
  rmSync(cwd, { recursive: true, force: true });
});

test("portable TTSR tool_result honors globs", async () => {
  const cwd = tempRoot();
  mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(cwd, ".cursor", "rules", "python-hit.mdc"), "---\ncondition: danger\ninterruptMode: tool-only\nscope: tool\nglobs:\n  - \"*.py\"\n---\nStop and reconsider.");
  const handlers: Record<string, Function> = {};
  hindsight({
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: Function) { handlers[name] = handler; },
  } as any);

  const readmeResult = await handlers.tool_result({ toolName: "read", input: { path: "README.md" }, content: [{ type: "text", text: "danger output" }] }, { cwd });
  assert.equal(readmeResult, undefined);
  const pyResult = await handlers.tool_result({ toolName: "read", input: { path: "src/app.py" }, content: [{ type: "text", text: "danger output" }] }, { cwd });
  assert.equal(pyResult.details.hindsightRule, "python-hit");
  rmSync(cwd, { recursive: true, force: true });
});

test("handleHindsightCommand recall flushes before search", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let flushed = false;
  const ctx = { cwd, hasUI: true, ui: { notify: (_msg: string, _kind: string) => {} } };
  handleHindsightCommand("recall anything", ctx, { beforeRecall: () => { flushed = true; } });
  assert.equal(flushed, true);
  rmSync(cwd, { recursive: true, force: true });
});

test("handleHindsightCommand rebuild flushes before rebuilding and reports failures", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let captured = "";
  let kind = "";
  let flushed = false;
  const ctx = { cwd, hasUI: true, ui: { notify: (msg: string, notifyKind: string) => { captured = msg; kind = notifyKind; } } };
  await assert.doesNotReject(handleHindsightCommand("rebuild", ctx, {
    beforeRebuild: () => { flushed = true; },
    rebuildMemory: async () => { throw new Error("disk full"); },
  }));
  assert.equal(flushed, true);
  assert.equal(kind, "warning");
  assert.ok(captured.includes("memory rebuild failed: disk full"));
  rmSync(cwd, { recursive: true, force: true });
});
