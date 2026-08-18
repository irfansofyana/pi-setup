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
  headroomReadyFromPayload,
  health,
  initialRuntimeEnabled,
  initialStats,
  isRemoteBlocked,
  normalizeHeadroomConfig,
  outputLooksSensitive,
  proxyEndpoint,
  proxyProviderBaseUrls,
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
  });
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

function createHeadroomHarness(dependencies: Record<string, unknown>) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const notices: Array<{ message: string; level: string }> = [];
  const statuses: string[] = [];
  const providers: Array<{ name: string; options: unknown }> = [];
  const unregisteredProviders: string[] = [];
  const pi = {
    registerProvider(name: string, options: unknown) { providers.push({ name, options }); },
    unregisterProvider(name: string) { unregisteredProviders.push(name); },
    on(name: string, handler: (...args: any[]) => any) { handlers[name] = handler; },
    registerCommand(name: string, command: any) { commands[name] = command; },
    registerTool(tool: any) { tools[tool.name] = tool; },
  };
  const ctx = {
    cwd: "/tmp/headroom-lifecycle-test",
    hasUI: true,
    ui: {
      notify(message: string, level: string) { notices.push({ message, level }); },
      setStatus(_key: string, value: string) { statuses.push(value); },
    },
  };
  headroom(pi as any, {
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: true }),
    ensureDirs: () => {},
    cleanupStore: () => {},
    ...dependencies,
  } as any);
  return { handlers, commands, tools, notices, statuses, providers, unregisteredProviders, ctx };
}

test("session startup registers both native provider endpoints with Headroom", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
  });
  assert.deepEqual(harness.providers, []);
  await harness.handlers.session_start({}, harness.ctx);
  assert.deepEqual(harness.providers, [
    { name: "openai", options: { baseUrl: "http://127.0.0.1:8787/v1" } },
    { name: "anthropic", options: { baseUrl: "http://127.0.0.1:8787" } },
  ]);
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

test("remote proxy stats are blocked before fetching", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, proxyUrl: "https://example.test/headroom", allowRemote: false }),
  });
  const result = await harness.tools.headroom_stats.execute();
  assert.match(result.content[0].text, /remote proxy blocked/);
});

test("native routing restores and attempts recovery after external proxy loss", async () => {
  let healthy = true;
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => healthy,
    commandAvailable: () => false,
    proxyHistory: async () => ({}),
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.commands.headroom.handler("status", harness.ctx);
  healthy = false;
  await harness.handlers.turn_start({}, harness.ctx);
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic"]);
});

test("disable restores the original native provider routing", async () => {
  const harness = createHeadroomHarness({
    readConfig: () => ({ ...DEFAULT_CONFIG, localToolResultCompression: false }),
    health: async () => true,
  });
  await harness.handlers.session_start({}, harness.ctx);
  await harness.commands.headroom.handler("disable", harness.ctx);
  assert.deepEqual(harness.unregisteredProviders, ["openai", "anthropic"]);
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
