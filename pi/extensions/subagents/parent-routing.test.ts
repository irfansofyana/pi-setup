import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { parentProvider } from "./parent-provider.ts";
import { publishChildRouting } from "../headroom/child-route.ts";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustedRoleBackend } from "./trusted.ts";

function fixture() {
  const model: any = { provider: "custom", id: "chosen", api: "openai-codex-responses", baseUrl: "https://upstream.example/backend-api", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let ready = true, key = "first", attempts = 0, fail = false;
  const calls: any[] = [], warnings: string[] = [];
  const stream = (model: any, _context: any, options: any) => {
    attempts++; calls.push({ model, options }); const result = createAssistantMessageEventStream();
    queueMicrotask(() => { const message: any = { role: "assistant", content: [{ type: "text", text: "answer" }], ...model, timestamp: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: fail ? "error" : "stop", ...(fail ? { errorMessage: "503 Service unavailable" } : {}) };
      result.push(fail ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message });
      if (fail) { fail = false; ready = false; }
    }); return result;
  };
  const registry: any = { find: () => ({ ...model, baseUrl: "http://127.0.0.1:8787/backend-api" }),
    getProvider: () => ({ id: "custom", name: "Custom", stream, streamSimple: stream }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: key, headers: { "chatgpt-account-id": key, "X-Headroom-Base-Url": "untrusted" }, env: { REGION: "fixture" } }) };
  const unpublish = publishChildRouting(registry, { canonical: () => model, route: async () => ready ? { baseUrl: "http://127.0.0.1:8787/backend-api", upstream: "https://upstream.example/backend-api" } : undefined });
  const provider = parentProvider(registry, "custom/chosen", { routing: "headroom-preferred", warn: message => warnings.push(message) });
  return { provider, model, registry, unpublish, calls, warnings, ready(value: boolean) { ready = value; }, key(value: string) { key = value; }, fail() { fail = true; }, attempts: () => attempts };
}

test("preferred route preserves parent OAuth/headers and refreshes auth on every request", async () => {
  const f = fixture();
  try {
    await f.provider.streamSimple(f.model, {} as any, { apiKey: "stale" } as any).result();
    assert.equal(f.calls[0].model.baseUrl, "http://127.0.0.1:8787/backend-api");
    assert.equal(f.calls[0].options.apiKey, "first");
    assert.equal(f.calls[0].options.headers["chatgpt-account-id"], "first");
    assert.equal(f.calls[0].options.headers["x-headroom-base-url"], "https://upstream.example/backend-api");
    assert.equal(f.calls[0].options.transport, "sse");
    f.key("refreshed"); f.ready(false);
    await f.provider.streamSimple(f.model, {} as any).result();
    assert.equal(f.calls[1].model.baseUrl, f.model.baseUrl);
    assert.equal(f.calls[1].options.apiKey, "refreshed");
    assert.equal(Object.keys(f.calls[1].options.headers).some(key => key.toLowerCase() === "x-headroom-base-url"), false);
    assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /direct.*upstream/i);
    await f.provider.streamSimple(f.model, {} as any).result(); assert.equal(f.warnings.length, 1);
    f.ready(true); await f.provider.streamSimple(f.model, {} as any).result();
    assert.equal(f.calls[3].model.baseUrl, "http://127.0.0.1:8787/backend-api");
  } finally { f.unpublish(); }
});

test("an already-submitted failed proxy request is never replayed upstream", async () => {
  const f = fixture();
  try { f.fail(); const result = await f.provider.stream(f.model, {} as any).result(); assert.equal(result.stopReason, "error"); assert.equal(f.attempts(), 1); }
  finally { f.unpublish(); }
});

test("missing Headroom capability warns and uses the exact native provider without guessing a proxy", async () => {
  const f = fixture(); f.unpublish(); f.registry.find = () => f.model;
  const warnings: string[] = [];
  const provider = parentProvider(f.registry, "custom/chosen", { routing: "headroom-preferred", warn: message => warnings.push(message) });
  await provider.streamSimple(f.model, {} as any).result();
  assert.equal(f.calls[0].model.baseUrl, f.model.baseUrl); assert.equal(warnings.length, 1);
});

test("an actual SDK child never auto-retries a failed proxy request directly upstream", async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(),"no-replay-sdk-"));
  let backend: any;
  try {
    await mkdir(join(root,"agents"));
    await copyFile(new URL("./test-fixtures/legacy-researcher.txt",import.meta.url),join(root,"agents/researcher.md"));
    const result = await createTrustedRoleBackend({ role: "researcher", agentDir: root, cwd: root, model: "custom/chosen", routing: "native", provider: f.provider,
      available: { models: ["custom/chosen"], tools: ["ext:web-research/web_search","ext:web-research/web_fetch"], extensions: ["web-research"], skills: ["my-web-search"] } });
    assert.equal(result.ok,true); if (!result.ok) return; backend = result.backend;
    f.fail(); const events: any[] = [];
    const outcome = await backend.run("Answer without tools", (event: any) => events.push(event));
    assert.equal(outcome.outcome,"failed");
    assert.equal(f.attempts(),1); assert.equal(events.some(event=>event.type==="auto_retry_start"),false);
    assert.equal(f.calls[0].model.baseUrl,"http://127.0.0.1:8787/backend-api");
    assert.equal(f.calls[0].options.maxRetries,0,"the actual SDK also disables provider-level retries");
  } finally { await backend?.dispose(); f.unpublish(); await rm(root,{recursive:true,force:true}); }
});
