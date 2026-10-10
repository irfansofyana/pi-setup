import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedRole, createTrustedRoleBackend, probeApprovedResources } from "./trusted.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { provider } from "./backend.test.ts";
const templates = fileURLToPath(new URL("../../agents/", import.meta.url));
async function fixture(fn: (agentDir: string, cwd: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "trusted-roles-"));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  try {
    await mkdir(join(agentDir, "agents"), { recursive: true }); await mkdir(cwd);
    await writeFile(join(cwd, "fixture.txt"), "approved fixture\n");
    await fn(agentDir, cwd);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function install(agentDir: string, role: string) {
  await writeFile(join(agentDir, "agents", `${role}.md`), await readFile(join(templates, `${role}.md`), "utf8"));
}
const available = { tools: ["read", "grep", "find", "ls", "ext:fff/fffind", "ext:fff/ffgrep", "ext:fff/fff-multi-grep"], extensions: ["headroom", "fff"], skills: ["mermaid", "teach"], models: ["offline-fixture/offline"] };
test("trusted global canonical role resolves exact loadout and prompt with explicit model", async () => fixture(async (agentDir) => {
  await install(agentDir, "code-mapper");
  const result = await resolveTrustedRole("code-mapper", agentDir, available, { model: "offline-fixture/offline" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.loadout.model, "offline-fixture/offline");
  assert.deepEqual(result.loadout.tools, available.tools);
  assert.deepEqual(result.loadout.extensions, available.extensions);
  assert.deepEqual(result.loadout.skills, available.skills);
  assert.match(result.prompt, /You are Laya/);
}));
test("missing, project, symlink, expanded or malformed global definitions reject before construction", async () => fixture(async (agentDir, cwd) => {
  assert.deepEqual(await resolveTrustedRole("code-mapper", agentDir, available, { model: "offline-fixture/offline" }), { ok: false, code: "unknown_role" });
  await install(agentDir, "code-mapper");
  const path = join(agentDir, "agents", "code-mapper.md");
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace("tools: read,", "tools: bash, read,"));
  assert.deepEqual(await resolveTrustedRole("code-mapper", agentDir, available, { model: "offline-fixture/offline" }), { ok: false, code: "authority_expansion" });
  await writeFile(path, original.replace("output_transcript: false", "output_transcript: false\nunknown_key: true"));
  assert.deepEqual(await resolveTrustedRole("code-mapper", agentDir, available, { model: "offline-fixture/offline" }), { ok: false, code: "invalid_definition" });
  await rm(path); await symlink(join(cwd, "fixture.txt"), path);
  assert.deepEqual(await resolveTrustedRole("code-mapper", agentDir, available, { model: "offline-fixture/offline" }), { ok: false, code: "untrusted_role" });
}));
test("public loader resolves actual approved web-research factory and omits ambient factories and MCP", async () => fixture(async (agentDir, cwd) => {
  let unapprovedCalls = 0;
  const result = await probeApprovedResources({ agentDir, cwd, approved: ["web-research"],
    unapproved: () => { unapprovedCalls++; throw Error("ambient factory executed"); } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.tools.sort(), ["web_fetch", "web_search"]);
  assert.equal(unapprovedCalls, 0);
  assert.deepEqual(await readdir(agentDir), ["agents"]);
}));
test("explicit native mode executes one canonical Ciung offline with only web tools and named skill", async () => fixture(async (agentDir, cwd) => {
  await install(agentDir, "researcher");
  const observed: any[] = [];
  const base = provider(() => {});
  const respond = (_model: unknown, context: any) => {
    observed.push(context);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: any = { role: "assistant", api: "offline-fixture", provider: "offline-fixture", model: "offline", content: [{ type: "text", text: "offline result" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
  const nativeProvider = { ...base, stream: respond, streamSimple: respond };
  const resources = { tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research"], skills: ["my-web-search"], models: ["offline-fixture/offline"] };
  const opened = await createTrustedRoleBackend({ role: "researcher", agentDir, cwd, model: "offline-fixture/offline", provider: nativeProvider, available: resources, routing: "native" });
  assert.equal(opened.ok, true, opened.ok ? undefined : opened.code);
  if (!opened.ok) return;
  try {
    assert.deepEqual(opened.backend.activeTools.sort(), ["web_fetch", "web_search"]);
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = (() => { outbound++; throw new Error("offline network guard: forbidden"); }) as typeof fetch;
    try {
      const result = await opened.backend.run("Summarize a public page", () => {});
      assert.equal(result.outcome, "completed");
      assert.equal(outbound, 0);
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(observed.length, 1);
    assert.match(JSON.stringify(observed[0]), /You are Ciung/);
    assert.match(JSON.stringify(observed[0]), /my-web-search/);
    assert.deepEqual(await readdir(agentDir), ["agents"]);
  } finally { await opened.backend.dispose(); }
}));

test("explicit Headroom mode never changes to native provider on missing route", async () => fixture(async (agentDir, cwd) => {
  await install(agentDir, "researcher");
  let requests = 0;
  const result = await createTrustedRoleBackend({ role: "researcher", agentDir, cwd, model: "offline-fixture/offline", routing: "headroom",
    provider: provider(() => { requests++; }), available: { tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research", "headroom"], skills: ["my-web-search"], models: ["offline-fixture/offline"] } });
  assert.deepEqual(result, { ok: false, code: "unsupported_routing" });
  assert.equal(requests, 0);
}));

test("native canonical Ciung pins built-in and custom model identities without ambient routes", async () => fixture(async (agentDir, cwd) => {
  await install(agentDir, "researcher");
  for (const [id, modelId] of [["openai", "gpt-4o-mini"], ["approved-custom", "local-model"]]) {
    const base = provider(() => {});
    const selected = { ...base.getModels()[0], provider: id, id: modelId, api: "offline-fixture" };
    const calls: string[] = [];
    const respond = (model: any) => {
      calls.push(`${model.provider}/${model.id}`);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: any = { role: "assistant", api: selected.api, provider: id, model: modelId, content: [{ type: "text", text: "done" }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    };
    const injected = { ...base, id, getModels: () => [selected], stream: respond, streamSimple: respond };
    const resources = { tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research"], skills: ["my-web-search"], models: [`${id}/${modelId}`] };
    const opened = await createTrustedRoleBackend({ role: "researcher", agentDir, cwd, model: `${id}/${modelId}`, provider: injected, available: resources, routing: "native" });
    assert.equal(opened.ok, true, opened.ok ? undefined : opened.code);
    if (!opened.ok) continue;
    try { assert.equal((await opened.backend.run("Public summary", () => {})).outcome, "completed"); assert.deepEqual(calls, [`${id}/${modelId}`]); }
    finally { await opened.backend.dispose(); }
  }
}));

test("native Laya and Prabu require exactly three approved FFF tools and named skills", async () => fixture(async (agentDir, cwd) => {
  const path = join(agentDir, "fff-fixture.mjs");
  await writeFile(path, `export default function(pi) { for (const name of ["fffind", "ffgrep", "fff-multi-grep"]) pi.registerTool({ name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "fixture" }] }) }); }`);
  for (const [role, skills] of [["code-mapper", ["mermaid", "teach"]], ["reviewer", ["code-review"]]] as const) {
    await install(agentDir, role);
    const skillPaths: Record<string, string> = {};
    for (const name of skills) {
      const file = join(agentDir, `${name}.md`);
      await writeFile(file, `---\nname: ${name}\ndescription: Approved test skill\n---\n# ${name}\n`);
      skillPaths[name] = file;
    }
    const resources = { tools: ["read", "grep", "find", "ls", "ext:fff/fffind", "ext:fff/ffgrep", "ext:fff/fff-multi-grep"], extensions: ["fff"], skills: [...skills], models: ["offline-fixture/offline"] };
    const opened = await createTrustedRoleBackend({ role, agentDir, cwd, model: "offline-fixture/offline", provider: provider(() => {}), available: resources,
      routing: "native", fffPath: path, skillPaths });
    assert.equal(opened.ok, true, opened.ok ? undefined : opened.code);
    if (opened.ok) { assert.deepEqual(opened.backend.activeTools.sort(), ["read", "grep", "find", "ls", "fffind", "ffgrep", "fff-multi-grep"].sort()); await opened.backend.dispose(); }
  }
}));

test("reviewed Headroom configuration selects native only when disabled and blocks enabled route", async () => fixture(async (agentDir, cwd) => {
  await install(agentDir, "researcher");
  const resources = { tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research"], skills: ["my-web-search"], models: ["offline-fixture/offline"] };
  const options = { role: "researcher", agentDir, cwd, model: "offline-fixture/offline", provider: provider(() => {}), available: resources };
  const native = await createTrustedRoleBackend({ ...options, reviewedHeadroom: { enabled: false } });
  assert.equal(native.ok, true, native.ok ? undefined : native.code);
  if (native.ok) await native.backend.dispose();
  assert.deepEqual(await createTrustedRoleBackend({ ...options, reviewedHeadroom: { enabled: true } }), { ok: false, code: "unsupported_routing" });
  assert.deepEqual(await createTrustedRoleBackend({ ...options, reviewedHeadroom: { enabled: true }, routing: "native" }), { ok: false, code: "unsupported_routing" });
  assert.deepEqual(await createTrustedRoleBackend({ ...options, reviewedHeadroom: { enabled: "false" as any } }), { ok: false, code: "unsupported_routing" });
}));

test("native role rejects failed auth and missing exact model without dispatch", async () => fixture(async (agentDir, cwd) => {
  await install(agentDir, "researcher");
  const base = provider(() => { throw Error("provider must not run"); });
  const resources = { tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research"], skills: ["my-web-search"], models: ["offline-fixture/offline", "offline-fixture/missing"] };
  const options = { role: "researcher", agentDir, cwd, provider: base, available: resources, routing: "native" as const };
  assert.deepEqual(await createTrustedRoleBackend({ ...options, model: "offline-fixture/missing" }), { ok: false, code: "unsupported_provider" });
  const rejected = { ...base, auth: {apiKey:{name:"rejected fixture",async check() { return undefined; }, async resolve() { return undefined; }}} };
  const response=await createTrustedRoleBackend({ ...options, model: "offline-fixture/offline", provider: rejected });
  try{assert.equal(response.ok,false);if(!response.ok)assert.equal(response.code,"unsupported_provider");}
  finally{if(response.ok)await response.backend.dispose();}
}));

test("custom-provider mismatch and unavailable Headroom route fail closed before factory loading", async () => fixture(async (agentDir, cwd) => {
  await install(agentDir, "code-mapper");
  let calls = 0;
  const options = { role: "code-mapper", agentDir, cwd, model: "offline-fixture/offline", provider: provider(() => {}), available,
    extensionFactories: { evil: () => { calls++; } } };
  assert.deepEqual(await createTrustedRoleBackend({ ...options, routing:"native",model: "different/model" }), { ok: false, code: "unsupported_provider" });
  assert.deepEqual(await createTrustedRoleBackend(options), { ok: false, code: "unsupported_routing" });
  assert.equal(calls, 0);
}));
test("canonical extension loadout never silently becomes read-only fixture; no factory runs on unsupported provider/route", async () => fixture(async (agentDir, cwd) => {
  await install(agentDir, "code-mapper");
  let executions = 0;
  const unapproved = () => { executions++; throw Error("unapproved factory executed"); };
  const result = await createTrustedRoleBackend({ role: "code-mapper", agentDir, cwd, model: "offline-fixture/offline", provider: provider(() => {}), available, extensionFactories: { evil: unapproved } });
  assert.deepEqual(result, { ok: false, code: "unsupported_routing" });
  assert.equal(executions, 0);
  assert.deepEqual(await readdir(agentDir), ["agents"]);
}));

test("actual FFF 0.10.5 factory registers only approved tool names; multi-grep needs explicit opt-in", async (t) => fixture(async (agentDir, cwd) => {
  const path = process.env.PI_SUBAGENTS_FFF_EXTENSION_PATH;
  if (!path) { t.skip("set PI_SUBAGENTS_FFF_EXTENSION_PATH to isolated installed package src/index.ts"); return; }
  const result = await probeApprovedResources({ agentDir, cwd, approved: ["fff"], fffPath: path });
  const expected = process.env.PI_FFF_MULTIGREP === "1" ? ["fffind", "ffgrep", "fff-multi-grep"] : ["fffind", "ffgrep"];
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.tools.sort(), expected.sort());
  assert.deepEqual(await readdir(agentDir), ["agents"]);
}));

test("all four canonical loadouts fail closed before factory execution or provider calls", async () => fixture(async (agentDir, cwd) => {
  const required = {
    researcher: { ...available, tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research", "headroom"], skills: ["my-web-search"] },
    "code-mapper": available,
    builder: { ...available, tools: [...available.tools, "edit", "write"], skills: ["code-review"] },
    reviewer: { ...available, skills: ["code-review"] },
  };
  let factoryCalls = 0, providerCalls = 0;
  for (const [role, resources] of Object.entries(required)) {
    await install(agentDir, role);
    const result = await createTrustedRoleBackend({ role, agentDir, cwd, model: "offline-fixture/offline", provider: provider(() => { providerCalls++; }), available: resources,
      extensionFactories: { unapproved: () => { factoryCalls++; throw Error("unapproved factory"); } } });
    assert.deepEqual(result, { ok: false, code: "unsupported_routing" }, role);
  }
  assert.equal(factoryCalls, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual((await readdir(agentDir)).sort(), ["agents"]);
}));
