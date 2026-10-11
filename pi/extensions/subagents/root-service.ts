import type { createManagedSupervisor } from "./manager-service.ts";
import { limits, type Control, type Receipt } from "./contracts.ts";
import type { AgentSelection } from "./fleet-view.ts";
import type { TaskControls, TaskTarget } from "./task-controls.ts";
import type { ThreadService } from "./upstream/src/types.ts";

/** Root tools and human navigation share the same admission/protocol boundary. */
export function createRootThreadService(
  service: ReturnType<typeof createManagedSupervisor>,
  control: (request: Control) => Promise<Receipt>,
  caller="/root",
): ThreadService & TaskControls {
  const base = service.manager.scope(caller);
  function taskTarget(selection: AgentSelection): TaskTarget | undefined {
    if (!selection.path || selection.path === caller || selection.identity === undefined) return;
    try {
      const view = base.get(selection.path);
      if ((view.costId ?? view.createdAt) !== selection.identity) return;
      const handle = service.handleFor(view.path), current = handle && service.inspect(handle.threadId);
      if (handle && current) return { path: view.path, identity: selection.identity, threadId: handle.threadId, runId: current.runId };
    } catch { /* A reaped/replaced task cannot acquire a new target. */ }
  }
  return {
    ...base,
    taskTarget,
    async sendTask(target, mode, message) {
      const current = taskTarget(target);
      if (!current || current.threadId !== target.threadId || current.runId !== target.runId)
        return { status: "rejected", reason: "stale_target" };
      if (!["steer", "follow_up"].includes(mode) || typeof message !== "string" || !message.trim() || Buffer.byteLength(message, "utf8") > limits.mailboxBytesPerThread)
        return { status: "rejected", reason: "invalid_message" };
      try {
        const receipt = await control({ version: 1, operation: mode, threadId: target.threadId, expectedRunId: target.runId, message });
        return { status: receipt.status, receipt, ...(receipt.error?.code === "stale_run" ? { reason: "stale_target" as const } : {}) };
      } catch { return { status: "unknown_delivery" }; }
    },
    async spawn() { throw Error("Use the reviewed agent_spawn admission adapter"); },
    async steer(path, message, timeoutMs) {
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 300000))
        throw Error("Invalid report-only timeout");
      if (message === undefined) return base.steer(path, undefined, timeoutMs);
      if (typeof message !== "string" || !message.trim()) throw Error("Steering message must not be empty");
      const view = base.get(path);
      const handle = service.handleFor(view.path);
      const current = handle && service.inspect(handle.threadId);
      if (!handle || !current) throw Error("Subagent is not ready for steering");
      const receipt = await control({ version: 1, operation: current.result ? "follow_up" : "steer",
        threadId: handle.threadId, expectedRunId: current.runId, message });
      if (receipt.status === "rejected") throw Error(`Subagent steering: ${receipt.error?.code ?? "rejected"}`);
      const next = base.get(view.path);
      // A fast continuation may already be settled; never launch just to re-arm a timer.
      if (timeoutMs !== undefined && ["starting", "running"].includes(next.state))
        return base.steer(view.path, undefined, timeoutMs);
      return next;
    },
  };
}
