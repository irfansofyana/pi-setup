import test from "node:test";
import assert from "node:assert/strict";
import headroom, { DEFAULT_CONFIG } from "./index.ts";
import { childRouting } from "./child-route.ts";

test("parent publishes public-registry child routing, readiness and canonical upstream without private SDK shape", async () => {
  const handlers: Record<string, any> = {};
  const upstream = "https://api.openai.com/v1";
  const model: any = { provider: "openai", id: "fixture", api: "openai-responses", baseUrl: upstream };
  const registry: any = { getAvailable: () => [model], getRegisteredProviderIds: () => [], find: () => model };
  let ready = true;
  headroom({ on: (name, handler) => { handlers[name] = handler; }, registerTool() {}, registerCommand() {},
    registerProvider(_name, config) { model.baseUrl = config.baseUrl; }, unregisterProvider() { model.baseUrl = upstream; },
  } as any, { readConfig: () => ({ ...DEFAULT_CONFIG, startup: "auto" }), health: async () => ready,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
    ensureDirs() {}, cleanupStore() {}, configuredProviderIds: () => new Set(),
  } as any);
  const ctx: any = { modelRegistry: registry, hasUI: false };
  assert.equal(childRouting(registry), undefined);
  await handlers.session_start({}, ctx);
  const routing = childRouting(registry)!;
  assert.equal(routing.canonical("openai", "fixture")?.baseUrl, upstream);
  assert.equal((await routing.route("openai", "fixture"))?.baseUrl, "http://127.0.0.1:8787/v1");
  ready = false; assert.equal(await routing.route("openai", "fixture"), undefined);
  ready = true; model.baseUrl = "https://drift.example";
  assert.equal(routing.canonical("openai", "fixture"), undefined); assert.equal(await routing.route("openai", "fixture"), undefined);
  model.baseUrl = "http://127.0.0.1:8787/v1";
  await handlers.session_shutdown({}, ctx);
  assert.equal(model.baseUrl, upstream); assert.equal(childRouting(registry), undefined);
});
