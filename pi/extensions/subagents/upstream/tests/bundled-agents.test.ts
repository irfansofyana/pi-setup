import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ConfigStore, parseAgentType, selectTools } from "../src/prefs/config.ts";
import { selectPreferredModel } from "../src/prefs/models.ts";
import { agentTools } from "../src/orch/tools.ts";

const BUNDLED_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
const NAMES = ["architect", "coder", "researcher", "reviewer", "tasker", "writer"];
const REMOVED = ["designer", "explorer", "worker"];
const DELEGATION = [
  "agent_types",
  "agent_spawn",
  "agent_wait",
  "agent_status",
  "agent_output",
  "agent_steer",
  "agent_stop",
];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-bundled-agents-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { cwd: join(root, "project"), agentDir: join(root, "user"), includeProject: false };
}

function availableTools(): string[] {
  const cwd = process.cwd();
  const builtins = [
    createReadToolDefinition,
    createBashToolDefinition,
    createPowerShellToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  ].map((create) => create(cwd).name);
  const controls = agentTools(
    () => {
      throw new Error("Tool enumeration must not start a manager");
    },
    "/root",
    () => [],
    () => {
      throw new Error("Tool enumeration must not resolve models");
    },
  ).map((tool) => tool.name);
  return [...builtins, ...controls];
}

test("bundled agents load cleanly, resolve their tools, and carry only advisory suggestions", (t) => {
  const store = new ConfigStore(fixture(t));
  assert.deepEqual(store.diagnostics, []);
  assert.deepEqual(
    store.list().map((type) => type.name),
    NAMES,
  );
  assert.deepEqual(
    readdirSync(BUNDLED_DIR)
      .filter((file) => file.endsWith(".md"))
      .sort(),
    NAMES.map((name) => `${name}.md`),
  );
  for (const name of REMOVED) assert.throws(() => store.get(name), /Unknown or invalid/);

  const available = availableTools();
  for (const type of store.list()) {
    assert.equal(type.source, "bundled");
    assert.ok(type.description.trim() && type.systemPrompt.trim(), type.name);
    assert.ok(type.thinkingLevel, `${type.name} sets a thinking level`);
    const { source: _source, ...withoutSource } = type;
    assert.deepEqual(
      parseAgentType(readFileSync(type.filePath!, "utf8"), type.filePath),
      withoutSource,
    );

    // Tool policy is an explicit allow-list that resolves against real tools; only architect delegates.
    const allow = type.tools?.allow ?? [];
    assert.deepEqual(Object.keys(type.tools ?? {}), ["allow"]);
    assert.deepEqual(selectTools(type.tools, available).sort(), [...allow].sort());
    assert.ok(allow.includes("agent_update") && allow.includes("agent_pause"), type.name);
    assert.deepEqual(
      allow.filter((name) => DELEGATION.includes(name)).sort(),
      type.name === "architect" ? [...DELEGATION].sort() : [],
    );

    // Suggestions are display aliases, never model pins, and never affect selection.
    const suggestions = type.modelSuggestions ?? [];
    assert.ok(suggestions.length > 0, type.name);
    assert.ok(
      suggestions.every((alias) => !alias.includes("/")),
      type.name,
    );
    assert.ok(suggestions.every((alias) => /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(alias)), type.name);
    assert.equal(type.models, undefined);
    const eligible = suggestions.map((id) => ({ model: { provider: "advisory", id } }));
    assert.equal(selectPreferredModel(type, eligible), undefined);
  }
  assert.equal(new Set(store.list().map((type) => type.systemPrompt)).size, NAMES.length);
});

test("researcher is non-delegating; tasker stays cheap-first", (t) => {
  const store = new ConfigStore(fixture(t));
  const researcher = store.get("researcher");
  assert.deepEqual(researcher.tools?.allow, [
    "read", "bash", "grep", "find", "ls", "agent_update", "agent_pause",
  ]);
  assert.equal(researcher.thinkingLevel, "high");
  assert.deepEqual(store.get("architect").modelSuggestions, [
    "opus-5.5", "gpt-6-astra", "fable-5.1", "kimi-k3",
  ]);
  assert.deepEqual(researcher.modelSuggestions, [
    "gemini-4-argon", "gpt-5.6-sol", "muse-spark-1.3", "sonnet-5.5",
  ]);
  assert.ok(store.get("writer").modelSuggestions?.includes("gemini-4-argon"));
  assert.equal(store.get("tasker").thinkingLevel, "low");
  assert.equal(store.get("tasker").modelSuggestions?.[0], "gpt-6-luna");
  assert.ok(!store.get("tasker").modelSuggestions?.includes("sonnet-5.5"));
});

test("a missing bundled directory disables packaged defaults without dropping user agents", (t) => {
  const options = fixture(t);
  const custom = new ConfigStore(options).save(
    { name: "custom", description: "User-defined role", systemPrompt: "Follow the task.\n" },
    "user",
  );
  const disabled = new ConfigStore({
    ...options,
    bundledDir: join(options.cwd, "missing-bundled"),
  });
  assert.deepEqual(disabled.diagnostics, []);
  assert.deepEqual(disabled.list(), [custom]);
});

