import type { AgentDriver, DriverFactory, DriverOptions } from "./upstream/src/types.ts";
import { TranscriptChannel } from "./upstream/src/orch/transcript.ts";
import type { createSupervisor, StartRequest } from "./supervisor.ts";
import { limits, utf8Bytes } from "./contracts.ts";

type Supervisor = ReturnType<typeof createSupervisor>;
type Handle = { agentId: string; threadId: string; runId: string };

/** Upstream owns public threads; this adapter keeps one shared execution-policy pool. */
export function createManagerDriverFactory(options: {
  supervisor: Supervisor;
  requestFor(path: string, type: string): Omit<StartRequest, "prompt">;
  onAllocated?(path: string, handle: Handle): void;
  onRejected?(path: string, rejection: unknown): void;
  onDriver?(driver: DriverOptions): void;
  consumeResults?: boolean;
}) {
  const supervisor = options.supervisor;
  const cleanups = new Set<Promise<unknown>>();
  const createDriver: DriverFactory = async (driver: DriverOptions): Promise<AgentDriver> => {
    driver.signal.throwIfAborted();
    if (driver.inherited.length || driver.sessionFile || driver.tools.length) throw Error("Unsupported inherited authority or persisted child session");
    options.onDriver?.(driver);
    const request = structuredClone(options.requestFor(driver.path, driver.type.name));
    let handle: Handle | undefined, disposed = false, stopping = false, running = false;
    let output = "", input = 0, tokensOut = 0, cost = 0;
    let pending: Promise<void> | undefined;
    const queued: string[] = [];
    const messages: any[] = [];
    const early: any[] = [];
    let earlyBytes = 0;
    const transcript = new TranscriptChannel(() => messages, 0);
    const accept = (event: any) => {
      if (!handle || event.threadId !== handle.threadId || event.type !== "native") return;
      const native = event.event;
      if (native.type === "message_end") {
        messages.push(structuredClone(native.message));
        while (messages.length > 64 || utf8Bytes(JSON.stringify(messages)) > limits.resultBytesPerRun) messages.shift();
        if (native.message?.role === "assistant") {
          const usage = supervisor.inspect(handle.threadId)?.usage;
          if (usage) { input = usage.input + usage.cacheRead + usage.cacheWrite; tokensOut = usage.output; cost = usage.cost; }
          driver.onEvent({ kind: "usage", inputTokens: input, outputTokens: tokensOut, costUsd: cost });
        }
      }
      transcript.accept(native);
      if (native.type === "tool_execution_start") driver.onEvent({ kind: "activity", text: `Tool: ${native.toolName}` });
    };
    const unsubscribe = supervisor.subscribe(event => {
      if (handle && event.threadId === handle.threadId && event.type === "state" && event.state === "queued" && event.runId !== handle.runId && !queued.includes(event.runId)) queued.push(event.runId);
      if (!handle && running && event.type === "native") {
        const bytes = utf8Bytes(JSON.stringify(event));
        if (early.length < 64 && earlyBytes + bytes <= limits.resultBytesPerRun) {
          early.push(structuredClone(event)); earlyBytes += bytes;
        }
      } else accept(event);
    });
    const control = async (operation: string, message?: string) => {
      if (!handle) return undefined;
      return supervisor.control({ version: 1, operation, threadId: handle.threadId, expectedRunId: handle.runId, ...(message !== undefined ? { message } : {}) });
    };
    const execute = async (message: string) => {
      output = "";
      try {
        if (!handle) {
          const started = await supervisor.start({ ...request, prompt: message,managerPath:driver.path });
          if (!started.ok) { options.onRejected?.(driver.path, started); throw Error(`Subagent admission: ${started.code}`); }
          handle = started;
          options.onAllocated?.(driver.path, started);
          for (const event of early.splice(0)) accept(event);
          earlyBytes = 0;
          const model = supervisor.inspect(handle.threadId)?.model;
          if (model) driver.onEvent({ kind: "settings", model, thinkingLevel: (supervisor.inspect(handle.threadId)?.thinking ?? request.thinking ?? driver.type.thinkingLevel ?? "medium") as any });
        } else {
          const receipt = await control("follow_up", message);
          if (!receipt || receipt.status === "rejected" || !receipt.runId) throw Error(`Subagent resume: ${receipt?.error?.code ?? "unavailable"}`);
          handle = { ...handle, runId: receipt.runId };
          const duplicate = queued.indexOf(handle.runId); if (duplicate >= 0) queued.splice(duplicate, 1);
          options.onAllocated?.(driver.path, handle);
        }
        if (stopping && !disposed) supervisor.suspend(handle.threadId, handle.runId);
        else if (disposed) await control("interrupt");
        for (;;) {
          const [result] = await supervisor.wait([handle.runId]);
          const final = messages.filter(message => message.role === "assistant" && message.stopReason === "stop").at(-1);
          output = driver.shouldPause()?"":result.text || (final?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("").slice(0, 65536);
          if (options.consumeResults !== false) await control("consume");
          const next = queued.shift();
          if (!next) {
            if (!result.complete&&!driver.shouldPause()) throw Error(`Subagent ${result.outcome}; output is incomplete`);
            break;
          }
          // An accepted continuation remains owned even if its predecessor failed.
          // Preserve each raw outcome; public completion follows the last accepted run.
          handle = { ...handle, runId: next };
          options.onAllocated?.(driver.path, handle);
        }
      } finally { running = false; }
    };
    return {
      prompt(message) {
        if (disposed || running) return Promise.reject(Error("Subagent driver is disposed or already running"));
        stopping = false; running = true;
        pending = execute(message); return pending;
      },
      async steer(message) {
        if (disposed) throw Error("Subagent driver is disposed");
        const receipt = await control("steer", message);
        if (!receipt || receipt.status === "rejected") throw Error("Subagent is not ready for steering");
      },
      snapshot: () => structuredClone(messages),
      observeTranscript: listener => transcript.observe(listener),
      output: () => output,
      async abort() { stopping = true; queued.length = 0; if (handle) { const current = supervisor.inspect(handle.threadId); if (current) supervisor.suspend(handle.threadId, current.runId); } },
      dispose() {
        if (disposed) return;
        disposed = true; stopping = true; unsubscribe(); transcript.dispose();
        const cleanup = (async () => { await control("interrupt"); await pending?.catch(() => {}); await control("close"); })();
        cleanups.add(cleanup);
        // Track failures for shutdown; never create an unhandled rejection from a void disposal API.
        void cleanup.catch(() => {});
      },
      async sendUpdate(content) {
        if (disposed) throw Error("Subagent driver is disposed");
        const receipt = await control("message", content);
        if (!receipt || receipt.status === "rejected") throw Error("Subagent message rejected");
      },
    };
  };
  return Object.assign(createDriver, { async shutdown() { await supervisor.dispose(); await Promise.all(cleanups); cleanups.clear(); } });
}
