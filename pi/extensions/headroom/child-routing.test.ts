import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import headroom, { acquireHeadroomChildRoute, headroomChildBridgeSupported, DEFAULT_CONFIG } from "./index.ts";
import { createTrustedRoleBackend } from "../subagents/trusted.ts";

async function fixture(fn: (fixture: { home: string; registry: ModelRegistry; proxyUrl: string; start: () => Promise<void>; stop: () => Promise<void>; setReady: (ready: boolean) => void; requests: string[] }) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "headroom-child-route-"));
  let ready = true;
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ service: "headroom-proxy", ready, checks: { upstream: { ready } } }));
  });
  const requests: string[] = [];
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => {} } });
  await runtime.setRuntimeApiKey("openai", "offline-fixture-not-a-secret");
  const registry = new ModelRegistry(runtime);
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = { registerProvider: (id: string, config: any) => runtime.registerProvider(id, config), unregisterProvider: (id: string) => runtime.unregisterProvider(id),
    on: (name: string, handler: (...args: any[]) => any) => { handlers[name] = handler; }, registerTool() {}, registerCommand() {}, getSessionName() {} };
  const ctx = { cwd: home, hasUI: false, modelRegistry: registry, ui: { notify() {}, setStatus() {} } };
  headroom(pi as any, { readConfig: () => ({ ...DEFAULT_CONFIG, proxyUrl, startup: "auto", localToolResultCompression: false }),
    health: async () => true, proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
    ensureDirs() {}, cleanupStore() {}, configuredProviderIds: () => new Set() } as any);
  try {
    await fn({ home, registry, proxyUrl, start: async () => { await handlers.session_start({}, ctx); }, stop: async () => { await handlers.session_shutdown({}, ctx); },
      setReady: value => { ready = value; }, requests });
  } finally { server.close(); await rm(home, { recursive: true, force: true }); }
}

test("private Pi runtime shape drift refuses acquisition instead of throwing or mutating routing", async () => fixture(async ({ registry, proxyUrl, start, stop, requests }) => {
  await start();
  const runtime = registry.runtime as any;
  const getConfig = runtime.getRegisteredProviderConfig;
  runtime.getRegisteredProviderConfig = undefined;
  try {
    assert.deepEqual(await acquireHeadroomChildRoute({ registry, model, proxyUrl }), { ok: false, code: "unsupported_routing" });
    assert.deepEqual(requests, []);
  } finally { runtime.getRegisteredProviderConfig = getConfig; await stop(); }
}));

test("missing release capability rejects before readiness or reference acquisition", async () => fixture(async ({ registry, proxyUrl, start, stop, requests }) => {
  await start();
  const shared = (globalThis as any)[Symbol.for("pi-headroom-routing-state")].get(registry.runtime);
  const unregister = shared.unregisterProvider;
  shared.unregisterProvider = undefined;
  try {
    assert.deepEqual(await acquireHeadroomChildRoute({ registry, model, proxyUrl }), { ok: false, code: "unsupported_routing" });
    assert.deepEqual(requests, []);
  } finally { shared.unregisterProvider = unregister; await stop(); }
}));

const model = "openai/gpt-4";

test("unready proxy, wrong model and remote route never acquire a child lease", async () => fixture(async ({ registry, proxyUrl, start, stop, setReady, requests }) => {
  await start();
  assert.deepEqual(await acquireHeadroomChildRoute({ registry, model: "openai/unknown", proxyUrl }), { ok: false, code: "unsupported_routing" });
  assert.deepEqual(await acquireHeadroomChildRoute({ registry, model, proxyUrl: "https://upstream.example" }), { ok: false, code: "unsupported_routing" });
  assert.deepEqual(requests, []);
  setReady(false);
  assert.deepEqual(await acquireHeadroomChildRoute({ registry, model, proxyUrl }), { ok: false, code: "unsupported_routing" });
  assert.deepEqual(requests, ["/readyz"]);
  await stop();
  assert.equal(registry.find("openai", "gpt-4")?.baseUrl, "https://api.openai.com/v1");
}));

test("a failed post-acquire readiness check blocks use and release is idempotent", async () => fixture(async ({ registry, proxyUrl, start, stop, setReady }) => {
  await start();
  const result = await acquireHeadroomChildRoute({ registry, model, proxyUrl });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  setReady(false);
  assert.equal(await result.lease.ready(), false);
  await stop();
  await result.lease.release();
  await result.lease.release();
  assert.equal(await result.lease.ready(), false);
  assert.equal(registry.find("openai", "gpt-4")?.baseUrl, "https://api.openai.com/v1");
}));

test("child bridge admits only audited Pi version and already-owned exact proxy route", async () => fixture(async ({ registry, proxyUrl, start, stop, requests }) => {
  assert.equal(headroomChildBridgeSupported("1.1.0"), true);
  assert.equal(headroomChildBridgeSupported("1.0.0"), false);
  assert.equal(headroomChildBridgeSupported("1.1.1"), false);
  assert.deepEqual(await acquireHeadroomChildRoute({ registry, model, proxyUrl }), { ok: false, code: "unsupported_routing" });
  await start();
  const acquired = await acquireHeadroomChildRoute({ registry, model, proxyUrl });
  assert.equal(acquired.ok, true, JSON.stringify({ acquired, route: registry.find("openai", "gpt-4")?.baseUrl, registered: registry.getRegisteredProviderIds(), config: registry.runtime.getRegisteredProviderConfig("openai") }));
  if (!acquired.ok) return;
  assert.equal(await acquired.lease.ready(), true);
  assert.equal((await fetch(`${registry.find("openai", "gpt-4")?.baseUrl}/models`)).ok, true);
  assert.deepEqual(requests, ["/readyz", "/readyz", "/v1/models"]);
  await stop();
  assert.equal(registry.find("openai", "gpt-4")?.baseUrl, `${proxyUrl}/v1`);
  await acquired.lease.release();
  assert.equal(registry.find("openai", "gpt-4")?.baseUrl, "https://api.openai.com/v1");
  assert.equal(await acquired.lease.ready(), false);
}));

test("an available parent route alone does not authorize Ciung without child request ownership", async () => fixture(async ({ home, registry, proxyUrl, start, stop, requests }) => {
  await mkdir(join(home, "agents"));
  await writeFile(join(home, "agents", "researcher.md"), await readFile(new URL("../../agents/researcher.md", import.meta.url), "utf8"));
  await start();
  const route = `${proxyUrl}/v1`;
  assert.equal(registry.find("openai", "gpt-4")?.baseUrl, route);
  let providerCalls = 0, factoryCalls = 0;
  const result = await createTrustedRoleBackend({ role: "researcher", agentDir: home, cwd: home, model,
    provider: { id: "openai", stream: () => { providerCalls++; throw Error("provider called"); } } as any,
    available: { models: [model], tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research", "headroom"], skills: ["my-web-search"] },
    extensionFactories: { unapproved: () => { factoryCalls++; throw Error("factory called"); } },
    registry, proxyUrl,
  } as any);
  assert.deepEqual(result, { ok: false, code: "unsupported_routing" });
  assert.equal(providerCalls, 0);
  assert.equal(factoryCalls, 0);
  assert.deepEqual(requests, []);
  assert.equal(registry.find("openai", "gpt-4")?.baseUrl, route);
  await stop();
  assert.equal(registry.find("openai", "gpt-4")?.baseUrl, "https://api.openai.com/v1");
}));
