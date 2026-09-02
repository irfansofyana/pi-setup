import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import headroom, {
  DEFAULT_CONFIG,
  buildCompressRequest,
  buildMarker,
  canRetainOriginal,
  canStartRuntime,
  contentWithText,
  createManagedProxyLifecycle,
  createStartCoordinator,
  enableRuntimeDecision,
  formatCount,
  hasSupportedProxyProtocol,
  headroomCompressionReadyFromPayload,
  headroomRoutingReadyFromPayload,
  headroomFailureText,
  headroomUpstreamBaseUrl,
  headroomReadyFromPayload,
  health,
  initialRuntimeEnabled,
  initialStats,
  isRemoteBlocked,
  normalizeHeadroomConfig,
  outputLooksSensitive,
  proxyBaseUrlForApi,
  proxyEndpoint,
  proxyProviderBaseUrls,
  planProxyProviderRoutes,
  retrieveWithQuery,
  savingsPercent,
  shouldCompressToolResult,
  shouldNotifyHeadroomFailure,
  statusText,
  terminateChildProcess,
  truncateText,
  waitForHealth,
  type StoredOriginal,
} from "./index.ts";

test("normalizeHeadroomConfig auto-starts Headroom by default", () => {
  assert.deepEqual(normalizeHeadroomConfig({}), DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.startup, "auto");
  assert.equal(normalizeHeadroomConfig({ minChars: 10 }).minChars, 10);
  assert.equal(normalizeHeadroomConfig({ minChars: -1 }).minChars, 1);
  assert.equal(normalizeHeadroomConfig({ startupHealthTimeoutMs: 60_000 }).startupHealthTimeoutMs, 60_000);
  assert.equal(normalizeHeadroomConfig({ startupHealthTimeoutMs: 1 }).startupHealthTimeoutMs, 5_000);
  assert.equal(normalizeHeadroomConfig({ startup: "auto" }).startup, "auto");
  assert.equal(normalizeHeadroomConfig({ notifyFailures: "always" }).notifyFailures, "always");
});

test("normalizeHeadroomConfig derives managed proxy bind from local proxyUrl", () => {
  const config = normalizeHeadroomConfig({ proxyUrl: "http://127.0.0.1:9999" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 9999);
});

test("normalizeHeadroomConfig keeps explicit host and port over proxyUrl-derived bind", () => {
  const config = normalizeHeadroomConfig({ proxyUrl: "http://127.0.0.1:9999", host: "0.0.0.0", port: 7777 });
  assert.equal(config.proxyUrl, "http://127.0.0.1:9999");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 7777);
});

test("normalizeHeadroomConfig does not derive managed bind from remote proxyUrl", () => {
  const config = normalizeHeadroomConfig({ proxyUrl: "https://example.com:9443" });
  assert.equal(config.host, DEFAULT_CONFIG.host);
  assert.equal(config.port, DEFAULT_CONFIG.port);
  assert.equal(isRemoteBlocked(config), true);
});

test("normalizeHeadroomConfig does not derive managed bind from non-http local proxyUrl", () => {
  const config = normalizeHeadroomConfig({ proxyUrl: "ftp://127.0.0.1:9999" });
  assert.equal(config.host, DEFAULT_CONFIG.host);
  assert.equal(config.port, DEFAULT_CONFIG.port);
  assert.equal(hasSupportedProxyProtocol(config.proxyUrl), false);
});

test("proxyEndpoint composes complete proxy URLs without duplicate slashes", () => {
  assert.equal(proxyEndpoint("http://127.0.0.1:8787", "/v1/compress"), "http://127.0.0.1:8787/v1/compress");
  assert.equal(proxyEndpoint("https://proxy.example/headroom/", "stats-history"), "https://proxy.example/headroom/stats-history");
  assert.deepEqual(proxyProviderBaseUrls("http://127.0.0.1:8787"), {
    openai: "http://127.0.0.1:8787/v1",
    anthropic: "http://127.0.0.1:8787",
    codex: "http://127.0.0.1:8787/v1",
  });
});

test("provider route planning covers built-ins and compatible custom gateways", () => {
  assert.equal(proxyBaseUrlForApi("http://127.0.0.1:8787", "openai-responses"), "http://127.0.0.1:8787/v1");
  assert.equal(proxyBaseUrlForApi("http://127.0.0.1:8787", "anthropic-messages"), "http://127.0.0.1:8787");
  assert.equal(proxyBaseUrlForApi("http://127.0.0.1:8787", "google-generative-ai"), undefined);
  assert.equal(proxyBaseUrlForApi("http://127.0.0.1:8787", "bedrock-converse-stream"), undefined);

  const plan = planProxyProviderRoutes("http://127.0.0.1:8787", [
    { id: "chat", provider: "litellm-openai", api: "openai-completions", baseUrl: "https://litellm.example/v1" },
    { id: "responses", provider: "litellm-openai", api: "openai-responses", baseUrl: "https://litellm.example/v1" },
    { id: "claude", provider: "litellm-anthropic", api: "anthropic-messages", baseUrl: "https://litellm.example" },
    { id: "bedrock", provider: "aws", api: "bedrock-converse-stream", baseUrl: "https://bedrock.example" },
  ]);

  assert.deepEqual([...plan.providers], [
    ["openai", "http://127.0.0.1:8787/v1"],
    ["anthropic", "http://127.0.0.1:8787"],
    ["openai-codex", "http://127.0.0.1:8787/v1"],
    ["litellm-openai", "http://127.0.0.1:8787/v1"],
    ["litellm-anthropic", "http://127.0.0.1:8787"],
  ]);
  assert.equal(headroomUpstreamBaseUrl("https://litellm.example/gateway/v1/"), "https://litellm.example/gateway");
  assert.equal(plan.upstreamByModel.get("litellm-openai\u0000chat"), "https://litellm.example");
  assert.equal(plan.upstreamByModel.get("litellm-anthropic\u0000claude"), "https://litellm.example");
  assert.equal(plan.providers.has("aws"), false);
});

test("provider route planning preserves custom upstreams under built-in provider IDs", () => {
  const plan = planProxyProviderRoutes("http://127.0.0.1:8787", [
    { id: "custom-openai", provider: "openai", api: "openai-responses", baseUrl: "https://litellm.example/v1" },
    { id: "custom-claude", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://litellm.example" },
  ]);
  assert.equal(plan.upstreamByModel.get("openai\u0000custom-openai"), "https://litellm.example");
  assert.equal(plan.upstreamByModel.get("anthropic\u0000custom-claude"), "https://litellm.example");
});

test("provider route planning skips custom providers with incompatible or unsupported models", () => {
  const plan = planProxyProviderRoutes("http://127.0.0.1:8787", [
    { id: "chat", provider: "mixed", api: "openai-completions", baseUrl: "https://gateway.example/v1" },
    { id: "claude", provider: "mixed", api: "anthropic-messages", baseUrl: "https://gateway.example" },
    { id: "supported", provider: "partly-supported", api: "openai-completions", baseUrl: "https://gateway.example/v1" },
    { id: "bedrock", provider: "partly-supported", api: "bedrock-converse-stream", baseUrl: "https://gateway.example" },
  ]);
  assert.equal(plan.providers.has("mixed"), false);
  assert.equal(plan.providers.has("partly-supported"), false);
  assert.equal(plan.upstreamByModel.size, 0);
});

test("initialRuntimeEnabled follows auto default while preserving manual and off overrides", () => {
  assert.equal(initialRuntimeEnabled(DEFAULT_CONFIG), true);
  assert.equal(initialRuntimeEnabled({ ...DEFAULT_CONFIG, startup: "manual" }), false);
  assert.equal(initialRuntimeEnabled({ ...DEFAULT_CONFIG, startup: "off" }), false);
  assert.equal(initialRuntimeEnabled({ ...DEFAULT_CONFIG, enabled: false, startup: "auto" }), false);
});

test("enableRuntimeDecision only enables after healthy proxy", () => {
  assert.deepEqual(enableRuntimeDecision(DEFAULT_CONFIG, false, "none"), {
    runtimeEnabled: false,
    owner: "none",
    reason: "proxy-unavailable",
  });
  assert.deepEqual(enableRuntimeDecision(DEFAULT_CONFIG, true, "none"), {
    runtimeEnabled: true,
    owner: "external",
  });
  assert.deepEqual(enableRuntimeDecision(DEFAULT_CONFIG, true, "none", true), {
    runtimeEnabled: true,
    owner: "managed",
  });
});

test("enableRuntimeDecision keeps startup off disabled", () => {
  assert.deepEqual(enableRuntimeDecision({ ...DEFAULT_CONFIG, startup: "off" }, true, "none"), {
    runtimeEnabled: false,
    owner: "none",
    reason: "startup-off",
  });
});

test("start runtime refuses startup off", () => {
  assert.equal(canStartRuntime({ ...DEFAULT_CONFIG, startup: "manual" }), true);
  assert.equal(canStartRuntime({ ...DEFAULT_CONFIG, startup: "off" }), false);
});

test("managed proxy lifecycle reports unexpected death after readiness", () => {
  const lifecycle = createManagedProxyLifecycle();
  lifecycle.markReady();

  assert.deepEqual(lifecycle.handleExit(17, null), {
    kind: "unexpected-exit",
    message: "Headroom managed proxy exited unexpectedly (code 17); compression disabled. Check /headroom logs.",
  });
});

test("managed proxy lifecycle reports exit before readiness as startup failure", () => {
  const lifecycle = createManagedProxyLifecycle();

  assert.deepEqual(lifecycle.handleExit(null, "SIGABRT"), {
    kind: "startup-exit",
    message: "Headroom proxy exited before becoming ready (signal SIGABRT); bypassing compression. Check /headroom logs.",
  });
});

test("managed proxy lifecycle reports spawn errors without waiting for timeout", () => {
  const lifecycle = createManagedProxyLifecycle();

  assert.deepEqual(lifecycle.handleSpawnError(new Error("spawn headroom ENOENT")), {
    kind: "spawn-error",
    message: "Headroom proxy failed to start: spawn headroom ENOENT. Bypassing compression. Run /headroom doctor or check /headroom logs.",
  });
});

test("managed proxy lifecycle suppresses intentional shutdown", () => {
  const lifecycle = createManagedProxyLifecycle();
  lifecycle.markReady();
  lifecycle.markStopping();

  assert.equal(lifecycle.handleExit(0, null), undefined);
});

test("managed proxy lifecycle emits only one terminal failure notice", () => {
  const lifecycle = createManagedProxyLifecycle();

  assert.ok(lifecycle.handleSpawnError(new Error("ENOENT")));
  assert.equal(lifecycle.handleExit(null, null), undefined);
});

test("managed proxy lifecycle reports startup timeout", () => {
  const lifecycle = createManagedProxyLifecycle();

  assert.deepEqual(lifecycle.handleTimeout(30_000), {
    kind: "startup-timeout",
    message: "Headroom proxy did not become healthy within 30000ms; bypassing compression. Check /headroom logs.",
  });
});

test("managed proxy startup is single-flight, cancellable, and restartable", async () => {
  const starts: string[] = [];
  const completions: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const coordinator = createStartCoordinator(async (attempt, label: string) => {
    starts.push(label);
    if (label === "first") await firstGate;
    if (attempt.isCurrent()) completions.push(label);
  });

  const first = coordinator.start("first");
  assert.equal(coordinator.start("duplicate"), first);
  const restarted = coordinator.restart("fresh");
  assert.deepEqual(starts, ["first"]);
  releaseFirst();
  await Promise.all([first, restarted]);
  assert.deepEqual(starts, ["first", "fresh"]);
  assert.deepEqual(completions, ["fresh"]);
});

test("lifecycle failures stay visible regardless of compression notification policy", () => {
  assert.equal(shouldNotifyHeadroomFailure("lifecycle", true, "never", true), true);
  assert.equal(shouldNotifyHeadroomFailure("lifecycle", true, "once", true), true);
  assert.equal(shouldNotifyHeadroomFailure("lifecycle", false, "always", false), false);
  assert.equal(shouldNotifyHeadroomFailure("compression", true, "never", false), false);
  assert.equal(shouldNotifyHeadroomFailure("compression", true, "once", true), false);
});

test("managed child termination waits for exit and fails closed when signals fail", async () => {
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    killed = false;
    signals: string[] = [];
    private readonly acceptsSignal: boolean;
    constructor(acceptsSignal: boolean) {
      super();
      this.acceptsSignal = acceptsSignal;
    }
    kill(signal: NodeJS.Signals) {
      this.signals.push(signal);
      if (!this.acceptsSignal) return false;
      this.killed = true;
      queueMicrotask(() => {
        this.exitCode = 0;
        this.emit("exit", 0, signal);
      });
      return true;
    }
  }

  const exits = new FakeChild(true);
  assert.equal(await terminateChildProcess(exits as any, 5), true);
  assert.deepEqual(exits.signals, ["SIGTERM"]);

  const stuck = new FakeChild(false);
  assert.equal(await terminateChildProcess(stuck as any, 1), false);
  assert.deepEqual(stuck.signals, ["SIGTERM", "SIGKILL"]);
});

test("managed child termination recognizes an already confirmed signal exit", async () => {
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: "SIGTERM",
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      return false;
    },
  });

  assert.equal(await terminateChildProcess(child as any, 1), true);
  assert.deepEqual(signals, []);
});

function createHeadroomHarness(
  dependencies: Record<string, unknown>,
  failProvider?: string,
  models: unknown[] = [],
  registeredProviderIds: string[] = [],
  runtime?: object,
) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const notices: Array<{ message: string; level: string }> = [];
  const statuses: string[] = [];
  const providers: Array<{ name: string; options: unknown }> = [];
  const unregisteredProviders: string[] = [];
  const pi = {
    registerProvider(name: string, options: unknown) {
      if (name === failProvider) throw new Error(`${name} registration failed`);
      providers.push({ name, options });
    },
    unregisterProvider(name: string) { unregisteredProviders.push(name); },
    on(name: string, handler: (...args: any[]) => any) { handlers[name] = handler; },
    registerCommand(name: string, command: any) { commands[name] = command; },
    registerTool(tool: any) { tools[tool.name] = tool; },
  };
  const ctx = {
    cwd: "/tmp/headroom-lifecycle-test",
    hasUI: true,
    modelRegistry: {
      getAvailable: () => models,
      getRegisteredProviderIds: () => registeredProviderIds,
      ...(runtime ? { runtime } : {}),
    },
    ui: {
      notify(message: string, level: string) { notices.push({ message, level }); },
      setStatus(_key: string, value: string) { statuses.push(value); },
    },
  };
  headroom(pi as any, {
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: true }),
    ensureDirs: () => {},
    cleanupStore: () => {},
    configuredProviderIds: () => new Set(models.flatMap((model) => {
      if (!model || typeof model !== "object") return [];
      const provider = (model as { provider?: unknown }).provider;
      return typeof provider === "string" ? [provider] : [];
    })),
    ...dependencies,
  } as any);
  return { handlers, commands, tools, notices, statuses, providers, unregisteredProviders, ctx };
}

test("session startup registers native provider endpoints with Headroom", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
  });
  assert.deepEqual(harness.providers, []);
  await harness.handlers.session_start({}, harness.ctx);
  assert.deepEqual(harness.providers, [
    { name: "openai", options: { baseUrl: "http://127.0.0.1:8787/v1" } },
    { name: "anthropic", options: { baseUrl: "http://127.0.0.1:8787" } },
    { name: "openai-codex", options: { baseUrl: "http://127.0.0.1:8787/v1" } },
  ]);
});

test("session startup routes compatible custom providers and preserves their upstream per model", async () => {
  const models = [
    { id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" },
    { id: "claude", provider: "litellm-claude", api: "anthropic-messages", baseUrl: "https://litellm.example" },
  ];
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
  }, undefined, models);

  await harness.handlers.session_start({}, harness.ctx);
  assert.deepEqual(harness.providers.slice(-2), [
    { name: "litellm", options: { baseUrl: "http://127.0.0.1:8787/v1" } },
    { name: "litellm-claude", options: { baseUrl: "http://127.0.0.1:8787" } },
  ]);

  const event = { headers: {} as Record<string, string | null> };
  await harness.handlers.before_provider_headers(event, { ...harness.ctx, model: models[0] });
  assert.equal(event.headers["x-headroom-base-url"], "https://litellm.example");
});

test("child session reuses parent routing despite existing provider ownership", async () => {
  const runtime = {};
  const models = [
    { id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" },
  ];
  const proxyHistory = async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } });
  const parent = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory,
  }, undefined, models, [], runtime);
  await parent.handlers.session_start({}, parent.ctx);

  const child = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory,
  }, undefined, models, ["openai", "anthropic", "openai-codex", "litellm"], runtime);
  await child.handlers.session_start({}, child.ctx);

  assert.deepEqual(child.providers, []);
  const event = { headers: {} as Record<string, string | null> };
  await child.handlers.before_provider_headers(event, { ...child.ctx, model: models[0] });
  assert.equal(event.headers["x-headroom-base-url"], "https://litellm.example");

  await child.handlers.session_shutdown({}, child.ctx);
  assert.deepEqual(parent.unregisteredProviders, []);
  assert.deepEqual(child.unregisteredProviders, []);
  await parent.handlers.session_shutdown({}, parent.ctx);
  assert.deepEqual(parent.unregisteredProviders, ["openai", "anthropic", "openai-codex", "litellm"]);
});

test("child refuses divergent shared provider routes", async () => {
  const runtime = {};
  const models = [{ id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" }];
  const parent = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false, proxyUrl: "http://127.0.0.1:8788" }),
    health: async () => true,
  }, undefined, models, [], runtime);
  await parent.handlers.session_start({}, parent.ctx);
  const child = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false, proxyUrl: "http://127.0.0.1:8789" }),
    health: async () => true,
  }, undefined, models, ["openai", "anthropic", "openai-codex", "litellm"], runtime);
  await child.handlers.session_start({}, child.ctx);

  assert.deepEqual(child.providers, []);
  await child.handlers.session_shutdown({}, child.ctx);
  await parent.handlers.session_shutdown({}, parent.ctx);
});

test("parent shutdown keeps shared routing alive until child shutdown", async () => {
  const runtime = {};
  const models = [
    { id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" },
  ];
  const dependencies = {
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
  };
  const parent = createHeadroomHarness(dependencies, undefined, models, [], runtime);
  await parent.handlers.session_start({}, parent.ctx);
  const child = createHeadroomHarness(dependencies, undefined, models, ["openai", "anthropic", "openai-codex", "litellm"], runtime);
  await child.handlers.session_start({}, child.ctx);

  await parent.handlers.session_shutdown({}, parent.ctx);
  assert.deepEqual(parent.unregisteredProviders, []);
  const event = { headers: {} as Record<string, string | null> };
  await child.handlers.before_provider_headers(event, { ...child.ctx, model: models[0] });
  assert.equal(event.headers["x-headroom-base-url"], "https://litellm.example");

  await child.handlers.session_shutdown({}, child.ctx);
  assert.deepEqual(parent.unregisteredProviders, ["openai", "anthropic", "openai-codex", "litellm"]);
});

test("shared managed proxy survives parent shutdown and stops after final child lease", async () => {
  const runtime = {};
  const child = Object.assign(new EventEmitter(), { pid: 8181, exitCode: null, signalCode: null, killed: false });
  let terminateCalls = 0;
  const parent = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    waitForHealth: async () => true,
    terminateChild: async () => { terminateCalls++; return true; },
  }, undefined, [{ id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" }], [], runtime);
  await parent.handlers.session_start({}, parent.ctx);
  const childSession = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
  }, undefined, [{ id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" }], ["openai", "anthropic", "openai-codex", "litellm"], runtime);
  await childSession.handlers.session_start({}, childSession.ctx);

  await parent.commands.headroom.handler("disable", parent.ctx);
  await parent.handlers.session_shutdown({}, parent.ctx);
  assert.equal(terminateCalls, 0);
  const event = { headers: {} as Record<string, string | null> };
  await childSession.handlers.before_provider_headers(event, { ...childSession.ctx, model: { id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" } });
  assert.equal(event.headers["x-headroom-base-url"], "https://litellm.example");
  await childSession.handlers.session_shutdown({}, childSession.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(terminateCalls, 1);
});

test("final child recovery releases retained managed proxy ownership", async () => {
  const runtime = {};
  const models = [{ id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" }];
  const child = Object.assign(new EventEmitter(), { pid: 8282, exitCode: null, signalCode: null, killed: false });
  let terminateCalls = 0;
  let childHealthy = true;
  const parent = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    waitForHealth: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
    terminateChild: async () => { terminateCalls++; return true; },
  }, undefined, models, [], runtime);
  await parent.handlers.session_start({}, parent.ctx);
  const childSession = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => childHealthy,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
  }, undefined, models, [], runtime);
  await childSession.handlers.session_start({}, childSession.ctx);
  childHealthy = false;
  await parent.handlers.session_shutdown({}, parent.ctx);
  assert.equal(terminateCalls, 0);

  await childSession.handlers.turn_start({}, childSession.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(terminateCalls, 1);
});

test("shared child disable restores native routing for runtime", async () => {
  const runtime = {};
  const models = [{ id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" }];
  const child = Object.assign(new EventEmitter(), { pid: 8384, exitCode: null, signalCode: null, killed: false });
  const parent = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    waitForHealth: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
  }, undefined, models, [], runtime);
  await parent.handlers.session_start({}, parent.ctx);
  const childSession = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
  }, undefined, models, [], runtime);
  await childSession.handlers.session_start({}, childSession.ctx);

  await childSession.commands.headroom.handler("disable", childSession.ctx);
  assert.deepEqual(parent.unregisteredProviders, ["openai", "anthropic", "openai-codex", "litellm"]);
  const event = { headers: {} as Record<string, string | null> };
  await parent.handlers.before_provider_headers(event, { ...parent.ctx, model: models[0] });
  assert.equal(event.headers["x-headroom-base-url"], undefined);
});

test("shutdown rechecks child leases acquired during stats finalization", async () => {
  const runtime = {};
  const models = [{ id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" }];
  const child = Object.assign(new EventEmitter(), { pid: 8484, exitCode: null, signalCode: null, killed: false });
  let healthCalls = 0;
  let historyCalls = 0;
  let terminateCalls = 0;
  let releaseFinalization!: () => void;
  let finalizationStarted!: () => void;
  const finalizationReady = new Promise<void>((resolve) => { finalizationStarted = resolve; });
  const parent = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => ++healthCalls > 1,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    waitForHealth: async () => true,
    proxyHistory: async () => {
      historyCalls++;
      if (historyCalls === 2) {
        finalizationStarted();
        await new Promise<void>((resolve) => { releaseFinalization = resolve; });
      }
      return { displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } };
    },
    terminateChild: async () => { terminateCalls++; return true; },
  }, undefined, models, [], runtime);
  await parent.handlers.session_start({}, parent.ctx);
  const shutdown = parent.handlers.session_shutdown({}, parent.ctx);
  await finalizationReady;

  const childSession = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
  }, undefined, models, [], runtime);
  await childSession.handlers.session_start({}, childSession.ctx);
  assert.deepEqual(childSession.providers, []);
  releaseFinalization();
  await shutdown;

  assert.equal(terminateCalls, 1);
  await childSession.handlers.session_shutdown({}, childSession.ctx);
  assert.equal(terminateCalls, 1);
});

test("child adopts retained managed proxy after parent disables routing", async () => {
  const runtime = {};
  const models = [{ id: "gpt", provider: "litellm", api: "openai-completions", baseUrl: "https://litellm.example/v1" }];
  const child = Object.assign(new EventEmitter(), { pid: 8383, exitCode: null, signalCode: null, killed: false });
  let terminateCalls = 0;
  const parent = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    waitForHealth: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
    terminateChild: async () => { terminateCalls++; return true; },
  }, undefined, models, [], runtime);
  await parent.handlers.session_start({}, parent.ctx);
  await parent.commands.headroom.handler("disable", parent.ctx);

  const childSession = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }),
  }, undefined, models, [], runtime);
  await childSession.handlers.session_start({}, childSession.ctx);
  assert.deepEqual(childSession.providers.map((provider) => provider.name), ["openai", "anthropic", "openai-codex", "litellm"]);

  await parent.handlers.session_shutdown({}, parent.ctx);
  assert.equal(terminateCalls, 0);
  const event = { headers: {} as Record<string, string | null> };
  await childSession.handlers.before_provider_headers(event, { ...childSession.ctx, model: models[0] });
  assert.equal(event.headers["x-headroom-base-url"], "https://litellm.example");
  await childSession.handlers.session_shutdown({}, childSession.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(terminateCalls, 1);
});

test("managed proxy can disable and re-enable routing without respawn", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 8282, exitCode: null, signalCode: null, killed: false });
  let healthCalls = 0;
  let spawnCalls = 0;
  let terminateCalls = 0;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => ++healthCalls > 1,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => { spawnCalls++; return child; },
    writePid: () => {},
    waitForHealth: async () => true,
    terminateChild: async () => { terminateCalls++; return true; },
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.commands.headroom.handler("disable", harness.ctx);
  await harness.commands.headroom.handler("enable", harness.ctx);
  assert.equal(spawnCalls, 1);
  assert.equal(terminateCalls, 0);
  await harness.commands.headroom.handler("stop", harness.ctx);
  assert.equal(terminateCalls, 1);
});

test("session startup leaves extension-owned custom providers native even with models.json overlap", async () => {
  const extensionModel = { id: "extension-model", provider: "extension-provider", api: "openai-completions", baseUrl: "https://extension.example/v1" };
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    configuredProviderIds: () => new Set(["extension-provider"]),
    health: async () => true,
  }, undefined, [extensionModel], ["extension-provider"]);

  await harness.handlers.session_start({}, harness.ctx);
  assert.equal(harness.providers.some((provider) => provider.name === "extension-provider"), false);
  await harness.commands.headroom.handler("disable", harness.ctx);
  assert.equal(harness.unregisteredProviders.includes("extension-provider"), false);
});

test("native routing fails closed when provider ownership API is unavailable", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
  });
  delete (harness.ctx.modelRegistry as { getRegisteredProviderIds?: () => readonly string[] }).getRegisteredProviderIds;

  await harness.handlers.session_start({}, harness.ctx);
  assert.deepEqual(harness.providers, []);
  assert.deepEqual(harness.unregisteredProviders, []);
  assert.ok(harness.notices.some((notice) => notice.message.includes("could not install Pi provider routing")));
});

test("legacy local mode does not install native provider overrides", async () => {
  const harness = createHeadroomHarness({ health: async () => true });
  await harness.handlers.session_start({}, harness.ctx);
  assert.deepEqual(harness.providers, []);
  assert.ok(harness.tools.headroom_retrieve);
});
test("manual startup defers native provider routing until start succeeds", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, startup: "manual", localToolResultCompression: false }),
    health: async () => true,
  });
  assert.deepEqual(harness.providers, []);
  await harness.commands.headroom.handler("start", harness.ctx);
  assert.deepEqual(harness.providers, [
    { name: "openai", options: { baseUrl: "http://127.0.0.1:8787/v1" } },
    { name: "anthropic", options: { baseUrl: "http://127.0.0.1:8787" } },
    { name: "openai-codex", options: { baseUrl: "http://127.0.0.1:8787/v1" } },
  ]);
});

test("proxy history populates native-routing session stats after baseline", async () => {
  let requests = 10;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => ({ displaySession: { requests, tokens_saved: requests * 300, total_input_tokens: requests * 200 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  requests = 13;
  const result = await harness.tools.headroom_stats.execute();
  assert.equal(result.details.proxyRequests, 3);
  assert.equal(result.details.compressions, 0);
  assert.equal(result.details.tokensSaved, 900);
  assert.equal(result.details.tokensBefore, 1500);
  assert.equal(result.details.tokensAfter, 600);
  await harness.commands.headroom.handler("disable", harness.ctx);
  requests = 20;
  const disabledResult = await harness.tools.headroom_stats.execute();
  assert.equal(disabledResult.details.proxyRequests, 3);
  assert.equal(disabledResult.details.compressions, 0);
  assert.equal(disabledResult.details.tokensSaved, 900);
});

test("proxy history backoff uses monotonic elapsed time", async () => {
  let monotonicNowMs = 1_000;
  let historyCalls = 0;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    monotonicNowMs: () => monotonicNowMs,
    health: async () => true,
    proxyHistory: async () => {
      historyCalls++;
      if (historyCalls === 1) return { displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 1 } };
      if (historyCalls === 2) return { error: "temporarily unavailable" };
      return { displaySession: { requests: 2, tokens_saved: 2, total_input_tokens: 2 } };
    },
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.handlers.turn_end({}, harness.ctx);
  assert.equal(historyCalls, 2);

  monotonicNowMs += 29_999;
  await harness.handlers.turn_end({}, harness.ctx);
  assert.equal(historyCalls, 2);

  monotonicNowMs += 1;
  await harness.handlers.turn_end({}, harness.ctx);
  assert.equal(historyCalls, 3);
});

test("newer lower proxy counters establish a reset baseline", async () => {
  let requests = 100;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => ({ displaySession: { requests, tokens_saved: requests * 10, total_input_tokens: requests * 20 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  requests = 5;
  let result = await harness.tools.headroom_stats.execute();
  assert.equal(result.details.proxyRequests, 0);
  requests = 6;
  result = await harness.tools.headroom_stats.execute();
  assert.equal(result.details.proxyRequests, 1);
});

test("older out-of-order proxy history cannot roll back a newer baseline", async () => {
  let calls = 0;
  let releaseOlder!: (history: unknown) => void;
  let olderStarted!: () => void;
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  const snapshot = (requests: number) => ({ displaySession: { requests, tokens_saved: requests * 10, total_input_tokens: requests * 20 } });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => {
      calls++;
      if (calls === 1) return snapshot(100);
      if (calls === 2) {
        olderStarted();
        return new Promise((resolve) => { releaseOlder = resolve; });
      }
      if (calls === 3) return snapshot(110);
      return snapshot(111);
    },
  });
  await harness.handlers.session_start({}, harness.ctx);
  const older = harness.tools.headroom_stats.execute();
  await started;
  const newer = await harness.tools.headroom_stats.execute();
  assert.equal(newer.details.proxyRequests, 10);
  releaseOlder(snapshot(105));
  await older;
  const final = await harness.tools.headroom_stats.execute();
  assert.equal(final.details.proxyRequests, 11);
});

test("an older baseline capture cannot overwrite a newer applied history snapshot", async () => {
  let calls = 0;
  let releaseBaseline!: (history: unknown) => void;
  let baselineStarted!: () => void;
  const started = new Promise<void>((resolve) => { baselineStarted = resolve; });
  const snapshot = (requests: number) => ({ displaySession: { requests, tokens_saved: requests * 10, total_input_tokens: requests * 20 } });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => {
      calls++;
      if (calls === 1) {
        baselineStarted();
        return new Promise((resolve) => { releaseBaseline = resolve; });
      }
      if (calls === 2) return snapshot(20);
      return snapshot(21);
    },
  });
  const sessionStart = harness.handlers.session_start({}, harness.ctx);
  await started;
  await harness.handlers.turn_end({}, harness.ctx);
  releaseBaseline(snapshot(10));
  await sessionStart;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.proxyRequests, 1);
});

test("an older failed history request cannot re-arm backoff after newer success", async () => {
  let calls = 0;
  let releaseOlder!: (history: unknown) => void;
  let olderStarted!: () => void;
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  const snapshot = { displaySession: { requests: 10, tokens_saved: 10, total_input_tokens: 20 } };
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => {
      calls++;
      if (calls === 1) return snapshot;
      if (calls === 2) {
        olderStarted();
        return new Promise((resolve) => { releaseOlder = resolve; });
      }
      return snapshot;
    },
  });
  await harness.handlers.session_start({}, harness.ctx);
  const older = harness.tools.headroom_stats.execute();
  await started;
  await harness.tools.headroom_stats.execute();
  releaseOlder({ error: "stale failure" });
  await older;
  await harness.tools.headroom_stats.execute();
  assert.equal(calls, 4);
});

test("remote proxy stats are blocked before fetching", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, proxyUrl: "https://example.test/headroom", allowRemote: false }),
  });
  const result = await harness.tools.headroom_stats.execute();
  assert.match(result.content[0].text, /remote proxy blocked/);
});

test("native routing defers managed recovery until the triggering fallback turn ends", async () => {
  let healthCalls = 0;
  let spawnCalls = 0;
  let readinessStarted!: () => void;
  let releaseReadiness!: (healthy: boolean) => void;
  const started = new Promise<void>((resolve) => { readinessStarted = resolve; });
  const child = Object.assign(new EventEmitter(), { pid: 4545, exitCode: null, signalCode: null });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => ++healthCalls === 1,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => { spawnCalls++; return child; },
    writePid: () => {},
    waitForHealth: async () => {
      readinessStarted();
      return new Promise<boolean>((resolve) => { releaseReadiness = resolve; });
    },
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);

  await harness.handlers.turn_start({}, harness.ctx);
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic", "openai-codex"]);
  assert.equal(spawnCalls, 0);
  assert.equal(harness.providers.length, 3);

  let turnEndSettled = false;
  const ending = harness.handlers.turn_end({}, harness.ctx).then(() => { turnEndSettled = true; });
  await started;
  assert.equal(spawnCalls, 1);
  assert.equal(turnEndSettled, false);
  assert.equal(harness.providers.length, 3);

  releaseReadiness(true);
  await ending;
  assert.equal(harness.providers.length, 6);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, true);
  assert.equal(stats.details.proxyOwner, "managed");
});

test("disable invalidates deferred native recovery before turn end", async () => {
  let healthCalls = 0;
  let spawnCalls = 0;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => ++healthCalls === 1,
    commandAvailable: () => true,
    spawnProxy: () => {
      spawnCalls++;
      return Object.assign(new EventEmitter(), { pid: 4646, exitCode: null, signalCode: null });
    },
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.handlers.turn_start({}, harness.ctx);
  await harness.commands.headroom.handler("disable", harness.ctx);
  await harness.handlers.turn_end({}, harness.ctx);

  assert.equal(spawnCalls, 0);
  assert.equal(harness.providers.length, 3);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
});

test("aborted turn end consumes deferred native recovery without resurrecting it", async () => {
  let healthCalls = 0;
  let spawnCalls = 0;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => ++healthCalls === 1,
    commandAvailable: () => true,
    spawnProxy: () => {
      spawnCalls++;
      return Object.assign(new EventEmitter(), { pid: 4747, exitCode: null, signalCode: null });
    },
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.handlers.turn_start({}, harness.ctx);

  const controller = new AbortController();
  controller.abort(new Error("turn aborted"));
  await harness.handlers.turn_end({}, { ...harness.ctx, signal: controller.signal });
  await harness.handlers.turn_end({}, harness.ctx);

  assert.equal(spawnCalls, 0);
  assert.equal(harness.providers.length, 3);
});

test("invalidated deferred recovery falls through to normal turn-end health recovery", async () => {
  let healthCalls = 0;
  const healthResults = [true, false, true, false, false];
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => healthResults[healthCalls++] ?? false,
    commandAvailable: () => false,
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.handlers.turn_start({}, harness.ctx);
  await harness.commands.headroom.handler("disable", harness.ctx);
  await harness.commands.headroom.handler("enable", harness.ctx);
  await harness.handlers.turn_end({}, harness.ctx);

  assert.equal(healthCalls, 5);
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic", "openai-codex", "openai", "anthropic", "openai-codex"]);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
});

test("a stale recovery probe cannot disable a newer successful enable", async () => {
  let healthCalls = 0;
  let releaseRecovery!: (healthy: boolean) => void;
  let recoveryStarted!: () => void;
  const started = new Promise<void>((resolve) => { recoveryStarted = resolve; });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => {
      healthCalls++;
      if (healthCalls === 2) {
        recoveryStarted();
        return new Promise<boolean>((resolve) => { releaseRecovery = resolve; });
      }
      return true;
    },
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  const recovering = harness.handlers.turn_start({}, harness.ctx);
  await started;
  await harness.commands.headroom.handler("disable", harness.ctx);
  await harness.commands.headroom.handler("enable", harness.ctx);
  releaseRecovery(false);
  await recovering;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, true);
});

test("disable restores the original native provider routing", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.commands.headroom.handler("disable", harness.ctx);
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic", "openai-codex"]);
});

test("disable restores native routing before optional stats finalization completes", async () => {
  let historyCalls = 0;
  let releaseFinalization!: () => void;
  let finalizationStarted!: () => void;
  const started = new Promise<void>((resolve) => { finalizationStarted = resolve; });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => {
      historyCalls++;
      if (historyCalls === 1) return { displaySession: { requests: 10, tokens_saved: 100, total_input_tokens: 200 } };
      finalizationStarted();
      await new Promise<void>((resolve) => { releaseFinalization = resolve; });
      return { displaySession: { requests: 11, tokens_saved: 110, total_input_tokens: 220 } };
    },
  });
  await harness.handlers.session_start({}, harness.ctx);

  const disabling = harness.commands.headroom.handler("disable", harness.ctx);
  await started;
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic", "openai-codex"]);
  releaseFinalization();
  await disabling;
});

test("a stale disable cannot overwrite stats or notify after a newer enable", async () => {
  let historyCalls = 0;
  let releaseFinalization!: (history: unknown) => void;
  let finalizationStarted!: () => void;
  const started = new Promise<void>((resolve) => { finalizationStarted = resolve; });
  const snapshot = (requests: number) => ({ displaySession: { requests, tokens_saved: requests * 10, total_input_tokens: requests * 20 } });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => {
      historyCalls++;
      if (historyCalls === 1) return snapshot(100);
      if (historyCalls === 2) {
        finalizationStarted();
        return new Promise((resolve) => { releaseFinalization = resolve; });
      }
      if (historyCalls === 3) return snapshot(120);
      return snapshot(121);
    },
  });
  await harness.handlers.session_start({}, harness.ctx);
  const disabling = harness.commands.headroom.handler("disable", harness.ctx);
  await started;
  await harness.commands.headroom.handler("enable", harness.ctx);
  releaseFinalization(snapshot(110));
  await disabling;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, true);
  assert.equal(stats.details.proxyOwner, "external");
  assert.equal(stats.details.proxyRequests, 1);
  assert.equal(harness.notices.filter((notice) => notice.message.includes("disabled for this session")).length, 0);
});

test("start waits for in-flight child termination before replacing the proxy", async () => {
  const firstChild = Object.assign(new EventEmitter(), { pid: 1111, exitCode: null, signalCode: null });
  const secondChild = Object.assign(new EventEmitter(), { pid: 2222, exitCode: null, signalCode: null });
  let spawnCalls = 0;
  let releaseTermination!: () => void;
  let terminationStarted!: () => void;
  const started = new Promise<void>((resolve) => { terminationStarted = resolve; });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => ++spawnCalls === 1 ? firstChild : secondChild,
    writePid: () => {},
    waitForHealth: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
    terminateChild: async () => {
      terminationStarted();
      await new Promise<void>((resolve) => { releaseTermination = resolve; });
      firstChild.exitCode = 0;
      firstChild.emit("exit", 0, null);
      return true;
    },
  });
  await harness.handlers.session_start({}, harness.ctx);
  const stopping = harness.commands.headroom.handler("stop", harness.ctx);
  await started;
  const starting = harness.commands.headroom.handler("start", harness.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(spawnCalls, 1);
  releaseTermination();
  await stopping;
  await starting;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(spawnCalls, 2);
  assert.equal(stats.details.enabled, true);
  assert.equal(stats.details.proxyOwner, "managed");
  assert.equal(secondChild.exitCode, null);
});

test("restart continues when the managed child exits during stop finalization", async () => {
  const firstChild = Object.assign(new EventEmitter(), { pid: 3333, exitCode: null as number | null, signalCode: null });
  const secondChild = Object.assign(new EventEmitter(), { pid: 4444, exitCode: null, signalCode: null });
  let spawnCalls = 0;
  let historyCalls = 0;
  let releaseFinalization!: (history: unknown) => void;
  let finalizationStarted!: () => void;
  const started = new Promise<void>((resolve) => { finalizationStarted = resolve; });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => ++spawnCalls === 1 ? firstChild : secondChild,
    writePid: () => {},
    waitForHealth: async () => true,
    proxyHistory: async () => {
      historyCalls++;
      if (historyCalls === 1) return { displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } };
      if (historyCalls === 2) {
        finalizationStarted();
        return new Promise((resolve) => { releaseFinalization = resolve; });
      }
      return { displaySession: { requests: 2, tokens_saved: 2, total_input_tokens: 4 } };
    },
  });
  await harness.handlers.session_start({}, harness.ctx);
  const restarting = harness.commands.headroom.handler("restart", harness.ctx);
  await started;
  firstChild.exitCode = 0;
  firstChild.emit("exit", 0, null);
  releaseFinalization({ displaySession: { requests: 2, tokens_saved: 2, total_input_tokens: 4 } });
  await restarting;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(spawnCalls, 2);
  assert.equal(stats.details.enabled, true);
  assert.equal(stats.details.proxyOwner, "managed");
});

test("confirmed exit tears down routing even after an earlier child error", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 8765, exitCode: null, signalCode: null });
  let healthCalls = 0;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => ++healthCalls > 1,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    waitForHealth: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  child.emit("error", new Error("transient child error"));
  await harness.commands.headroom.handler("enable", harness.ctx);
  child.exitCode = 1;
  child.emit("exit", 1, null);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "none");
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic", "openai-codex", "openai", "anthropic", "openai-codex"]);
});

test("enabling an already active session does not register duplicate provider overrides", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 1 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.commands.headroom.handler("enable", harness.ctx);
  assert.equal(harness.providers.length, 3);
});

test("enable revalidates an already active external proxy", async () => {
  let healthCalls = 0;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => ++healthCalls === 1,
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.commands.headroom.handler("enable", harness.ctx);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic", "openai-codex"]);
  assert.ok(harness.notices.some((notice) => notice.message.includes("proxy unavailable")));
});

test("enable waits for a spawned child to finish startup cleanup", async () => {
  let healthCalls = 0;
  let releaseReadiness!: (healthy: boolean) => void;
  let readinessStarted!: () => void;
  const started = new Promise<void>((resolve) => { readinessStarted = resolve; });
  let spawnCalls = 0;
  let terminateCalls = 0;
  let releaseTermination!: () => void;
  let terminationStarted!: () => void;
  const terminating = new Promise<void>((resolve) => { terminationStarted = resolve; });
  const child = Object.assign(new EventEmitter(), { pid: 5555, exitCode: null as number | null, signalCode: null });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, startup: "manual", enabled: false, localToolResultCompression: false }),
    health: async () => ++healthCalls > 1,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => { spawnCalls++; return child; },
    writePid: () => {},
    waitForHealth: async () => {
      readinessStarted();
      return new Promise<boolean>((resolve) => { releaseReadiness = resolve; });
    },
    terminateChild: async () => {
      terminateCalls++;
      terminationStarted();
      await new Promise<void>((resolve) => { releaseTermination = resolve; });
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    },
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  const starting = harness.commands.headroom.handler("start", harness.ctx);
  await started;
  let enableSettled = false;
  const enabling = harness.commands.headroom.handler("enable", harness.ctx).then(() => { enableSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(healthCalls, 1);
  assert.equal(terminateCalls, 0);
  releaseReadiness(false);
  await terminating;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enableSettled, false);
  releaseTermination();
  await starting;
  await enabling;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(spawnCalls, 1);
  assert.equal(terminateCalls, 1);
  assert.equal(stats.details.enabled, true);
});

test("enable also waits for restart startup cleanup", async () => {
  let healthCalls = 0;
  let releaseReadiness!: (healthy: boolean) => void;
  let readinessStarted!: () => void;
  const started = new Promise<void>((resolve) => { readinessStarted = resolve; });
  const child = Object.assign(new EventEmitter(), { pid: 5656, exitCode: null as number | null, signalCode: null });
  let terminateCalls = 0;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, startup: "manual", enabled: false, localToolResultCompression: false }),
    health: async () => ++healthCalls > 1,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    waitForHealth: async () => {
      readinessStarted();
      return new Promise<boolean>((resolve) => { releaseReadiness = resolve; });
    },
    terminateChild: async () => {
      terminateCalls++;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    },
    proxyHistory: async () => ({ displaySession: { requests: 1, tokens_saved: 1, total_input_tokens: 2 } }),
  });
  await harness.handlers.session_start({}, harness.ctx);
  const restarting = harness.commands.headroom.handler("restart", harness.ctx);
  await started;
  const enabling = harness.commands.headroom.handler("enable", harness.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(healthCalls, 1);
  releaseReadiness(false);
  await restarting;
  await enabling;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(terminateCalls, 1);
  assert.equal(stats.details.enabled, true);
});

test("aborted startup health probe cannot spawn a managed child", async () => {
  let releaseHealth!: (healthy: boolean) => void;
  let healthStarted!: () => void;
  const started = new Promise<void>((resolve) => { healthStarted = resolve; });
  const controller = new AbortController();
  let spawnCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => {
      healthStarted();
      return new Promise<boolean>((resolve) => { releaseHealth = resolve; });
    },
    commandAvailable: () => true,
    spawnProxy: () => { spawnCalls++; throw new Error("cancelled startup spawned"); },
  });
  const ctx = { ...harness.ctx, signal: controller.signal };
  const startup = harness.handlers.session_start({}, ctx);
  await started;
  controller.abort(new Error("cancelled"));
  releaseHealth(false);
  await startup;
  assert.equal(spawnCalls, 0);
});

test("managed exit during baseline capture cannot re-enable stale routing", async () => {
  let releaseBaseline!: (history: unknown) => void;
  let baselineStarted!: () => void;
  const started = new Promise<void>((resolve) => { baselineStarted = resolve; });
  const child = Object.assign(new EventEmitter(), { pid: 9871, exitCode: null as number | null, signalCode: null });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    waitForHealth: async () => true,
    proxyHistory: async () => {
      baselineStarted();
      return new Promise((resolve) => { releaseBaseline = resolve; });
    },
  });
  const startup = harness.handlers.session_start({}, harness.ctx);
  await started;
  child.exitCode = 17;
  child.emit("exit", 17, null);
  releaseBaseline({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } });
  await startup;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "none");
});

test("child error without confirmed exit retains ownership and blocks replacement", async () => {
  let spawnCalls = 0;
  const child = Object.assign(new EventEmitter(), { pid: 9872, exitCode: null, signalCode: null });
  const harness = createHeadroomHarness({
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => { spawnCalls++; return child; },
    writePid: () => {},
    waitForHealth: async () => true,
  });
  await harness.handlers.session_start({}, harness.ctx);
  child.emit("error", new Error("asynchronous child error"));
  await harness.commands.headroom.handler("start", harness.ctx);
  assert.equal(spawnCalls, 1);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "managed");
});

test("partial provider registration is rolled back", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
  }, "anthropic");
  await harness.handlers.session_start({}, harness.ctx);
  assert.deepEqual(harness.unregisteredProviders, ["openai"]);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.ok(harness.notices.some((notice) => notice.message.includes("could not install Pi provider routing")));
});

test("provider activation failure retains managed-child ownership", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null });
  let spawnCalls = 0;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 1,
    closeLog: () => {},
    spawnProxy: () => { spawnCalls++; return child; },
    writePid: () => {},
    waitForHealth: async () => true,
  }, "anthropic");
  await harness.handlers.session_start({}, harness.ctx);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "managed");
  await harness.commands.headroom.handler("start", harness.ctx);
  assert.equal(spawnCalls, 1);
});

test("aborted enable baseline rolls back routing without success notification", async () => {
  let releaseBaseline!: (history: unknown) => void;
  let baselineStarted!: () => void;
  const started = new Promise<void>((resolve) => { baselineStarted = resolve; });
  const controller = new AbortController();
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, startup: "manual", localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => {
      baselineStarted();
      return new Promise((resolve) => { releaseBaseline = resolve; });
    },
  });
  const ctx = { ...harness.ctx, signal: controller.signal };
  const enabling = harness.commands.headroom.handler("enable", ctx);
  await started;
  controller.abort(new Error("cancelled"));
  releaseBaseline({});
  await enabling;
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic", "openai-codex"]);
  assert.ok(!harness.notices.some((notice) => notice.message.includes("enabled for this session")));
});

test("an older canceled enable cannot disable a newer successful activation", async () => {
  const waitUntil = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(predicate(), "expected asynchronous transition did not occur");
  };
  const healthResolvers: Array<(value: boolean) => void> = [];
  const historyResolvers: Array<(value: unknown) => void> = [];
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, startup: "manual", enabled: false, localToolResultCompression: false }),
    health: async () => new Promise<boolean>((resolve) => { healthResolvers.push(resolve); }),
    proxyHistory: async () => {
      if (historyResolvers.length >= 2) return { displaySession: { requests: 20, tokens_saved: 20, total_input_tokens: 20 } };
      return new Promise((resolve) => { historyResolvers.push(resolve); });
    },
  });
  await harness.handlers.session_start({}, harness.ctx);
  const firstController = new AbortController();
  const first = harness.commands.headroom.handler("enable", { ...harness.ctx, signal: firstController.signal });
  await waitUntil(() => healthResolvers.length === 1);
  healthResolvers[0]!(true);
  await waitUntil(() => historyResolvers.length === 1);
  const second = harness.commands.headroom.handler("enable", harness.ctx);
  await waitUntil(() => healthResolvers.length === 2);
  healthResolvers[1]!(true);
  await waitUntil(() => historyResolvers.length === 2);
  historyResolvers[1]!({ displaySession: { requests: 20, tokens_saved: 20, total_input_tokens: 20 } });
  await second;
  firstController.abort();
  historyResolvers[0]!({ displaySession: { requests: 10, tokens_saved: 10, total_input_tokens: 10 } });
  await first;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, true);
  assert.deepEqual(harness.unregisteredProviders, []);
  assert.equal(harness.notices.filter((notice) => notice.message.includes("enabled for this session")).length, 1);
});

test("stale startup baseline cannot overwrite a newer enabled segment", async () => {
  let releaseOldBaseline!: (history: unknown) => void;
  let oldBaselineStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => { oldBaselineStarted = resolve; });
  let releaseNewBaseline!: (history: unknown) => void;
  let newBaselineStarted!: () => void;
  const newStarted = new Promise<void>((resolve) => { newBaselineStarted = resolve; });
  let calls = 0;
  const snapshot = (requests: number) => ({ displaySession: { requests, tokens_saved: requests * 10, total_input_tokens: requests * 20 } });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
    proxyHistory: async () => {
      calls++;
      if (calls === 1) {
        oldBaselineStarted();
        return new Promise((resolve) => { releaseOldBaseline = resolve; });
      }
      if (calls === 2) return snapshot(20);
      if (calls === 3) {
        newBaselineStarted();
        return new Promise((resolve) => { releaseNewBaseline = resolve; });
      }
      return snapshot(31);
    },
  });
  const startup = harness.handlers.session_start({}, harness.ctx);
  await oldStarted;
  await harness.commands.headroom.handler("disable", harness.ctx);
  const enabling = harness.commands.headroom.handler("enable", harness.ctx);
  await newStarted;
  releaseNewBaseline(snapshot(30));
  await enabling;
  releaseOldBaseline(snapshot(10));
  await startup;
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.proxyRequests, 1);
});

test("does not expose local retrieval when native proxy routing is active", () => {
  const harness = createHeadroomHarness({ readConfig: () => ({ ...DEFAULT_CONFIG }) });
  assert.equal(harness.tools.headroom_retrieve, undefined);
  assert.ok(harness.tools.headroom_stats);
});

test("disable during startup invalidates stale startup before spawn", async () => {
  let releaseHealth!: (healthy: boolean) => void;
  let probeStarted!: () => void;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  let spawnCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => {
      probeStarted();
      return new Promise<boolean>((resolve) => { releaseHealth = resolve; });
    },
    proxyHistory: async () => ({}),
    spawnProxy: () => { spawnCalls++; throw new Error("stale startup spawned"); },
  });
  const sessionStart = harness.handlers.session_start({}, harness.ctx);
  await started;
  await harness.commands.headroom.handler("disable", harness.ctx);
  releaseHealth(false);
  await sessionStart;
  assert.equal(spawnCalls, 0);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
});

test("stop during the initial health probe invalidates startup before spawn", async () => {
  let releaseHealth!: (healthy: boolean) => void;
  let probeStarted!: () => void;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  let spawnCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => {
      probeStarted();
      return new Promise<boolean>((resolve) => { releaseHealth = resolve; });
    },
    spawnProxy: () => { spawnCalls++; throw new Error("stale startup spawned"); },
  });

  const sessionStart = harness.handlers.session_start({}, harness.ctx);
  await started;
  await harness.commands.headroom.handler("stop", harness.ctx);
  releaseHealth(false);
  await sessionStart;

  assert.equal(spawnCalls, 0);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "none");
});

test("config reset during startup waits for stale work then runs a fresh probe", async () => {
  let releaseFirst!: (healthy: boolean) => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  let healthCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => {
      healthCalls++;
      if (healthCalls === 1) {
        firstStarted();
        return new Promise<boolean>((resolve) => { releaseFirst = resolve; });
      }
      return true;
    },
  });

  const sessionStart = harness.handlers.session_start({}, harness.ctx);
  await started;
  const reset = harness.commands.headroom.handler("config reset", harness.ctx);
  releaseFirst(false);
  await Promise.all([sessionStart, reset]);

  assert.equal(healthCalls, 2);
  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, true);
  assert.equal(stats.details.proxyOwner, "external");
  assert.ok(harness.tools.headroom_retrieve);
});

test("concurrent startup loser adopts the winner after its child exits before readiness", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4567, exitCode: null, killed: false });
  let healthCalls = 0;
  let spawnCalls = 0;
  let waitCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => { healthCalls++; return false; },
    waitForHealth: async () => {
      waitCalls++;
      if (waitCalls === 1) {
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return false;
      }
      return true;
    },
    commandAvailable: () => true,
    openLog: () => 12,
    closeLog: () => {},
    spawnProxy: () => { spawnCalls++; return child; },
    writePid: () => {},
    terminateChild: async () => true,
  });

  await harness.handlers.session_start({}, harness.ctx);

  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(healthCalls, 1);
  assert.equal(waitCalls, 2);
  assert.equal(spawnCalls, 1);
  assert.equal(stats.details.enabled, true);
  assert.equal(stats.details.proxyOwner, "external");
  assert.ok(harness.notices.some((notice) => notice.message.includes("concurrent Headroom proxy")));
  assert.equal(harness.notices.some((notice) => notice.message.includes("bypassing compression")), false);
});

test("concurrent startup loser waits only the remaining startup budget for the winner", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4568, exitCode: null, signalCode: null, killed: false });
  let monotonicNowMs = 10_000;
  const waitTimeouts: number[] = [];
  const harness = createHeadroomHarness({
    monotonicNowMs: () => monotonicNowMs,
    health: async () => false,
    waitForHealth: async (_config: unknown, _signal: AbortSignal | undefined, timeoutMs: number, isActive: () => boolean) => {
      waitTimeouts.push(timeoutMs);
      assert.equal(isActive(), true);
      if (waitTimeouts.length === 1) {
        monotonicNowMs += 1_250;
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return false;
      }
      return true;
    },
    commandAvailable: () => true,
    openLog: () => 14,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    terminateChild: async () => true,
  });

  await harness.handlers.session_start({}, harness.ctx);

  const stats = await harness.tools.headroom_stats.execute();
  assert.deepEqual(waitTimeouts, [DEFAULT_CONFIG.startupHealthTimeoutMs, DEFAULT_CONFIG.startupHealthTimeoutMs - 1_250]);
  assert.equal(stats.details.enabled, true);
  assert.equal(stats.details.proxyOwner, "external");
  assert.ok(harness.notices.some((notice) => notice.message.includes("concurrent Headroom proxy")));
  assert.equal(harness.notices.some((notice) => notice.message.includes("bypassing compression")), false);
});

test("concurrent startup loser skips winner wait and adoption at zero remaining budget", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4570, exitCode: null, signalCode: null, killed: false });
  let monotonicNowMs = 10_000;
  let waitCalls = 0;
  const harness = createHeadroomHarness({
    monotonicNowMs: () => monotonicNowMs,
    health: async () => false,
    waitForHealth: async () => {
      waitCalls++;
      if (waitCalls === 1) {
        monotonicNowMs += DEFAULT_CONFIG.startupHealthTimeoutMs;
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return false;
      }
      return true;
    },
    commandAvailable: () => true,
    openLog: () => 16,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    terminateChild: async () => true,
  });

  await harness.handlers.session_start({}, harness.ctx);

  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(waitCalls, 1);
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "none");
  assert.equal(harness.notices.some((notice) => notice.message.includes("adopted a concurrent Headroom proxy")), false);
});

test("concurrent startup loser skips winner wait and adoption at negative remaining budget", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4571, exitCode: null, signalCode: null, killed: false });
  let monotonicNowMs = 20_000;
  let waitCalls = 0;
  const harness = createHeadroomHarness({
    monotonicNowMs: () => monotonicNowMs,
    health: async () => false,
    waitForHealth: async () => {
      waitCalls++;
      if (waitCalls === 1) {
        monotonicNowMs += DEFAULT_CONFIG.startupHealthTimeoutMs + 1;
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return false;
      }
      return true;
    },
    commandAvailable: () => true,
    openLog: () => 17,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    terminateChild: async () => true,
  });

  await harness.handlers.session_start({}, harness.ctx);

  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(waitCalls, 1);
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "none");
  assert.equal(harness.notices.some((notice) => notice.message.includes("adopted a concurrent Headroom proxy")), false);
});

test("wall-clock rollback cannot extend the concurrent-winner deadline", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4572, exitCode: null, signalCode: null, killed: false });
  let wallNowMs = 50_000;
  let monotonicNowMs = 1_000;
  const waitTimeouts: number[] = [];
  const harness = createHeadroomHarness({
    now: () => wallNowMs,
    monotonicNowMs: () => monotonicNowMs,
    health: async () => false,
    waitForHealth: async (_config: unknown, _signal: AbortSignal | undefined, timeoutMs: number) => {
      waitTimeouts.push(timeoutMs);
      if (waitTimeouts.length === 1) {
        wallNowMs -= 5_000;
        monotonicNowMs += DEFAULT_CONFIG.startupHealthTimeoutMs;
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return false;
      }
      return true;
    },
    commandAvailable: () => true,
    openLog: () => 18,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    terminateChild: async () => true,
  });

  await harness.handlers.session_start({}, harness.ctx);

  const stats = await harness.tools.headroom_stats.execute();
  assert.deepEqual(waitTimeouts, [DEFAULT_CONFIG.startupHealthTimeoutMs]);
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "none");
});

test("signal-exited startup child is no longer tracked when no concurrent proxy becomes ready", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4569, exitCode: null, signalCode: null as NodeJS.Signals | null, killed: false });
  let waitCalls = 0;
  let terminateCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => false,
    waitForHealth: async () => {
      waitCalls++;
      if (waitCalls === 1) {
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
      }
      return false;
    },
    commandAvailable: () => true,
    openLog: () => 15,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    terminateChild: async () => { terminateCalls++; return false; },
  });

  await harness.handlers.session_start({}, harness.ctx);

  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(waitCalls, 2);
  assert.equal(terminateCalls, 0);
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "none");
  assert.equal(harness.notices.some((notice) => notice.message.includes("remains tracked")), false);
});

test("auto session replaces a lost adopted proxy on the compression health path", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 7654, exitCode: null, killed: false });
  let healthCalls = 0;
  let spawnCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => {
      healthCalls++;
      return healthCalls === 1;
    },
    waitForHealth: async () => true,
    commandAvailable: () => true,
    openLog: () => 13,
    closeLog: () => {},
    spawnProxy: () => { spawnCalls++; return child; },
    writePid: () => {},
  });

  await harness.handlers.session_start({}, harness.ctx);
  let stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.proxyOwner, "external");

  await harness.handlers.tool_result({
    toolName: "bash",
    input: {},
    content: [{ type: "text", text: "x".repeat(DEFAULT_CONFIG.minChars) }],
  }, harness.ctx);

  stats = await harness.tools.headroom_stats.execute();
  assert.equal(healthCalls, 3);
  assert.equal(spawnCalls, 1);
  assert.equal(stats.details.enabled, true);
  assert.equal(stats.details.proxyOwner, "managed");
  assert.ok(harness.notices.some((notice) => notice.message === "Headroom proxy started."));
});

test("directory and PID-file failures stay visible and do not leak ownership", async () => {
  const directoryFailure = createHeadroomHarness({
    ensureDirs: () => { throw new Error("permission denied"); },
  });
  await directoryFailure.handlers.session_start({}, directoryFailure.ctx);
  assert.ok(directoryFailure.notices.some((notice) => notice.message.includes("directory setup failed")));

  const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, killed: false });
  let terminateCalls = 0;
  const pidFailure = createHeadroomHarness({
    health: async () => false,
    commandAvailable: () => true,
    openLog: () => 7,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => { throw new Error("read-only filesystem"); },
    terminateChild: async () => {
      terminateCalls++;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    },
  });
  await pidFailure.handlers.session_start({}, pidFailure.ctx);
  assert.equal(terminateCalls, 1);
  assert.ok(pidFailure.notices.some((notice) => notice.message.includes("PID file")));
  const stats = await pidFailure.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "none");
});

test("an unkillable timed-out child stays tracked until a later stop confirms exit", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 5678, exitCode: null, killed: false });
  let terminateCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => false,
    waitForHealth: async () => false,
    commandAvailable: () => true,
    openLog: () => 8,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    terminateChild: async () => {
      terminateCalls++;
      if (terminateCalls === 1) return false;
      child.exitCode = 0;
      child.emit("exit", 0, "SIGKILL");
      return true;
    },
  });

  await harness.handlers.session_start({}, harness.ctx);
  let stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "managed");
  assert.ok(harness.notices.some((notice) => notice.message.includes("remains tracked")));

  await harness.commands.headroom.handler("stop", harness.ctx);
  stats = await harness.tools.headroom_stats.execute();
  assert.equal(terminateCalls, 2);
  assert.equal(stats.details.proxyOwner, "none");
  assert.equal(harness.notices.some((notice) => notice.message.includes("exited unexpectedly")), false);
});

test("start refuses to replace a tracked child after failed termination", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 5900, exitCode: null, killed: false });
  let spawnCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => false,
    waitForHealth: async () => false,
    commandAvailable: () => true,
    openLog: () => 11,
    closeLog: () => {},
    spawnProxy: () => { spawnCalls++; return child; },
    writePid: () => {},
    terminateChild: async () => false,
  });

  await harness.handlers.session_start({}, harness.ctx);
  await harness.commands.headroom.handler("start", harness.ctx);

  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(spawnCalls, 1);
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "managed");
  assert.ok(harness.notices.some((notice) => notice.message.includes("still tracked")));
});

test("cancellation during timeout termination suppresses stale state and notices", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 6789, exitCode: null, killed: false });
  let releaseFirstTermination!: (terminated: boolean) => void;
  let firstTerminationStarted!: () => void;
  const terminationStarted = new Promise<void>((resolve) => { firstTerminationStarted = resolve; });
  let terminateCalls = 0;
  const harness = createHeadroomHarness({
    health: async () => false,
    waitForHealth: async () => false,
    commandAvailable: () => true,
    openLog: () => 9,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    terminateChild: async () => {
      terminateCalls++;
      if (terminateCalls === 1) {
        firstTerminationStarted();
        return new Promise<boolean>((resolve) => { releaseFirstTermination = resolve; });
      }
      child.exitCode = 0;
      child.emit("exit", 0, "SIGTERM");
      return true;
    },
  });

  const startup = harness.handlers.session_start({}, harness.ctx);
  await terminationStarted;
  await harness.commands.headroom.handler("stop", harness.ctx);
  releaseFirstTermination(true);
  await startup;

  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.proxyOwner, "none");
  assert.equal(stats.details.enabled, false);
  assert.equal(harness.notices.some((notice) => notice.message.includes("did not become healthy")), false);
});

test("config reset preserves ownership when a managed child cannot stop", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 7890, exitCode: null, killed: false });
  let releaseReadiness!: (healthy: boolean) => void;
  let readinessStarted!: () => void;
  const readiness = new Promise<void>((resolve) => { readinessStarted = resolve; });
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, proxyUrl: "http://127.0.0.1:9999", port: 9999 }),
    health: async () => false,
    waitForHealth: async () => {
      readinessStarted();
      return new Promise<boolean>((resolve) => { releaseReadiness = resolve; });
    },
    commandAvailable: () => true,
    openLog: () => 10,
    closeLog: () => {},
    spawnProxy: () => child,
    writePid: () => {},
    terminateChild: async () => false,
  });

  const startup = harness.handlers.session_start({}, harness.ctx);
  await readiness;
  await harness.commands.headroom.handler("config reset", harness.ctx);
  releaseReadiness(false);
  await startup;

  const stats = await harness.tools.headroom_stats.execute();
  assert.equal(stats.details.enabled, false);
  assert.equal(stats.details.proxyOwner, "managed");
  assert.ok(harness.notices.some((notice) => notice.message.includes("remains tracked")));
  assert.equal(harness.notices.some((notice) => notice.message.includes("runtime config reset to defaults")), false);
  await harness.commands.headroom.handler("config show", harness.ctx);
  assert.ok(harness.notices.at(-1)?.message.includes("127.0.0.1:9999"));
});

test("shouldCompressToolResult compresses all large non-excluded text", () => {
  const text = "x".repeat(DEFAULT_CONFIG.minChars);
  assert.equal(shouldCompressToolResult("bash", {}, text, DEFAULT_CONFIG), true);
  assert.equal(shouldCompressToolResult("mcp", {}, text, DEFAULT_CONFIG), true);
  assert.equal(shouldCompressToolResult("some_new_web_fetch_tool", {}, text, DEFAULT_CONFIG), true);
  assert.equal(shouldCompressToolResult("write", {}, text, DEFAULT_CONFIG), false);
  assert.equal(shouldCompressToolResult("bash", {}, "small", DEFAULT_CONFIG), false);
});

test("secret-looking args or output bypass compression", () => {
  const text = "x".repeat(DEFAULT_CONFIG.minChars);
  assert.equal(shouldCompressToolResult("read", { path: ".env" }, text, DEFAULT_CONFIG), false);
  assert.equal(outputLooksSensitive("Authorization: Bearer abc.def.ghi"), true);
  assert.equal(outputLooksSensitive("normal build log"), false);
  assert.equal(outputLooksSensitive("sk-proj-abcdefghijklmnopqrstuvwxyz_123456"), true);
  assert.equal(shouldCompressToolResult("bash", {}, "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz", DEFAULT_CONFIG), false);
});

test("retrieveWithQuery returns focused matching lines", () => {
  const content = ["alpha", "before", "fatal auth error", "after", "omega"].join("\n");
  assert.match(retrieveWithQuery(content, "auth", 1, 10_000), /2: before/);
  assert.match(retrieveWithQuery(content, "auth", 1, 10_000), /3: fatal auth error/);
  assert.match(retrieveWithQuery(content, "missing", 1, 10_000), /no matches/);
});

test("truncateText caps retrieval bytes", () => {
  const result = truncateText("a".repeat(2000), 1000);
  assert.ok(result.length < 1200);
  assert.match(result, /retrieval truncated/);
});

test("canRetainOriginal rejects entries larger than store byte cap", () => {
  const entry: StoredOriginal = {
    hash: "hr_big",
    toolName: "bash",
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    originalContent: "x".repeat(2000),
  };
  assert.equal(canRetainOriginal(entry, { storeMaxBytes: 1024, storeMaxEntries: 1 }), false);
  assert.equal(canRetainOriginal(entry, { storeMaxBytes: 10_000, storeMaxEntries: 1 }), true);
});

test("headroomFailureText suppresses original only when fallback is disabled", () => {
  assert.equal(headroomFailureText({ fallbackToOriginal: true }, "proxy unavailable."), undefined);
  assert.equal(
    headroomFailureText({ fallbackToOriginal: false }, "proxy unavailable."),
    "[Headroom: proxy unavailable. Original tool output suppressed because fallbackToOriginal=false.]",
  );
});

test("contentWithText replaces joined text without leaking later text blocks", () => {
  const content = [
    { type: "text", text: "first" },
    { type: "image", url: "data:image/png;base64,abc" },
    { type: "text", text: "second raw output" },
  ];
  assert.deepEqual(contentWithText(content, "compressed"), [
    { type: "text", text: "compressed" },
    { type: "image", url: "data:image/png;base64,abc" },
  ]);
});

test("buildCompressRequest sends tool-role content so Headroom can compress it", () => {
  const payload = buildCompressRequest("large output", "mcp", "gpt-4o");
  assert.equal(payload.protect_recent, 0);
  assert.equal(payload.messages[0].role, "tool");
  assert.equal(payload.messages[0].tool_call_id, "call_headroom_tool_output");
  assert.match(payload.messages[0].content, /^Tool output from mcp:/);
});

test("buildCompressRequest sends Anthropic tool_result content for Anthropic providers", () => {
  const payload = buildCompressRequest("large output", "mcp", "claude-sonnet", "anthropic");
  assert.equal(payload.messages[0].role, "user");
  assert.equal(payload.messages[0].content[0].type, "tool_result");
  assert.equal(payload.messages[0].content[0].tool_use_id, "call_headroom_tool_output");
  assert.match(payload.messages[0].content[0].content, /^Tool output from mcp:/);
});

test("remote proxy is blocked unless explicitly allowed", () => {
  assert.equal(isRemoteBlocked({ ...DEFAULT_CONFIG, proxyUrl: "https://example.com" }), true);
  assert.equal(isRemoteBlocked({ ...DEFAULT_CONFIG, proxyUrl: "https://example.com", allowRemote: true }), false);
  assert.equal(isRemoteBlocked({ ...DEFAULT_CONFIG, proxyUrl: "http://127.0.0.1:8787" }), false);
});

test("headroomReadyFromPayload parses readiness fields", () => {
  assert.equal(headroomReadyFromPayload({ ready: true, status: "unhealthy" }), true);
  assert.equal(headroomReadyFromPayload({ ready: false, status: "healthy" }), false);
  assert.equal(headroomReadyFromPayload({ status: "healthy" }), true);
  assert.equal(headroomReadyFromPayload({ status: "not-ready" }), false);
  assert.equal(headroomReadyFromPayload({ checks: { upstream: { ready: true }, backend: { ready: false } } }), false);
  assert.equal(headroomReadyFromPayload({ service: "headroom-proxy" }), undefined);
});

test("compression readiness tolerates upstream-only failures", () => {
  const payload = {
    service: "headroom-proxy",
    status: "unhealthy",
    ready: false,
    checks: {
      startup: { enabled: true, ready: true, status: "healthy" },
      http_client: { enabled: true, ready: true, status: "healthy" },
      cache: { enabled: true, ready: true, status: "healthy" },
      rate_limiter: { enabled: true, ready: true, status: "healthy" },
      upstream: { enabled: true, ready: false, status: "unhealthy" },
    },
  };
  assert.equal(headroomReadyFromPayload(payload), false);
  assert.equal(headroomCompressionReadyFromPayload(payload), true);
});

test("native routing accepts explicit top-level readiness", () => {
  assert.equal(headroomRoutingReadyFromPayload({ service: "headroom-proxy", ready: true }), true);
  assert.equal(headroomRoutingReadyFromPayload({ service: "headroom-proxy", ready: true, checks: { upstream: { ready: false } } }), false);
});
test("native routing requires upstream readiness", () => {
  const payload = {
    service: "headroom-proxy",
    status: "unhealthy",
    ready: false,
    checks: {
      startup: { ready: true },
      upstream: { enabled: true, ready: false, status: "unhealthy" },
    },
  };
  assert.equal(headroomCompressionReadyFromPayload(payload), true);
  assert.equal(headroomRoutingReadyFromPayload(payload), false);
});

test("health does not adopt reachable but unready proxy", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/readyz")) {
      return new Response(JSON.stringify({ service: "headroom-proxy", status: "unhealthy", ready: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    assert.equal(await health(DEFAULT_CONFIG), false);
    assert.deepEqual(calls, [`${DEFAULT_CONFIG.proxyUrl}/readyz`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health rejects unrelated local JSON services", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok", app: "something-else" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

  try {
    assert.equal(await health(DEFAULT_CONFIG), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health falls back to /health readiness payload when /readyz is missing", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/readyz")) {
      return new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ service: "headroom-proxy", status: "unhealthy", ready: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    assert.equal(await health(DEFAULT_CONFIG), false);
    assert.deepEqual(calls, [`${DEFAULT_CONFIG.proxyUrl}/readyz`, `${DEFAULT_CONFIG.proxyUrl}/health`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health forwards caller abort signal to fetch", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined;
    assert.ok(receivedSignal);
    assert.equal(receivedSignal.aborted, false);
    controller.abort(new Error("cancelled"));
    assert.equal(receivedSignal.aborted, true);
    throw receivedSignal.reason ?? new Error("aborted");
  }) as typeof fetch;

  try {
    assert.equal(await health(DEFAULT_CONFIG, controller.signal), false);
    assert.equal(receivedSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("waitForHealth uses a monotonic deadline and never probes after it", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const controller = new AbortController();
  let safetyAbortFired = false;
  const safetyAbort = setTimeout(() => {
    safetyAbortFired = true;
    controller.abort();
  }, 100);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ service: "headroom-proxy", ready: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  Date.now = () => 0;

  try {
    assert.equal(await waitForHealth(DEFAULT_CONFIG, controller.signal, 20), false);
    assert.equal(safetyAbortFired, false);
    assert.equal(calls, 1);
  } finally {
    clearTimeout(safetyAbort);
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("buildMarker advertises native retrieve tool", () => {
  const marker = buildMarker("hr_123", {
    compressedText: "short",
    tokensBefore: 1000,
    tokensAfter: 250,
    tokensSaved: 750,
    compressionRatio: 0.25,
    transforms: ["router:log:0.25"],
    proxyCcrHashes: ["abc"],
  });
  assert.match(marker, /headroom_retrieve/);
  assert.match(marker, /hr_123/);
  assert.match(marker, /750 tokens/);
  assert.match(marker, /router:log/);
});

test("status helpers summarize session savings", () => {
  const stats = initialStats();
  stats.tokensBefore = 1000;
  stats.tokensSaved = 600;
  assert.equal(savingsPercent(stats), 60);
  assert.equal(formatCount(1500), "1.5k");
  assert.equal(statusText(true, "managed", stats), "hr m 600 ↓60%");
  assert.equal(statusText(false, "none", stats), "hr off");
});
