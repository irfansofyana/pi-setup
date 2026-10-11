import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  AGENT_COLORS,
  ConfigStore,
  diffAgentSettings,
  mergeAgentSettings,
  parseAgentSettings,
  parseAgentType,
  selectTools,
  serializeAgentSettings,
  serializeAgentType,
} from "../src/prefs/config.js";
import { THINKING_LEVELS, type AgentType } from "../src/types.js";

const definition: AgentType = {
  name: "example",
  description: "Example agent",
  systemPrompt: "# Instructions\n\nBe helpful.\n",
};
const markdown = (extra = "", name = "example") =>
  `---\nname: ${name}\ndescription: Example agent\n${extra}---\nBody\n`;
const write = (directory: string, file: string, type: Partial<AgentType>) =>
  writeFileSync(join(directory, file), serializeAgentType({ ...definition, ...type }));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "user");
  const dirs = {
    bundledDir: join(root, "bundled"),
    projectLegacy: join(cwd, ".pi", "agents"),
    project: join(cwd, ".pi", "agent", "subagent-manager", "agents"),
    userLegacy: join(agentDir, "agents"),
    user: join(agentDir, "subagent-manager", "agents"),
  };
  for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true });
  return { cwd, agentDir, ...dirs };
}

test("parse/serialize round-trips fields, canonicalizes legacy model, and drops provenance", () => {
  const type: AgentType = {
    ...definition,
    description: "colon: # yes\nmultiline",
    models: ["provider/model/id", "provider/fallback"],
    modelSuggestions: ["Claude Opus", "GPT"],
    thinkingLevel: "high",
    color: "accent",
    tools: { allow: [], block: ["bash"] },
  };
  assert.deepEqual(parseAgentType(serializeAgentType(type)), type);
  assert.equal(parseAgentType(markdown(), "example.md").filePath, "example.md");
  assert.equal(parseAgentType(markdown().replaceAll("\n", "\r\n")).systemPrompt, "Body\r\n");
  assert.equal(parseAgentType("---\nname: empty\ndescription: Empty\n---").systemPrompt, "");

  assert.deepEqual(parseAgentType(markdown("model: provider/model/with/slashes\n")).models, [
    "provider/model/with/slashes",
  ]);
  const serialized = serializeAgentType({
    ...definition,
    model: "provider/model",
    source: "user",
    filePath: "/private/example.md",
  } as AgentType);
  assert.doesNotMatch(serialized, /source:|filePath:|\nmodel:/);
  assert.deepEqual(parseAgentType(serialized), { ...definition, models: ["provider/model"] });
});

test("parser rejects malformed frontmatter and invalid field values", () => {
  for (const content of [
    "No frontmatter",
    markdown("name: duplicate\n"),
    markdown("tools: [\n"),
    markdown("permissionMode: bypassPermissions\n"),
    markdown("tools:\n  allow: []\n  allow: [bash]\n"),
    markdown("tools:\n  deny: [bash]\n"),
  ])
    assert.throws(() => parseAgentType(content, "bad.md"), /bad\.md:/);
  assert.throws(
    () => parseAgentType(markdown("unknown: true\n")),
    /Unknown frontmatter field: unknown/,
  );
  assert.throws(() => parseAgentType(markdown("model: &m provider/id\ncolor: *m\n")), /alias/i);
  assert.throws(() => parseAgentType("---\nname: valid\ndescription: ''\n---\n"), /description/);
  for (const name of ["../escape", "a/b", '""', "null", "123", "a.b"])
    assert.throws(() => parseAgentType(markdown("", name)), /name/);
  for (const extra of [
    "model: model-only\n",
    "models: provider/model\n",
    "models: []\n",
    "models:\n  - provider/model\n  - provider/model\n",
    "model: provider/legacy\nmodels:\n  - provider/model\n",
    "thinkingLevel: extreme\n",
    "color: red\n",
    "tools: bash\n",
    "tools:\n  allow: null\n",
    "tools:\n  block: [bash*]\n",
    "tools:\n  allow: [read, read]\n",
  ])
    assert.throws(() => parseAgentType(markdown(extra)), extra);
  for (const extra of [
    "modelSuggestions: Claude Opus\n",
    "modelSuggestions:\n  - 1\n",
    "modelSuggestions:\n  - '   '\n",
    "modelSuggestions:\n  - Claude Opus\n  - ' Claude Opus '\n",
  ])
    assert.throws(() => parseAgentType(markdown(extra)), /modelSuggestions/);
  for (const color of AGENT_COLORS)
    assert.equal(parseAgentType(markdown(`color: ${color}\n`)).color, color);
  for (const level of THINKING_LEVELS)
    assert.equal(parseAgentType(markdown(`thinkingLevel: ${level}\n`)).thinkingLevel, level);
});

test("modelSuggestions are trimmed, keep an explicit empty list, and are omitted when absent", () => {
  assert.deepEqual(
    parseAgentType(markdown("modelSuggestions:\n  - '  Claude Opus  '\n  - GPT\n"))
      .modelSuggestions,
    ["Claude Opus", "GPT"],
  );
  const empty = parseAgentType(markdown("modelSuggestions: []\n"));
  assert.deepEqual(empty.modelSuggestions, []);
  assert.deepEqual(parseAgentType(serializeAgentType(empty)).modelSuggestions, []);
  assert.equal(parseAgentType(markdown()).modelSuggestions, undefined);
  assert.doesNotMatch(serializeAgentType(definition), /modelSuggestions/);
});

test("selectTools has exact names, empty allow, block wins and stable available order", () => {
  const available = ["read", "bash", "agent_update"];
  assert.deepEqual(selectTools(undefined, available), []);
  assert.deepEqual(selectTools({ allow: [] }, available), []);
  assert.deepEqual(selectTools({ allow: ["bash", "read"], block: ["bash"] }, available), ["read"]);
  assert.deepEqual(selectTools({ block: ["bash"] }, available), []);
  for (const policy of [{ allow: ["Read"] }, { block: ["missing"] }, { allow: ["*"] }])
    assert.throws(() => selectTools(policy, available));
});

test("selectTools modes ignore irrelevant lists and deduplicate available names in order", () => {
  const available = ["read", "bash", "read", "agent_update"];
  const policy = { allow: ["bash", "read"], block: ["bash"] };
  assert.deepEqual(selectTools(policy, available, "allowed"), ["read"]);
  assert.deepEqual(selectTools(policy, available, "all-except-blocked"), ["read", "agent_update"]);
  assert.deepEqual(selectTools(policy, available, "all"), ["read", "bash", "agent_update"]);
  for (const mode of ["all-except-blocked", "all"] as const) {
    assert.deepEqual(selectTools(undefined, available, mode), ["read", "bash", "agent_update"]);
    assert.deepEqual(selectTools({ allow: [] }, available, mode), ["read", "bash", "agent_update"]);
    assert.deepEqual(selectTools({ allow: ["missing"] }, available, mode), [
      "read",
      "bash",
      "agent_update",
    ]);
  }
  assert.deepEqual(selectTools({}, available), []);
  assert.deepEqual(selectTools({ allow: [] }, available, "allowed"), []);
  assert.deepEqual(selectTools({ allow: ["missing"], block: ["missing"] }, available, "all"), [
    "read",
    "bash",
    "agent_update",
  ]);
  assert.deepEqual(
    selectTools({ allow: ["missing"], block: ["bash"] }, available, "all-except-blocked"),
    ["read", "agent_update"],
  );
  for (const mode of ["allowed", "all-except-blocked"] as const)
    assert.throws(
      () => selectTools({ block: ["missing"] }, available, mode),
      /Unavailable tool name: missing/,
    );
  assert.throws(
    () => selectTools({ allow: ["missing"] }, available, "allowed"),
    /Unavailable tool name: missing/,
  );
});

test("precedence, source, filePath, trust switch and defensive copies", (t) => {
  const f = fixture(t);
  for (const [directory, description] of [
    [f.bundledDir, "bundled"],
    [f.user, "user"],
    [f.project, "project"],
  ])
    write(directory, "example.md", { description });
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.equal(store.get("example").description, "project");
  assert.equal(store.get("example").source, "project");
  assert.equal(store.get("example").filePath, join(f.project, "example.md"));
  store.get("example").description = "changed";
  store.list()[0].description = "changed";
  assert.equal(store.get("example").description, "project");
  assert.equal(new ConfigStore({ ...f, includeProject: false }).get("example").source, "user");
  assert.throws(() => store.get("missing"), /Unknown or invalid/);

  // Duplicate names within one layer fail closed; a higher layer still wins.
  writeFileSync(join(f.bundledDir, "worker.md"), markdown("", "worker"));
  for (const file of ["worker-a.md", "worker-b.md"])
    writeFileSync(join(f.user, file), markdown("", "worker"));
  store.reload();
  assert.throws(() => store.get("worker"), /Unknown or invalid/);
  assert.equal(store.diagnostics.length, 1);
  assert.match(store.diagnostics[0], /Duplicate agent name.*worker/);
  writeFileSync(join(f.project, "worker.md"), markdown("", "worker"));
  store.reload();
  assert.equal(store.get("worker").source, "project");
  assert.throws(
    () => new ConfigStore({ ...f, includeProject: false }).get("worker"),
    /Unknown or invalid/,
  );
});

test("malformed overrides block both filename and declared name while other files load", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", {});
  write(f.bundledDir, "other.md", { name: "other" });
  writeFileSync(join(f.project, "example.md"), markdown("unsupported: true\n", "other"));
  writeFileSync(join(f.project, "good.md"), markdown("", "good"));
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.throws(() => store.get("example"));
  assert.throws(() => store.get("other"));
  assert.equal(store.get("good").source, "project");
  assert.equal(store.diagnostics.length, 1);
  assert.match(store.diagnostics[0], /Unknown frontmatter field/);
  rmSync(join(f.project, "example.md"));
  store.reload();
  assert.equal(store.get("example").source, "bundled");
  assert.deepEqual(store.diagnostics, []);

  // A malformed file with duplicate declared names cannot resurrect lower layers.
  for (const name of ["example", "other"])
    writeFileSync(join(f.user, `${name}.md`), markdown("", name));
  writeFileSync(join(f.project, "broken.md"), markdown("name: other\n"));
  store.reload();
  assert.throws(() => store.get("example"));
  assert.throws(() => store.get("other"));
  assert.match(store.diagnostics.join("\n"), /unique|duplicate/i);
});

test("legacy agent directories (including symlinked ones) are ignored", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", { description: "bundled" });
  writeFileSync(join(f.userLegacy, "example.md"), "not frontmatter");
  write(f.userLegacy, "legacy-only.md", { name: "legacy-only" });
  write(f.projectLegacy, "example.md", { description: "Legacy project" });
  writeFileSync(join(f.projectLegacy, "broken.md"), ":\n  [");
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.equal(store.get("example").filePath, join(f.bundledDir, "example.md"));
  assert.throws(() => store.get("legacy-only"), /Unknown or invalid/);
  assert.deepEqual(store.diagnostics, []);

  const outside = join(f.agentDir, "outside-package");
  mkdirSync(outside);
  write(outside, "hijack.md", { name: "hijack" });
  for (const legacy of [f.userLegacy, f.projectLegacy]) {
    rmSync(legacy, { recursive: true });
    symlinkSync(outside, legacy);
  }
  store.reload();
  assert.throws(() => store.get("hijack"), /Unknown or invalid/);
  assert.equal(store.get("example").source, "bundled");
  assert.deepEqual(store.diagnostics, []);
});

test("saves write canonical storage, keep existing filenames, and never touch bundled files", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "bundled-only.md", { name: "bundled-only", description: "Bundled only" });
  write(f.user, "custom.md", { name: "custom-file" });
  const store = new ConfigStore({ ...f, includeProject: true });

  const bundled = store.get("bundled-only");
  const override = store.save({ ...bundled, description: "Override" }, "user", bundled);
  assert.equal(override.filePath, join(f.user, "bundled-only.md"));
  assert.equal(override.source, "user");
  assert.equal(store.get("bundled-only").description, "Override");
  assert.equal(
    parseAgentType(readFileSync(join(f.bundledDir, "bundled-only.md"), "utf8")).description,
    "Bundled only",
  );

  const custom = store.get("custom-file");
  const updated = store.save({ ...custom, description: "Updated" }, "user", custom);
  assert.equal(updated.filePath, join(f.user, "custom.md"));
  assert.equal(store.get("custom-file").description, "Updated");

  const saved = store.save(
    { ...definition, tools: { allow: [] }, modelSuggestions: ["GPT"] },
    "user",
  );
  assert.deepEqual(parseAgentType(readFileSync(saved.filePath!, "utf8")).tools, { allow: [] });
  saved.modelSuggestions!.push("mutated");
  assert.deepEqual(store.get("example").modelSuggestions, ["GPT"]);
  store.save({ ...definition, description: "Project" }, "project");
  assert.equal(store.get("example").description, "Project");
  assert.deepEqual(readdirSync(f.user).sort(), ["bundled-only.md", "custom.md", "example.md"]);
  assert.deepEqual(readdirSync(f.project), ["example.md"]);
  assert.deepEqual(readdirSync(f.userLegacy), []);
  assert.deepEqual(readdirSync(f.projectLegacy), []);

  assert.throws(() => store.save({ ...definition, name: "../escape" }, "user"));
  assert.throws(() => store.save({ ...definition, color: "red" } as AgentType, "user"));
  assert.throws(
    () => new ConfigStore({ ...f, includeProject: false }).save(definition, "project"),
    /not enabled\/trusted/,
  );
});

test("symlink definitions fail closed and symlink save destinations are rejected", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", {});
  symlinkSync(join(f.bundledDir, "example.md"), join(f.user, "example.md"));
  const store = new ConfigStore({ ...f, includeProject: false });
  assert.throws(() => store.get("example"));
  assert.throws(() => store.save(definition, "user"), /Unsafe symlink path/);

  rmSync(join(f.user, "example.md"));
  symlinkSync(join(f.user, "missing.md"), join(f.user, "worker.md"));
  assert.throws(() => store.save({ ...definition, name: "worker" }, "user"), /Unsafe symlink path/);

  rmSync(f.user, { recursive: true });
  symlinkSync(join(f.agentDir, "missing-agents"), f.user);
  store.reload();
  assert.throws(() => store.get("example"));
  assert.match(store.diagnostics.join("\n"), /Unsafe symlink path/);
  assert.throws(() => store.save(definition, "user"), /Unsafe symlink path/);

  rmSync(f.user);
  mkdirSync(f.user);
  rmSync(f.project, { recursive: true });
  symlinkSync(f.bundledDir, f.project);
  const trusted = new ConfigStore({ ...f, includeProject: true });
  assert.throws(() => trusted.get("example"));
  assert.match(trusted.diagnostics.join("\n"), /Unsafe symlink path/);
  assert.throws(() => trusted.save(definition, "project"), /Unsafe symlink path/);
});

test("settings overrides parse, reject bodies, and round-trip sparse fields", () => {
  assert.deepEqual(parseAgentSettings("thinkingLevel: high\n"), { thinkingLevel: "high" });
  assert.deepEqual(parseAgentSettings("name: example\ncolor: accent\n", undefined, "example"), {
    name: "example",
    color: "accent",
  });
  assert.deepEqual(parseAgentSettings("icon: null\n"), { icon: null });
  assert.deepEqual(parseAgentSettings("model: provider/model\n").models, ["provider/model"]);
  const roundTripped = parseAgentSettings(
    serializeAgentSettings({ name: "example", thinkingLevel: "low", icon: null }),
  );
  assert.deepEqual(roundTripped, { name: "example", thinkingLevel: "low", icon: null });
  for (const content of [
    "---\nname: example\n---\nBody\n",
    "systemPrompt: hello\n",
    "prompt: hello\n",
    "unknown: true\n",
    "name: other\n",
    "thinkingLevel: extreme\n",
    "color: red\n",
    "description: ''\n",
    "tools:\n  deny: [bash]\n",
  ])
    assert.throws(
      () => parseAgentSettings(content, "example.yml", "example"),
      /example\.yml:/,
    );
});

test("merges keep unset fields on the base and null clears optional fields", () => {
  const base: AgentType = {
    ...definition,
    thinkingLevel: "high",
    color: "accent",
    icon: "",
    tools: { allow: ["read"] },
  };
  const merged = mergeAgentSettings(base, { thinkingLevel: "low" });
  assert.equal(merged.thinkingLevel, "low");
  assert.equal(merged.color, "accent");
  assert.equal(merged.systemPrompt, base.systemPrompt);
  const cleared = mergeAgentSettings(base, { color: null, icon: null, tools: null });
  assert.equal(cleared.color, undefined);
  assert.equal(cleared.icon, undefined);
  assert.equal(cleared.tools, undefined);
  assert.deepEqual(diffAgentSettings(base, { ...base, thinkingLevel: "low" }), {
    name: "example",
    thinkingLevel: "low",
  });
  assert.deepEqual(diffAgentSettings(base, base), { name: "example" });
});

test("user .yml merges over bundled, project .yml merges over user, forks win", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", {
    thinkingLevel: "high",
    color: "accent",
    systemPrompt: "Base prompt\n",
  });
  writeFileSync(join(f.user, "example.yml"), "thinkingLevel: low\n");
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.deepEqual(store.diagnostics, []);
  const merged = store.get("example");
  assert.equal(merged.thinkingLevel, "low");
  assert.equal(merged.color, "accent");
  assert.equal(merged.systemPrompt, "Base prompt\n");
  assert.equal(merged.source, "user");
  assert.deepEqual(merged.customization, {
    kind: "override",
    scope: "user",
    filePath: join(f.user, "example.yml"),
  });
  assert.equal(store.getBase("example")?.thinkingLevel, "high");
  writeFileSync(join(f.project, "example.yml"), "color: success\n");
  store.reload();
  assert.equal(store.get("example").thinkingLevel, "low");
  assert.equal(store.get("example").color, "success");
  assert.equal(store.get("example").source, "project");
  rmSync(join(f.project, "example.yml"));
  write(f.project, "example.md", { description: "Project fork" });
  store.reload();
  assert.equal(store.get("example").description, "Project fork");
  assert.equal(store.get("example").customization?.kind, "fork");
});

test("override conflicts fail closed without dropping other agents", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", {});
  write(f.bundledDir, "other.md", { name: "other" });
  write(f.user, "example.md", { description: "Fork" });
  writeFileSync(join(f.user, "example.yml"), "thinkingLevel: low\n");
  writeFileSync(join(f.user, "orphan.yml"), "description: No base\n");
  write(f.user, "good.md", { name: "good", description: "Good fork" });
  const store = new ConfigStore({ ...f, includeProject: false });
  assert.throws(() => store.get("example"), /Unknown or invalid/);
  assert.throws(() => store.get("orphan"), /Unknown or invalid/);
  assert.equal(store.get("good").description, "Good fork");
  assert.match(store.diagnostics.join("\n"), /not both/);
  assert.match(store.diagnostics.join("\n"), /no base agent/);
});

test("saveOverride writes sparse .yml and removeCustomization restores the base", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", { thinkingLevel: "high", color: "accent" });
  const store = new ConfigStore({ ...f, includeProject: false });
  const saved = store.saveOverride(
    "example",
    { ...store.get("example"), thinkingLevel: "low" },
    "user",
    store.get("example"),
  );
  assert.equal(saved.thinkingLevel, "low");
  assert.ok(saved.filePath?.endsWith("example.yml"));
  assert.equal(readFileSync(saved.filePath!, "utf8"), "name: example\nthinkingLevel: low\n");
  assert.equal(store.get("example").color, "accent");
  assert.throws(
    () => store.saveOverride("example", { ...saved, name: "renamed" }, "user", saved),
    /cannot rename/,
  );
  store.removeCustomization("example", "user");
  assert.equal(store.get("example").thinkingLevel, "high");
  assert.equal(store.get("example").source, "bundled");
});

