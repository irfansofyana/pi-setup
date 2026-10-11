import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createTrustedRoleBackend } from "./trusted.ts";
import { createAgentRegistry, resolveAgentDefinition } from "./registry.ts";

const model: any = { id: "model", provider: "managed-fixture", name: "Offline", api: "managed-fixture", baseUrl: "offline://fixture", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 256 };
function provider(observe: (context: any) => void) {
  const stream = (_model: any, context: any) => {
    observe(context); const output = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "managed answer" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      output.push({ type: "start", partial: message }); output.push({ type: "done", reason: "stop", message });
    }); return output;
  };
  return { id: model.provider, name: "Offline", auth: { apiKey: { name: "fixture", async check() { return { type: "api_key" as const }; }, async resolve() { return { auth: { apiKey: "fixture-only" } }; } } }, getModels: () => [model], stream, streamSimple: stream };
}

test("custom type executes with its exact snapshot and no legacy global definition", async t => {
  const root = await mkdtemp(`${tmpdir()}/managed-backend-`); t.after(() => rm(root, { recursive: true, force: true }));
  const definition = resolveAgentDefinition({ name: "worker", description: "General bounded helper", systemPrompt: "Unique custom role instruction", tools: { allow: ["read"] } }, { model: "managed-fixture/model", models: ["managed-fixture/model"] });
  const observed: any[] = [];
  const result = await createTrustedRoleBackend({ role: "worker", agentDir: root, cwd: root, model: "managed-fixture/model", routing: "native", provider: provider(context => observed.push(context)),
    available: { models: ["managed-fixture/model"], tools: ["read"], extensions: [], skills: [] }, definition } as any);
  assert.equal(result.ok, true, result.ok ? undefined : result.code); if (!result.ok) return;
  try {
    assert.deepEqual(result.backend.activeTools, ["read"]);
    assert.equal((await result.backend.run("Answer", () => {})).outcome, "completed");
    assert.match(JSON.stringify(observed[0]), /Unique custom role instruction/);
    assert.deepEqual(await readdir(root), []);
  } finally { await result.backend.dispose(); }
});

test("native custom delegation exposes only explicitly reviewed verbs and rejects substitute core tools",async t=>{
  const root=await mkdtemp(`${tmpdir()}/managed-delegation-`);t.after(()=>rm(root,{recursive:true,force:true}));
  const definition=resolveAgentDefinition({name:"coordinator",description:"Scoped delegate",systemPrompt:"Bounded",tools:{allow:["agent_status"]}},{model:"managed-fixture/model",models:["managed-fixture/model"]});
  const tool:any={name:"agent_status",label:"Status",description:"Scoped status",parameters:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:"[]"}]})};
  const options:any={role:"coordinator",agentDir:root,cwd:root,model:"managed-fixture/model",routing:"native",provider:provider(()=>{}),definition,
    available:{models:["managed-fixture/model"],tools:["agent_status"],extensions:[],skills:[]}};
  assert.equal((await createTrustedRoleBackend(options)).ok,false,"missing scoped adapter fails closed");
  assert.equal((await createTrustedRoleBackend({...options,childTools:[{...tool,name:"read"}]})).ok,false);
  const opened=await createTrustedRoleBackend({...options,childTools:[tool]});assert.equal(opened.ok,true,opened.ok?undefined:opened.code);
  if(opened.ok)try{assert.deepEqual(opened.backend.activeTools,["agent_status"]);assert.equal((await opened.backend.run("Answer",()=>{})).complete,true);}finally{await opened.backend.dispose();}
});

test("bundled researcher tool reductions remove excluded callable extension tools", async t => {
  const root = await mkdtemp(`${tmpdir()}/managed-tools-`); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentRegistry({ cwd: root, agentDir: root, includeProject: false });
  const definition = resolveAgentDefinition({ ...store.get("researcher"), tools: { allow: ["web_search"] } }, { model: "managed-fixture/model", models: ["managed-fixture/model"] });
  const result = await createTrustedRoleBackend({ role: "researcher", agentDir: root, cwd: root, model: "managed-fixture/model", routing: "native", provider: provider(() => {}),
    available: { models: ["managed-fixture/model"], tools: ["ext:web-research/web_search"], extensions: ["web-research"], skills: ["my-web-search"] }, definition } as any);
  assert.equal(result.ok, true, result.ok ? undefined : result.code); if (!result.ok) return;
  try { assert.deepEqual(result.backend.activeTools, ["web_search"]); }
  finally { await result.backend.dispose(); }
});

test("child pause stops at the tool boundary without another model request and retains context", async t => {
  const root=await mkdtemp(`${tmpdir()}/managed-pause-`);t.after(()=>rm(root,{recursive:true,force:true}));
  let paused=false,calls=0;
  const base=provider(()=>{});
  const stream=()=>{
    const result=createAssistantMessageEventStream(),first=++calls===1;
    queueMicrotask(()=>{const message:any={role:"assistant",api:model.api,provider:model.provider,model:model.id,
      content:first?[{type:"toolCall",id:"pause-1",name:"agent_pause",arguments:{reason:"Need parent input"}}]:[{type:"text",text:"resumed"}],
      usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?"toolUse":"stop",timestamp:Date.now()};
      result.push({type:"start",partial:message});result.push({type:"done",reason:message.stopReason,message});});return result;
  };
  const definition=resolveAgentDefinition({name:"worker",description:"Custom",systemPrompt:"Bounded task"},{model:"managed-fixture/model",models:["managed-fixture/model"]});
  const opened=await createTrustedRoleBackend({role:"worker",agentDir:root,cwd:root,model:"managed-fixture/model",routing:"native",provider:{...base,stream,streamSimple:stream},
    available:{models:["managed-fixture/model"],tools:[],extensions:[],skills:[]},definition,shouldPause:()=>paused,
    childTools:[{name:"agent_pause",label:"Pause",description:"Checkpoint",parameters:{type:"object",properties:{reason:{type:"string"}},required:["reason"]},execute:async()=>{paused=true;return{content:[{type:"text",text:"Paused"}],terminate:true};}}]}as any);
  assert.equal(opened.ok,true,opened.ok?undefined:opened.code);if(!opened.ok)return;
  try{
    const first=await opened.backend.run("Pause for input",()=>{});
    assert.equal(first.complete,false);assert.equal(first.outcome,"completed");assert.equal(calls,1);
    assert.equal(opened.backend.hasRetainedContext(),true);
    paused=false;assert.equal((await opened.backend.run("Continue",()=>{})).complete,true);assert.equal(calls,2);
  }finally{await opened.backend.dispose();}
});

test("bundled local roles initialize with built-ins and no companion or external skills", async t => {
  const root = await mkdtemp(`${tmpdir()}/native-core-resources-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentRegistry({ agentDir: root, cwd: root });
  for (const role of ["scout", "reviewer"]) {
    const definition = resolveAgentDefinition(store.get(role), { model: "managed-fixture/model", models: ["managed-fixture/model"], availableTools: [] });
    assert.deepEqual(definition.loadout.extensions, []);
    assert.deepEqual(definition.loadout.skills, []);
    const opened = await createTrustedRoleBackend({ role, agentDir: root, cwd: root, model: "managed-fixture/model", routing: "native", provider: provider(() => {}), definition,
      available: { tools: ["read", "grep", "find", "ls"], extensions: [], skills: [], models: ["managed-fixture/model"] } });
    assert.equal(opened.ok, true, opened.ok ? undefined : opened.code);
    if (!opened.ok) continue;
    try {
      assert.deepEqual(opened.backend.activeTools.sort(), ["find", "grep", "ls", "read"]);
      assert.equal((await opened.backend.run("Explain this repository", () => {})).complete, true);
    } finally { await opened.backend.dispose(); }
  }
});

test("parent FFF tools need no child package entrypoint or multi-grep environment flag", async t => {
  const root = await mkdtemp(`${tmpdir()}/native-parent-resources-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentRegistry({ agentDir: root, cwd: root });
  const definition = resolveAgentDefinition(store.get("scout"), { model: "managed-fixture/model", models: ["managed-fixture/model"], availableTools: ["ffgrep"] });
  const tool: any = { name: "ffgrep", label: "Search", description: "Parent search", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "match" }], details: {} }; } };
  const options = { role: "scout", agentDir: root, cwd: root, model: "managed-fixture/model", routing: "native" as const, provider: provider(() => {}), definition,
    available: { tools: ["read", "grep", "find", "ls", "ext:fff/ffgrep"], extensions: ["fff"], skills: [], models: ["managed-fixture/model"] } };
  const opened = await createTrustedRoleBackend({ ...options, parentTools: [tool] });
  assert.equal(opened.ok, true, opened.ok ? undefined : opened.code);
  if (!opened.ok) return;
  try { assert.deepEqual(opened.backend.activeTools.sort(), ["ffgrep", "find", "grep", "ls", "read"]); }
  finally { await opened.backend.dispose(); }
  assert.equal((await createTrustedRoleBackend({ ...options, parentTools: [{ ...tool, name: "bash" }] })).ok, false);
});

test("optional third-party tool failure is a tool result, not a child run failure", async t => {
  const root = await mkdtemp(`${tmpdir()}/native-optional-failure-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { parentSearchTools } = await import("./parent-resources.ts");
  const store = createAgentRegistry({ agentDir: root, cwd: root });
  const definition = resolveAgentDefinition(store.get("scout"), { model: "managed-fixture/model", models: ["managed-fixture/model"], availableTools: ["ffgrep"] });
  const parentTools = parentSearchTools({ cwd: root, tools: [{ name: "ffgrep", description: "Optional search", parameters: { type: "object" } }],
    async executeTool() { throw Error("third-party extension failure"); } });
  let calls = 0, sawToolError = false;
  const base = provider(() => {});
  const stream = (_model: any, context: any) => {
    calls++;
    if (calls > 1) sawToolError = context.messages.some((entry: any) => entry.role === "toolResult" && entry.isError === true);
    const output = createAssistantMessageEventStream();
    const response: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: calls === 1 ? [{ type: "toolCall", id: "optional-search", name: "ffgrep", arguments: {} }] : [{ type: "text", text: "Continue using built-in search" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: calls === 1 ? "toolUse" : "stop", timestamp: Date.now() };
    queueMicrotask(() => { output.push({ type: "start", partial: response }); output.push({ type: "done", reason: response.stopReason, message: response }); });
    return output;
  };
  const opened = await createTrustedRoleBackend({ role: "scout", agentDir: root, cwd: root, model: "managed-fixture/model", routing: "native", provider: { ...base, stream, streamSimple: stream }, definition, parentTools,
    available: { tools: ["read", "grep", "find", "ls", "ext:fff/ffgrep"], extensions: ["fff"], skills: [], models: ["managed-fixture/model"] } });
  assert.equal(opened.ok, true, opened.ok ? undefined : opened.code);
  if (!opened.ok) return;
  try {
    assert.equal((await opened.backend.run("Map repository", () => {})).complete, true);
    assert.equal(sawToolError, true);
    assert.equal(calls, 2);
    assert.ok(opened.backend.activeTools.includes("grep"));
  } finally { await opened.backend.dispose(); }
});
