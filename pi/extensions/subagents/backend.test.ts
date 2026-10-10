import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createNativeBackend,createEvaluatorBackend } from "./backend.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveContext } from "./context.ts";

const model = { id: "offline", name: "Offline", provider: "offline-fixture", api: "offline-fixture", baseUrl: "offline://fixture", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 1000 } as const;
export function provider(observe: (context: any, options: any) => void, pause?: () => Promise<void>, fail = false) {
  let calls = 0;
  return { id: model.provider, name: "offline fixture", auth: { apiKey: { name: "offline fixture", async check() { return { type: "api_key" as const }; }, async resolve() { return { auth: { apiKey: "not-a-real-key" } }; } } }, getModels: () => [model], stream: stream, streamSimple: stream };
  function stream(_model: unknown, context: any, options: any) {
    const result = createAssistantMessageEventStream();
    const index = ++calls;
    queueMicrotask(async () => {
      try {
        observe(context, options);
        if (pause) await pause();
        const text = index === 1 ? "Reading fixture" : "Found fixture";
        const tool = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "fixture.txt" } };
        const partial: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: index === 1 ? "toolUse" : "stop", timestamp: Date.now() };
        if (options.signal?.aborted) { result.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } }); return; }
        if (fail) { result.push({ type: "error", reason: "error", error: { ...partial, stopReason: "error", errorMessage: "fixture failure" } }); return; }
        result.push({ type: "start", partial });
        partial.content.push({ type: "text", text });
        result.push({ type: "text_start", contentIndex: 0, partial });
        result.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
        result.push({ type: "text_end", contentIndex: 0, content: text, partial });
        if (index === 1) { partial.content.push(tool); result.push({ type: "toolcall_start", contentIndex: 1, partial }); result.push({ type: "toolcall_end", contentIndex: 1, toolCall: tool, partial }); }
        result.push({ type: "done", reason: partial.stopReason, message: partial });
      } catch (error) { result.end(); throw error; }
    });
    return result;
  }
}

async function fixture(fn: (dirs: { home: string; cwd: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "subagent-m1-"));
  const home = join(root, "home"), cwd = join(root, "cwd");
  const { mkdir } = await import("node:fs/promises");
  try { await mkdir(home); await mkdir(cwd); await writeFile(join(cwd, "fixture.txt"), "approved fixture\n"); await fn({ home, cwd }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("dedicated evaluator accepts an exact provider with only read-only tools and no ambient factories",async()=>fixture(async({home,cwd})=>{
  const opened=await createEvaluatorBackend({agentDir:home,cwd,model:"offline-fixture/offline",provider:provider(()=>{})});
  assert.equal(opened.ok,true);if(!opened.ok)return;
  try{assert.deepEqual(opened.backend.activeTools.sort(),["find","grep","ls","read"]);assert.equal((await opened.backend.run("Evaluate fixture",()=>{})).outcome,"completed");}
  finally{await opened.backend.dispose();}
}));

test("native SDK streams read-only text/tool events and settles once without child writes", async () => fixture(async ({ home, cwd }) => {
  const requests: any[] = [];
  const opened = await createNativeBackend({ agentDir: home, cwd, model: "offline-fixture/offline", provider: provider((context, options) => requests.push({ context, options })) });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const backend = opened.backend;
  try {
    assert.deepEqual(backend.activeTools, ["read"]);
    const events: any[] = [];
    const result = await backend.run("Read fixture.txt", event => events.push(event));
    assert.equal(result.outcome, "completed");
    assert.equal(events.filter(e => e.type === "agent_settled").length, 1);
    assert.ok(events.some(e => e.type === "message_update"));
    assert.ok(events.some(e => e.type === "tool_execution_start" && e.toolName === "read"));
    assert.ok(events.some(e => e.type === "tool_execution_end" && !e.isError && JSON.stringify(e.result).includes("approved fixture")));
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.context.messages.some((m: any) => m.role === "system")));
    assert.deepEqual(await readdir(home), []);
    assert.deepEqual(await readdir(cwd), ["fixture.txt"]);
  } finally { await backend.dispose(); }
}));

test("settled provider error is failed, never completed", async () => fixture(async ({ home, cwd }) => {
  const opened = await createNativeBackend({ agentDir: home, cwd, model: "offline-fixture/offline", provider: provider(() => {}, undefined, true) });
  assert.equal(opened.ok, true); if (!opened.ok) return;
  try {
    const events: any[] = [];
    assert.deepEqual(await opened.backend.run("Read fixture.txt", e => events.push(e)), { outcome: "failed", complete: false });
    assert.equal(events.filter(e => e.type === "agent_settled").length, 1);
  } finally { await opened.backend.dispose(); }
}));

test("unapproved provider and resources fail closed before construction", async () => fixture(async ({ home, cwd }) => {
  const options = { agentDir: home, cwd, model: "offline-fixture/offline", provider: provider(() => {}) };
  assert.deepEqual(await createNativeBackend({ ...options, model: "other/model" }), { ok: false, code: "unsupported_provider" });
  assert.deepEqual(await createNativeBackend({ ...options, tools: ["read", "bash"] }), { ok: false, code: "unsupported_resource" });
  assert.deepEqual(await createNativeBackend({ ...options, extensions: ["headroom"] }), { ok: false, code: "unsupported_resource" });
  assert.deepEqual(await readdir(home), []);
}));

test("context-only message does not start a model turn and reports no proven application", async () => fixture(async ({ home, cwd }) => {
  const opened = await createNativeBackend({ agentDir: home, cwd, model: "offline-fixture/offline", provider: provider(() => {}) });
  assert.equal(opened.ok, true); if (!opened.ok) return;
  try {
    assert.deepEqual(await opened.backend.control({ operation: "follow_up", message: "again" }), { status: "rejected", code: "unsupported_operation" });
    assert.deepEqual(await opened.backend.message("background note"), { status: "unknown_delivery" });
    assert.equal(opened.backend.isStreaming, false);
  } finally { await opened.backend.dispose(); }
}));

test("steer rejects idle run; abort is cooperative and never reports completion", async () => fixture(async ({ home, cwd }) => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opened = await createNativeBackend({ agentDir: home, cwd, model: "offline-fixture/offline", provider: provider(() => entered(), () => gate) });
  assert.equal(opened.ok, true); if (!opened.ok) return;
  try {
    assert.deepEqual(await opened.backend.steer("idle"), { status: "rejected", code: "not_running" });
    const running = opened.backend.run("Read fixture.txt", () => {});
    await started;
    assert.deepEqual(await opened.backend.steer("Please stop"), { status: "queued" });
    const abort = opened.backend.abort();
    release();
    await abort;
    const outcome = await running;
    assert.equal(outcome.outcome, "interrupted");
    assert.equal(outcome.complete, false);
  } finally { release(); await opened.backend.dispose(); }
}));

test("native offline SDK uses selected source anchor without inheriting tools/model or abandoned branch", async () => fixture(async ({ home, cwd }) => {
  const source = SessionManager.inMemory(cwd);
  const anchor = source.appendMessage({ role: "user", content: "selected public context", timestamp: 1 });
  const abandoned = source.appendMessage({ role: "user", content: "abandoned private context", timestamp: 2 });
  source.branch(anchor);
  source.appendMessage({ role: "user", content: "active later context", timestamp: 3 });
  const request = { mode: "snapshot" as const, sourceSessionId: source.getSessionId(), branchLeafId: source.getLeafId()!, entryAnchorId: anchor };
  const selected = resolveContext(request, () => source, "code-mapper");
  assert.equal(selected.ok, true); if (!selected.ok) return;
  const requests: any[] = [];
  const opened = await createNativeBackend({ agentDir: home, cwd, model: "offline-fixture/offline", provider: provider(ctx => requests.push(ctx)), context: selected.snapshot });
  assert.equal(opened.ok, true); if (!opened.ok) return;
  try {
    assert.deepEqual(opened.backend.activeTools, ["read"]);
    assert.equal((await opened.backend.run("Read fixture.txt", () => {})).outcome, "completed");
    assert.equal(opened.backend.hasRetainedContext(), true);
    const rendered = JSON.stringify(requests[0]);
    assert.match(rendered, /selected public context/);
    assert.doesNotMatch(rendered, /abandoned private context|active later context/);
    assert.deepEqual(await readdir(home), []);
    assert.deepEqual(await readdir(cwd), ["fixture.txt"]);
  } finally { await opened.backend.dispose(); assert.equal(opened.backend.hasRetainedContext(), false); }
  assert.deepEqual(resolveContext({ ...request, entryAnchorId: abandoned }, () => source, "code-mapper"), { ok: false, code: "invalid_context" });
}));
