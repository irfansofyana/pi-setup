import assert from "node:assert/strict";
import test from "node:test";
import { parentSearchTools, selectOptionalTools, selectOptionalSkills, usesBundledResources, shouldUseBuiltinFallback } from "./parent-resources.ts";

const names = ["read", "grep", "find", "ls", "fffind", "ffgrep", "fff-multi-grep"];

test("bundled roles work without optional companion tools or skills", () => {
  assert.deepEqual(selectOptionalTools(names, "bundled", []), ["read", "grep", "find", "ls"]);
  assert.deepEqual(selectOptionalSkills("scout", ["mermaid", "teach"], []), []);
  assert.deepEqual(selectOptionalSkills("reviewer", ["code-review"], []), []);
  assert.deepEqual(selectOptionalSkills("researcher", ["my-web-search"], []), ["my-web-search"]);
});

test("bundled roles use only available optional tools; custom requirements stay exact", () => {
  assert.deepEqual(selectOptionalTools(names, "bundled", ["ffgrep"]), ["read", "grep", "find", "ls", "ffgrep"]);
  assert.deepEqual(selectOptionalTools(names, "global", []), names);
  assert.deepEqual(selectOptionalSkills("scout", ["mermaid", "teach"], ["mermaid"]), ["mermaid"]);
});

test("parent reuse exposes only approved search tools through parent execution hooks", async () => {
  const calls: any[] = [];
  const tool = (name: string) => ({ name, description: name, parameters: { type: "object" } });
  const ctx = { cwd: "/repo", tools: [tool("ffgrep"), tool("bash"), tool("web_fetch")],
    async executeTool(...args: any[]) { calls.push(args); return { isError: false, result: { content: [{ type: "text", text: "match" }], details: {} } }; } };
  const tools = parentSearchTools(ctx);
  assert.deepEqual(tools.map(tool => tool.name), ["ffgrep"]);
  const signal = new AbortController().signal;
  const result = await tools[0].execute("child-call", { pattern: "entry" }, signal, undefined, { cwd: "/repo" } as any);
  assert.equal(result.content[0].text, "match");
  assert.equal(calls[0][0], "ffgrep");
  assert.equal(calls[0][2].signal, signal);
  await assert.rejects(tools[0].execute("child-call", {}, signal, undefined, { cwd: "/worktree" } as any), /cwd/);
});

test("missing or broken optional extension metadata cannot block core startup", () => {
  assert.deepEqual(parentSearchTools({ cwd: "/repo" }), []);
  assert.deepEqual(parentSearchTools({ cwd: "/repo", get tools() { throw Error("broken extension"); }, executeTool() {} }), []);
  assert.deepEqual(parentSearchTools({ cwd: "/repo", tools: [null, { name: "ffgrep" }], executeTool() {} }), []);
});

test("model-only overrides of bundled roles keep optional-resource behavior", () => {
  assert.equal(usesBundledResources({ source: "bundled" }), true);
  assert.equal(usesBundledResources({ source: "user", baseSource: "bundled", customization: { kind: "override" } }), true);
  assert.equal(usesBundledResources({ source: "user", baseSource: "bundled", customization: { kind: "fork" } }), false);
});

test("optional initialization fallback never retries provider work or changes explicit custom/context contracts", () => {
  const bundled = { source: "bundled" };
  for (const code of ["unsupported_resource", "initialization_failed"]) assert.equal(shouldUseBuiltinFallback(bundled, true, code, false), true);
  for (const code of ["unsupported_provider", "unsupported_routing", "execution_failed"]) assert.equal(shouldUseBuiltinFallback(bundled, true, code, false), false);
  assert.equal(shouldUseBuiltinFallback({ source: "user" }, true, "unsupported_resource", false), false);
  assert.equal(shouldUseBuiltinFallback(bundled, true, "unsupported_resource", true), false);
  assert.equal(shouldUseBuiltinFallback(bundled, false, "unsupported_resource", false), false);
});

test("failed parent tools cannot become successful child results", async () => {
  const tools = parentSearchTools({ cwd: "/repo", tools: [{ name: "ffgrep", description: "Search", parameters: { type: "object" } }],
    async executeTool() { return { isError: true, result: { content: [{ type: "text", text: "failed" }], details: {} } }; } });
  await assert.rejects(tools[0].execute("call", {}, undefined, undefined, { cwd: "/repo" } as any), /Parent search tool failed/);
});
