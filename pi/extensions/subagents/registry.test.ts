import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Removing the managed registry, bypassing its policy, or pointing it at upstream's
// six presets must fail these admission tests. No provider or process is started.
async function registry(t: any) {
  const module = await import("./registry.ts").catch(() => undefined);
  assert.equal(typeof module?.createAgentRegistry, "function", "managed registry is available");
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "profile"), cwd = join(root, "repo");
  await mkdir(agentDir); await mkdir(cwd);
  return { ...module!, root, agentDir, cwd, store: module!.createAgentRegistry({ agentDir, cwd, includeProject: false }) };
}
const definition = (name: string, tools = "read") => `---\nname: ${name}\ndescription: Custom bounded helper\ntools:\n  allow: [${tools}]\n---\nComplete only the assigned task.\n`;

test("fresh profiles expose four bundled types and code-mapper resolves to scout", async t => {
  const f = await registry(t);
  assert.deepEqual(f.store.list().map((type: any) => type.name), ["builder", "researcher", "reviewer", "scout"]);
  assert.equal(f.store.get("code-mapper").name, "scout");
  const resolved = f.resolveAgentDefinition(f.store.get("scout"), { model: "fixture/model", models: ["fixture/model"] });
  assert.equal(resolved.loadout.role, "scout"); assert.equal(resolved.loadout.softTurns, 25);
  assert.equal(resolved.loadout.tools.includes("write"), false);
  assert.equal(resolved.loadout.provenance,"bundled");
});

test("custom user types and sparse YAML overrides admit without source changes", async t => {
  const f = await registry(t), directory = join(f.agentDir, "subagent-manager", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "worker.md"), definition("worker"));
  await writeFile(join(directory, "scout.yml"), "models: [fixture/pinned]\nthinkingLevel: low\n");
  f.store.reload();
  const worker = f.resolveAgentDefinition(f.store.get("worker"), { model: "fixture/model", models: ["fixture/model"] });
  assert.deepEqual(worker.loadout.tools, ["read"]);
  assert.equal(worker.loadout.provenance,"trusted-global");
  assert.equal(worker.loadout.softTurns, 40);
  const scout = f.resolveAgentDefinition(f.store.get("scout"), { model: "fixture/model", models: ["fixture/model", "fixture/pinned"] });
  assert.equal(scout.loadout.model, "fixture/pinned"); assert.equal(scout.thinking, "low");
});

test("invalid and symlinked higher-priority definitions fail closed", async t => {
  const f = await registry(t), directory = join(f.agentDir, "subagent-manager", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "scout.yml"), "tools: broken\n");
  await symlink(join(f.root, "missing"), join(directory, "reviewer.md"));
  f.store.reload();
  assert.throws(() => f.store.get("scout"), /Unknown|invalid/);
  assert.throws(() => f.store.get("reviewer"), /Unknown|invalid/);
});

test("project roles are ignored unless the project is explicitly trusted", async t => {
  const f = await registry(t), directory = join(f.cwd, ".pi", "agent", "subagent-manager", "agents");
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, "writer.md"), definition("writer"));
  f.store.reload(); assert.throws(() => f.store.get("writer"), /Unknown/);
  const trusted = f.createAgentRegistry({ agentDir: f.agentDir, cwd: f.cwd, includeProject: true });
  assert.equal(trusted.get("writer").source, "project");
  assert.equal(f.resolveAgentDefinition(trusted.get("writer"),{model:"fixture/model",models:["fixture/model"]}).loadout.provenance,"trusted-project");
});

test("custom definitions cannot expand canonical tools or silently request unsupported authority", async t => {
  const f = await registry(t);
  assert.throws(() => f.resolveAgentDefinition({ ...f.store.get("scout"), tools: { allow: ["read", "write"] } }, { model: "fixture/model", models: ["fixture/model"] }), /boundary/);
  assert.throws(() => f.resolveAgentDefinition({ name: "shell-worker", description: "unsafe", systemPrompt: "work", tools: { allow: ["bash"] } }, { model: "fixture/model", models: ["fixture/model"] }), /Unsupported tool/);
  const safe = f.resolveAgentDefinition({ name: "worker", description: "safe", systemPrompt: "work", tools: { allow: ["read", "write"] } }, { model: "fixture/model", models: ["fixture/model"] });
  assert.equal(safe.loadout.isolation, "worktree");
});

test("definition snapshots are detached from later reloads and turn requests remain bounded", async t => {
  const f = await registry(t), original = f.store.get("scout");
  original.systemPrompt = "changed externally";
  assert.notEqual(f.store.get("scout").systemPrompt, original.systemPrompt);
  assert.throws(() => f.resolveAgentDefinition(f.store.get("scout"), { model: "fixture/model", models: ["fixture/model"], maxTurns: 26 }), /turn/);
  const result = f.resolveAgentDefinition(f.store.get("scout"), { model: "fixture/model", models: ["fixture/model"], maxTurns: 3 });
  assert.equal(result.loadout.hardTurns, 8);
});

test("agent editor saves reject expanded canonical tools and reserved alias names before writing",async t=>{
  const f=await registry(t);
  assert.throws(()=>f.store.save({...f.store.get("scout"),tools:{allow:["write"]}},"user"),/boundary/);
  assert.throws(()=>f.store.save({name:"code-mapper",description:"Ambiguous",systemPrompt:"work"},"user"),/alias/);
  assert.throws(()=>f.store.saveOverride("scout",{...f.store.get("scout"),tools:{allow:["bash"]}},"user"),/Unsupported|boundary/);
  assert.equal(f.store.get("scout").source,"bundled");
});

test("only custom types can explicitly opt into reviewed delegation verbs",async t=>{
  const f=await registry(t), options={model:"fixture/model",models:["fixture/model"]};
  const custom=f.resolveAgentDefinition({name:"coordinator",description:"Bounded coordinator",systemPrompt:"Delegate only assigned work",tools:{allow:["agent_types","agent_spawn","agent_wait","agent_status"]}},options);
  assert.deepEqual(custom.toolNames,["agent_types","agent_spawn","agent_wait","agent_status"]);
  assert.throws(()=>f.resolveAgentDefinition({...f.store.get("scout"),tools:{allow:["agent_spawn"]}},options),/boundary/);
});

test("explicit invocation model wins over preferences and cannot hide an unavailable or out-of-scope request",async t=>{
  const f=await registry(t),type={...f.store.get("scout"),models:["fixture/preferred"]};
  const options={model:"fixture/inherited",models:["fixture/preferred","fixture/override","fixture/inherited"]};
  assert.equal(f.resolveAgentDefinition(type,{...options,explicitModel:"fixture/override"}).loadout.model,"fixture/override");
  assert.throws(()=>f.resolveAgentDefinition(type,{...options,explicitModel:"fixture/missing"}),/available/);
  assert.throws(()=>f.resolveAgentDefinition(type,{...options,explicitModel:"fixture/override",scopedModels:["fixture/preferred"]}),/scope/);
});

test("bundled local roles have no required FFF or external skills", async t => {
  const f = await registry(t);
  for (const role of ["scout", "reviewer", "builder"]) {
    const resolved = f.resolveAgentDefinition(f.store.get(role), { model: "fixture/model", models: ["fixture/model"], availableTools: [] });
    assert.deepEqual(resolved.loadout.extensions, []);
    assert.deepEqual(resolved.loadout.skills, []);
    assert.ok(resolved.toolNames.includes("read"));
    assert.ok(resolved.toolNames.includes("grep"));
  }
  const partial = f.resolveAgentDefinition(f.store.get("scout"), { model: "fixture/model", models: ["fixture/model"], availableTools: ["ffgrep"] });
  assert.ok(partial.toolNames.includes("ffgrep"));
  assert.ok(!partial.toolNames.includes("fffind"));
  assert.ok(!partial.toolNames.includes("fff-multi-grep"));
  assert.deepEqual(partial.loadout.extensions, ["fff"]);
});
