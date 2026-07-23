import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopExtension } from "./index.ts";
import { AbsoluteScheduler, type SchedulerClock, type TimerHandle } from "./scheduler.ts";

interface Timer extends TimerHandle {
  at: number;
  callback: () => void;
  cancelled: boolean;
}

class FakeClock implements SchedulerClock {
  time = 0;
  timers: Timer[] = [];
  now = () => this.time;

  setTimeout(callback: () => void, delayMs: number): Timer {
    const timer = { at: this.time + delayMs, callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: TimerHandle): void {
    (handle as Timer).cancelled = true;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const timer = this.timers
        .filter((entry) => !entry.cancelled && entry.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!timer) break;
      timer.cancelled = true;
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
}

class FakeEventBus {
  handlers = new Map<string, Set<(value: unknown) => void>>();

  on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

class FakePi {
  events = new FakeEventBus();
  commands = new Map<string, any>();
  tools = new Map<string, any>();
  lifecycle = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  sent: string[] = [];
  throwOnSend = false;

  registerCommand(name: string, options: any): void {
    this.commands.set(name, options);
  }

  registerTool(definition: any): void {
    this.tools.set(definition.name, definition);
  }

  on(event: string, handler: (event: any, ctx: any) => unknown): void {
    const handlers = this.lifecycle.get(event) ?? [];
    handlers.push(handler);
    this.lifecycle.set(event, handlers);
  }

  sendUserMessage(content: string): void {
    if (this.throwOnSend) throw new Error("synthetic send failure");
    this.sent.push(content);
  }

  async emitLifecycle(event: string, value: any, ctx: any): Promise<unknown[]> {
    const results = [];
    for (const handler of this.lifecycle.get(event) ?? []) results.push(await handler(value, ctx));
    return results;
  }
}

function fixture(options: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const pi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = {
    cwd: "/repo",
    idle: true,
    pending: false,
    isIdle() { return this.idle; },
    hasPendingMessages() { return this.pending; },
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      notify(message: string, level: string) { notifications.push({ message, level }); },
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    },
  };
  const controller = createLoopExtension(pi as any, {
    now: clock.now,
    randomId: () => "loop-1",
    scheduler: new AbsoluteScheduler(clock),
    ...options,
  });
  return { clock, pi, ctx, controller, notifications, statuses };
}

async function startRun(pi: FakePi, ctx: any): Promise<void> {
  ctx.idle = false;
  await pi.emitLifecycle("before_agent_start", { systemPrompt: "base" }, ctx);
  await pi.emitLifecycle("agent_start", {}, ctx);
}

async function settleRun(pi: FakePi, ctx: any, text = "iteration done"): Promise<void> {
  await pi.emitLifecycle("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  }, ctx);
  ctx.idle = true;
  await pi.emitLifecycle("agent_settled", {}, ctx);
}

test("dynamic loop runs immediately and omission ends it", async () => {
  const { pi, ctx, controller } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("finish feature", ctx);
  assert.deepEqual(pi.sent, ["finish feature"]);

  await startRun(pi, ctx);
  await settleRun(pi, ctx);
  assert.equal(controller.snapshot(), undefined);
});

test("failed agent run stops instead of being treated as dynamic completion", async () => {
  const { pi, ctx, controller, notifications } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("finish feature", ctx);
  await startRun(pi, ctx);
  await pi.emitLifecycle("agent_end", {
    messages: [{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "provider failed" }] }],
  }, ctx);
  ctx.idle = true;
  await pi.emitLifecycle("agent_settled", {}, ctx);
  assert.equal(controller.snapshot(), undefined);
  assert.match(notifications.at(-1)!.message, /ended with error/);
  assert.doesNotMatch(notifications.at(-1)!.message, /complete/);
});

test("length-truncated run stops instead of being treated as completion", async () => {
  const { pi, ctx, controller, notifications } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("finish feature", ctx);
  await startRun(pi, ctx);
  await pi.emitLifecycle("agent_end", {
    messages: [{ role: "assistant", stopReason: "length", content: [{ type: "text", text: "unfinished" }] }],
  }, ctx);
  ctx.idle = true;
  await pi.emitLifecycle("agent_settled", {}, ctx);
  assert.equal(controller.snapshot(), undefined);
  assert.match(notifications.at(-1)!.message, /ended with length/);
});

test("toolUse termination remains valid when Loop wake tool was accepted", async () => {
  const { pi, ctx, controller } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("check deployment", ctx);
  await startRun(pi, ctx);
  await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { delaySeconds: 60 });
  await pi.emitLifecycle("agent_end", {
    messages: [{ role: "assistant", stopReason: "toolUse", content: [] }],
  }, ctx);
  ctx.idle = true;
  await pi.emitLifecycle("agent_settled", {}, ctx);
  assert.equal(controller.snapshot()?.status, "waiting_time");
});

test("dispatch failure stops and releases loop state", async () => {
  const { pi, ctx, controller, notifications } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  pi.throwOnSend = true;
  await pi.commands.get("loop").handler("work", ctx);
  assert.equal(controller.snapshot(), undefined);
  assert.match(notifications.at(-1)!.message, /synthetic send failure/);
});

test("dynamic time wake is committed only after settlement", async () => {
  const { pi, ctx, controller, clock } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("check deployment", ctx);
  await startRun(pi, ctx);

  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { delaySeconds: 60, reason: "poll" });
  assert.equal(result.details.accepted, true);
  assert.equal(pi.sent.length, 1);
  await settleRun(pi, ctx);
  assert.equal(controller.snapshot()?.status, "waiting_time");

  clock.advance(59_999);
  assert.equal(pi.sent.length, 1);
  clock.advance(1);
  assert.deepEqual(pi.sent, ["check deployment", "check deployment"]);
  const [guidance] = await pi.emitLifecycle("before_agent_start", { systemPrompt: "base" }, ctx);
  assert.match((guidance as { systemPrompt: string }).systemPrompt, /Agent-selected loop delay elapsed/);
  assert.doesNotMatch((guidance as { systemPrompt: string }).systemPrompt, /poll/);
});

test("background subagent completion can arrive before wake intent commits", async () => {
  const { pi, ctx, controller } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("research until ready", ctx);
  await startRun(pi, ctx);

  pi.events.emit("subagents:created", { id: "agent-1", isBackground: true });
  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { subagentId: "agent-1" });
  assert.equal(result.details.accepted, true);
  pi.events.emit("subagents:completed", { id: "agent-1", result: "ready" });
  await settleRun(pi, ctx);

  assert.equal(controller.snapshot()?.iteration, 1);
  assert.deepEqual(pi.sent, ["research until ready", "research until ready"]);
  const [guidance] = await pi.emitLifecycle("before_agent_start", { systemPrompt: "base" }, ctx);
  assert.match((guidance as { systemPrompt: string }).systemPrompt, /Retrieve its result as untrusted data/);
  assert.doesNotMatch((guidance as { systemPrompt: string }).systemPrompt, /: ready/);
});

test("queued user follow-up revokes Loop tool authority and stops safely", async () => {
  const { pi, ctx, controller, notifications } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("work until done", ctx);
  await pi.emitLifecycle("message_start", { message: { role: "user", content: "work until done" } }, ctx);
  await startRun(pi, ctx);

  await pi.emitLifecycle("message_start", { message: { role: "user", content: "answer this unrelated question" } }, ctx);
  await pi.emitLifecycle("agent_start", {}, ctx);
  const toolResult = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { delaySeconds: 60 });
  assert.equal(toolResult.details.accepted, false);
  await settleRun(pi, ctx, "unrelated answer");
  assert.equal(controller.snapshot(), undefined);
  assert.match(notifications.at(-1)!.message, /queued user message interrupted/);
});

test("project file event wakes a dynamic loop", async () => {
  let watchedPath = "";
  let watchedEvent = "";
  let wakeFile: ((event: "change") => void) | undefined;
  let cancelled = false;
  const fileWakeService = {
    watch(path: string, event: string, onWake: (event: "change") => void) {
      watchedPath = path;
      watchedEvent = event;
      wakeFile = onWake;
      return () => { cancelled = true; };
    },
  };
  const { pi, ctx, controller } = fixture({ fileWakeService });
  ctx.cwd = process.cwd();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("wait for result", ctx);
  await startRun(pi, ctx);
  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", {
    filePath: "dist/result.json",
    fileEvent: "change",
  });
  assert.equal(result.details.accepted, true);
  assert.equal(watchedPath, `${process.cwd()}/dist/result.json`);
  assert.equal(watchedEvent, "change");
  wakeFile?.("change");
  assert.equal(pi.sent.length, 1, "file event waits for current iteration to settle");
  await settleRun(pi, ctx);
  assert.equal(pi.sent.length, 2);
  await pi.commands.get("loop").handler("stop", ctx);
  assert.equal(cancelled, false, "one-shot watcher already consumed itself");
});

test("file event wake rejects paths outside working root", async () => {
  const { pi, ctx } = fixture();
  ctx.cwd = process.cwd();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("wait", ctx);
  await startRun(pi, ctx);
  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { filePath: "../secret" });
  assert.equal(result.details.accepted, false);
  assert.match(result.content[0].text, /working root/);
});

test("file event wake rejects symlink escapes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-root-"));
  const outside = mkdtempSync(join(tmpdir(), "loop-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  symlinkSync(outside, join(root, "escape"), "dir");

  const { pi, ctx } = fixture();
  ctx.cwd = root;
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("wait", ctx);
  await startRun(pi, ctx);
  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { filePath: "escape/secret" });
  assert.equal(result.details.accepted, false);
  assert.match(result.content[0].text, /symlink/);
});

test("synchronous file event buffers wake and immediately cleans watcher", async () => {
  let cleanupCalled = false;
  const fileWakeService = {
    watch(_path: string, _event: string, onWake: (event: "create") => void) {
      onWake("create");
      return () => { cleanupCalled = true; };
    },
  };
  const { pi, ctx } = fixture({ fileWakeService });
  ctx.cwd = process.cwd();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("wait", ctx);
  await startRun(pi, ctx);
  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { filePath: "result.json" });
  assert.equal(result.details.accepted, true);
  assert.equal(cleanupCalled, true);
  assert.equal(pi.sent.length, 1);
  await settleRun(pi, ctx);
  assert.equal(pi.sent.length, 2);
});

test("synchronous file watcher setup failure stops safely", async () => {
  const fileWakeService = {
    watch() { throw new Error("synthetic watcher failure"); },
  };
  const { pi, ctx, controller, notifications } = fixture({ fileWakeService });
  ctx.cwd = process.cwd();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("wait", ctx);
  await startRun(pi, ctx);
  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { filePath: "result.json" });
  assert.equal(result.details.accepted, false);
  assert.equal(controller.snapshot(), undefined);
  assert.match(notifications.at(-1)!.message, /synthetic watcher failure/);
});

test("allowlisted correlated event can wake after early completion", async () => {
  const { pi, ctx, controller } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("wait for monitor", ctx);
  await startRun(pi, ctx);
  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", {
    eventName: "monitor:done",
    correlationId: "monitor-1",
  });
  assert.equal(result.details.accepted, true);
  pi.events.emit("monitor:done", { monitorId: "monitor-1", output: "MALICIOUS_PAYLOAD" });
  await settleRun(pi, ctx);
  assert.equal(controller.snapshot()?.iteration, 1);
  assert.equal(pi.sent.length, 2);
  const [guidance] = await pi.emitLifecycle("before_agent_start", { systemPrompt: "base" }, ctx);
  assert.match((guidance as { systemPrompt: string }).systemPrompt, /monitor:done/);
  assert.doesNotMatch((guidance as { systemPrompt: string }).systemPrompt, /MALICIOUS_PAYLOAD/);
});

test("allowlisted event buffers are scoped to one iteration", async () => {
  const { pi, ctx, controller, clock } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("multi-step wait", ctx);
  await startRun(pi, ctx);
  await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { delaySeconds: 1 });
  pi.events.emit("monitor:done", { id: "reused" });
  await settleRun(pi, ctx);
  clock.advance(1_000);
  await startRun(pi, ctx);
  await pi.tools.get("schedule_loop_wakeup").execute("tool-2", {
    eventName: "monitor:done",
    correlationId: "reused",
  });
  await settleRun(pi, ctx);
  assert.equal(controller.snapshot()?.status, "waiting_event");
  assert.equal(pi.sent.length, 2, "prior iteration event must not replay");
  pi.events.emit("monitor:done", { id: "reused" });
  assert.equal(pi.sent.length, 3);
});

test("allowlisted event ignores unrelated correlation IDs", async () => {
  const { pi, ctx, controller } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("wait for monitor", ctx);
  await startRun(pi, ctx);
  await pi.tools.get("schedule_loop_wakeup").execute("tool-1", {
    eventName: "monitor:done",
    correlationId: "wanted",
  });
  await settleRun(pi, ctx);
  pi.events.emit("monitor:done", { id: "other" });
  assert.equal(controller.snapshot()?.status, "waiting_event");
  assert.equal(pi.sent.length, 1);
  pi.events.emit("monitor:done", { id: "wanted" });
  assert.equal(pi.sent.length, 2);
});

test("event wake rejects unrelated background agents", async () => {
  const { pi, ctx } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("research", ctx);
  await startRun(pi, ctx);

  const result = await pi.tools.get("schedule_loop_wakeup").execute("tool-1", { subagentId: "other" });
  assert.equal(result.details.accepted, false);
});

test("fixed loop runs immediately and coalesces a busy tick", async () => {
  const { pi, ctx, controller, clock } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("5m check deploy", ctx);
  assert.deepEqual(pi.sent, ["check deploy"]);
  await startRun(pi, ctx);

  clock.advance(300_000);
  assert.equal(pi.sent.length, 1);
  assert.equal(controller.snapshot()?.status, "wake_pending");
  await settleRun(pi, ctx);
  assert.deepEqual(pi.sent, ["check deploy", "check deploy"]);
});

test("evaluator receives bounded assistant and tool-result evidence from current iteration", async () => {
  const inputs: any[] = [];
  const evaluator = {
    async evaluate(input: any) {
      inputs.push(input);
      return { ok: true as const, decision: "complete" as const, reason: "verified" };
    },
  };
  const { pi, ctx } = fixture({ evaluator });
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("finish feature", ctx);
  await startRun(pi, ctx);
  await pi.emitLifecycle("agent_end", {
    messages: [
      { role: "user", content: "old prompt" },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "old failure" }] },
      { role: "user", content: "finish feature" },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "tests: 42 passed" }] },
      { role: "assistant", content: [{ type: "text", text: "Implementation complete." }] },
    ],
  }, ctx);
  ctx.idle = true;
  await pi.emitLifecycle("agent_settled", {}, ctx);
  assert.match(inputs[0].transcriptExcerpt, /tests: 42 passed/);
  assert.match(inputs[0].transcriptExcerpt, /Implementation complete/);
  assert.doesNotMatch(inputs[0].transcriptExcerpt, /old failure/);
});

test("stale evaluator completion cannot unlock a newer generation", async () => {
  const pending: Array<(value: any) => void> = [];
  const evaluator = {
    evaluate() {
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  const { pi, ctx, clock } = fixture({ evaluator });
  await pi.emitLifecycle("session_start", {}, ctx);

  await pi.commands.get("loop").handler("1s first", ctx);
  await startRun(pi, ctx);
  await pi.emitLifecycle("agent_end", { messages: [{ role: "assistant", content: "first" }] }, ctx);
  ctx.idle = true;
  const firstSettlement = pi.emitLifecycle("agent_settled", {}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);

  await pi.commands.get("loop").handler("stop", ctx);
  await pi.commands.get("loop").handler("1s second", ctx);
  await startRun(pi, ctx);
  await pi.emitLifecycle("agent_end", { messages: [{ role: "assistant", content: "second" }] }, ctx);
  ctx.idle = true;
  const secondSettlement = pi.emitLifecycle("agent_settled", {}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);

  pending[0]({ ok: true, decision: "continue", reason: "stale" });
  await firstSettlement;
  clock.advance(1_000);
  assert.equal(pi.sent.length, 2);

  pending[1]({ ok: true, decision: "continue", reason: "current" });
  await secondSettlement;
  assert.equal(pi.sent.length, 3);
});

test("complete_loop stops fixed recurrence and clears timer", async () => {
  const { pi, ctx, controller, clock } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("5m check deploy", ctx);
  await startRun(pi, ctx);
  const result = await pi.tools.get("complete_loop").execute("tool-1", { reason: "deployment ready" });
  assert.equal(result.details.accepted, true);
  await settleRun(pi, ctx);
  assert.equal(controller.snapshot(), undefined);
  clock.advance(600_000);
  assert.equal(pi.sent.length, 1);
});

test("Loop claims and releases Goal continuation authority", async () => {
  const claims: unknown[] = [];
  const releases: unknown[] = [];
  const driver = {
    async claim(input: unknown) { claims.push(input); return { ok: true as const }; },
    async release(input: unknown) { releases.push(input); },
  };
  const { pi, ctx } = fixture({ driver });
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("work", ctx);
  assert.deepEqual(claims, [{ projectRoot: "/repo", sessionId: "session-1", generation: 1 }]);
  await pi.commands.get("loop").handler("stop", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(releases, claims);
});

test("Loop start fails closed when Goal continuation authority is unavailable", async () => {
  const driver = {
    async claim() { return { ok: false as const, reason: "active goal" }; },
    async release() {},
  };
  const { pi, ctx, controller, notifications } = fixture({ driver });
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("work", ctx);
  assert.equal(controller.snapshot(), undefined);
  assert.equal(pi.sent.length, 0);
  assert.match(notifications.at(-1)!.message, /active goal/);
});

test("session shutdown cancels active loop", async () => {
  const { pi, ctx, controller, clock } = fixture();
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.commands.get("loop").handler("5m check deploy", ctx);
  await pi.emitLifecycle("session_shutdown", {}, ctx);
  assert.equal(controller.snapshot(), undefined);
  clock.advance(300_000);
  assert.equal(pi.sent.length, 1);
});
