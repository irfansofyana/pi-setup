import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

import { projectBasename, redactSecrets } from "./store.ts";
import { buildRuleFromMarkdown, builtinDefaultRules, discoverRules, parseFrontmatter, splitBuckets } from "./rules.ts";
import hindsight, {
  HindsightHttpClient,
  computeBankScope,
  defaultHindsightConfig,
  formatRecallResponse,
  handleHindsightCommand,
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

test("projectBasename guards traversal", () => {
  assert.equal(projectBasename("/foo/../.."), "root");
  assert.equal(projectBasename("/home/user/projects/demo-app"), "demo-app");
});

test("computeBankScope supports oh-my-pi style project tagging", () => {
  const cwd = "/work/a/demo";
  assert.deepEqual(computeBankScope({ bankId: "pi", scoping: "global" }, cwd), { bankId: "pi" });
  assert.ok(computeBankScope({ bankId: "pi", scoping: "per-project" }, cwd).bankId.startsWith("pi-demo-"));
  const tagged = computeBankScope({ bankId: "pi", scoping: "per-project-tagged" }, cwd);
  assert.equal(tagged.bankId, "pi");
  assert.equal(tagged.tagsMatch, "any");
  assert.ok(tagged.tags?.[0].startsWith("project:demo-"));
});

test("formatRecallResponse formats real Hindsight recall results", () => {
  const block = formatRecallResponse({ results: [{ text: "User prefers node:test", type: "experience", mentioned_at: "2026-01-02T00:00:00Z" }] });
  assert.ok(block.includes("Relevant memories from past conversations"));
  assert.ok(block.includes("User prefers node:test"));
});

test("defaultHindsightConfig reads local daemon defaults", () => {
  const config = defaultHindsightConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.apiUrl, "http://127.0.0.1:8888");
  assert.equal(config.bankId, "pi");
  assert.equal(config.scoping, "per-project-tagged");
  assert.equal(config.autoStartDaemon, false);
});

test("HindsightHttpClient calls real API endpoints with scope and redaction", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ results: [{ text: "ok" }], text: "reflected", success: true }), { status: 200 });
  };
  const client = new HindsightHttpClient({ apiUrl: "http://hindsight.local", apiToken: "tok", autoStartDaemon: false }, fetchImpl as any);
  const scope = { bankId: "pi", tags: ["project:demo"], tagsMatch: "any" as const };

  await client.retain(scope, [{ content: "OPENAI_API_KEY=supersecret12345", context: "ctx" }]);
  await client.recall(scope, "prefs", { budget: "high", maxTokens: 123 });
  await client.reflect(scope, "why", { context: "now", budget: "low" });
  await client.clearMemories(scope);

  assert.equal(calls[0].url, "http://hindsight.local/v1/default/banks/pi/memories");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.ok(calls[0].init.body.includes("[REDACTED]"));
  assert.ok(calls[0].init.body.includes("project:demo"));
  assert.equal(calls[1].url, "http://hindsight.local/v1/default/banks/pi/memories/recall");
  assert.ok(calls[1].init.body.includes('"budget":"high"'));
  assert.ok(calls[1].init.body.includes('"max_tokens":123'));
  assert.equal(calls[2].url, "http://hindsight.local/v1/default/banks/pi/reflect");
  assert.ok(calls[2].init.body.includes('"context":"now"'));
  assert.equal(calls[3].url, "http://hindsight.local/v1/default/banks/pi/memories");
  assert.equal(calls[3].init.method, "DELETE");
});

test("HindsightHttpClient reports non-JSON HTTP errors before parsing", async () => {
  const fetchImpl = async () => new Response("bad gateway", { status: 502 });
  const client = new HindsightHttpClient({ apiUrl: "http://hindsight.local", autoStartDaemon: false, requestTimeoutMs: 1000 }, fetchImpl as any);
  await assert.rejects(() => client.health(), /failed \(502\): bad gateway/);
});

test("HindsightHttpClient applies default request timeout", async () => {
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    return new Response("{}");
  };
  const client = new HindsightHttpClient({ apiUrl: "http://hindsight.local", autoStartDaemon: false, requestTimeoutMs: 10 }, fetchImpl as any);
  await assert.rejects(() => client.health(), /Timeout|aborted|Abort/i);
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

test("promptBlocks gates real Hindsight daemon guidance and rules", () => {
  const cwd = "/x/prompt-block";
  const rule: Rule = { name: "always", path: "/r", content: "always body", alwaysApply: true, provider: "native", priority: 100 };
  assert.equal(promptBlocks(cwd, [], false), "");
  assert.ok(promptBlocks(cwd, [], true).startsWith("Hindsight memory is backed by the local Hindsight daemon"));
  const block = promptBlocks(cwd, [rule], true);
  assert.ok(block.includes("hindsight_recall"));
  assert.ok(block.includes("always body"));
});

test("handleHindsightCommand view redacts Hindsight API token", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let captured = "";
  const ctx = { cwd, hasUI: true, ui: { notify: (msg: string, _kind: string) => { captured = msg; } } };
  await handleHindsightCommand("view", ctx);
  assert.ok(!captured.includes(process.env.HINDSIGHT_API_TOKEN || "definitely-not-present"));
  assert.ok(!captured.includes(process.env.HINDSIGHT_API_KEY || "definitely-not-present"));
  rmSync(cwd, { recursive: true, force: true });
});

test("handleHindsightCommand stats notify mentions Hindsight bank and rules", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let captured = "";
  const ctx = { cwd, hasUI: true, ui: { notify: (msg: string, _kind: string) => { captured = msg; } } };
  await handleHindsightCommand("stats", ctx, { statusMemory: async () => "hindsight health: ok" });
  assert.ok(captured.includes("hindsight api:"));
  assert.ok(captured.includes("bank:"));
  assert.ok(captured.includes("rules"));
  rmSync(cwd, { recursive: true, force: true });
});

test("handleHindsightCommand diagnose notify mentions project dir and daemon status", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let captured = "";
  const ctx = { cwd, hasUI: true, ui: { notify: (msg: string, _kind: string) => { captured = msg; } } };
  await handleHindsightCommand("diagnose", ctx, { statusMemory: async () => "daemon ok" });
  assert.ok(captured.includes(`project dir: ${cwd}`));
  assert.ok(captured.includes("hindsight api:"));
  assert.ok(captured.includes("daemon ok"));
  rmSync(cwd, { recursive: true, force: true });
});

test("hindsight clear delegates to real Hindsight client when provided", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-clear-"));
  let captured = "";
  await handleHindsightCommand("clear", { cwd, ui: { notify(msg: string) { captured = msg; } } }, {
    clearMemory: async () => "deleted Hindsight bank pi-demo",
  });
  assert.equal(captured, "deleted Hindsight bank pi-demo");
  rmSync(cwd, { recursive: true, force: true });
});

test("hindsight clear and recall report failures as warnings", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-errors-"));
  const notices: Array<{ msg: string; kind: string }> = [];
  const ctx = { cwd, ui: { notify(msg: string, kind: string) { notices.push({ msg, kind }); } } };
  await handleHindsightCommand("clear", ctx, { clearMemory: async () => { throw new Error("daemon down"); } });
  await handleHindsightCommand("recall prefs", ctx, { recallMemory: async () => { throw new Error("daemon down"); } });
  assert.equal(notices[0].kind, "warning");
  assert.ok(notices[0].msg.includes("hindsight clear failed: daemon down"));
  assert.equal(notices[1].kind, "warning");
  assert.ok(notices[1].msg.includes("hindsight recall failed: daemon down"));
  rmSync(cwd, { recursive: true, force: true });
});

test("auto-recall requires memory backend opt-in", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-auto-recall-"));
  const commands: Record<string, any> = {};
  const handlers: Record<string, Function> = {};
  const fakeClient = {
    retain: async () => ({}),
    recall: async () => ({ results: [{ text: "remember this hidden fact", type: "experience", mentioned_at: "2026-01-01T00:00:00Z" }] }),
  };
  hindsight({
    hindsightClient: fakeClient,
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

  rmSync(cwd, { recursive: true, force: true });
});

test("session shutdown auto-retain requires memory backend opt-in", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-auto-retain-"));
  const commands: Record<string, any> = {};
  const handlers: Record<string, Function> = {};
  const retained: string[] = [];
  const fakeClient = { retain: async (_scope: any, items: any[]) => { retained.push(...items.map((item) => item.content)); } };
  hindsight({
    hindsightClient: fakeClient,
    registerTool() {},
    registerCommand(name: string, command: any) { commands[name] = command; },
    on(name: string, handler: Function) { handlers[name] = handler; },
  } as any);

  await commands.hindsight.handler("memory disable", { cwd, ui: { notify() {} } });
  await handlers.session_shutdown({}, {
    cwd,
    sessionManager: { getEntries: () => [{ role: "user", content: "do not retain without opt-in" }] },
  });
  assert.equal(retained.length, 0);

  await commands.hindsight.handler("memory enable", { cwd, ui: { notify() {} } });
  await handlers.session_shutdown({}, {
    cwd,
    sessionManager: { getEntries: () => [{ role: "user", content: "retain after opt-in" }] },
  });
  assert.equal(retained.some((text) => text.includes("retain after opt-in")), true);
  await commands.hindsight.handler("memory disable", { cwd, ui: { notify() {} } });

  rmSync(cwd, { recursive: true, force: true });
});

test("hindsight_retain reports server-confirmed retain", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-retain-"));
  const tools: Record<string, any> = {};
  const retained: string[] = [];
  const fakeClient = { retain: async (_scope: any, items: any[], options: any) => { retained.push(...items.map((item) => `${item.content}:${options.async}`)); } };
  hindsight({
    hindsightClient: fakeClient,
    registerTool(tool: any) { tools[tool.name] = tool; },
    registerCommand() {},
    on() {},
  } as any);
  const result = await tools.hindsight_retain.execute("retain", { text: "durable fact", category: "test" }, undefined, undefined, { cwd });
  assert.deepEqual(retained, ["durable fact:false"]);
  assert.ok(result.content[0].text.includes("Retained memory"));
  rmSync(cwd, { recursive: true, force: true });
});

test("hindsight clear skips shutdown auto-retain", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-clear-"));
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const handlers: Record<string, Function> = {};
  const retained: string[] = [];
  const fakeClient = { retain: async (_scope: any, items: any[]) => { retained.push(...items.map((item) => item.content)); } };
  hindsight({
    hindsightClient: fakeClient,
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

  assert.deepEqual(retained, ["cleared queued memory"]);
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

test("handleHindsightCommand recall flushes before search", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hindsight-cmd-"));
  let flushed = false;
  const ctx = { cwd, hasUI: true, ui: { notify: (_msg: string, _kind: string) => {} } };
  await handleHindsightCommand("recall anything", ctx, { beforeRecall: () => { flushed = true; } });
  assert.equal(flushed, true);
  rmSync(cwd, { recursive: true, force: true });
});

