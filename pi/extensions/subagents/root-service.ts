import type { createManagedSupervisor } from "./manager-service.ts";
import type { Control, Receipt } from "./contracts.ts";
import type { ThreadService } from "./upstream/src/types.ts";

/** Root tools and human navigation share the same admission/protocol boundary. */
export function createRootThreadService(
  service: ReturnType<typeof createManagedSupervisor>,
  control: (request: Control) => Promise<Receipt>,
  caller="/root",
): ThreadService {
  const base = service.manager.scope(caller);
  return {
    ...base,
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
