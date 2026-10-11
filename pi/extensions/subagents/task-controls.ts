import type { Receipt } from "./contracts.ts";
import type { AgentSelection } from "./fleet-view.ts";
import type { ThreadService } from "./upstream/src/types.ts";

export type TaskDeliveryMode = "steer" | "follow_up";
export type TaskTarget = Required<AgentSelection> & { threadId: string; runId: string };
export type TaskDelivery = { status: Receipt["status"]; receipt?: Receipt; reason?: "stale_target" | "invalid_message" | "unavailable" };
export type TaskControls = {
  taskTarget(selection: AgentSelection): TaskTarget | undefined;
  sendTask(target: TaskTarget, mode: TaskDeliveryMode, message: string): Promise<TaskDelivery>;
};
export type TaskService = ThreadService & Partial<TaskControls>;

export function deliveryNotice(delivery: TaskDelivery): string {
  switch (delivery.status) {
    case "queued": return "Queued for delivery; model consumption is not confirmed.";
    case "handled": case "applied": return "Delivered to the agent runtime; model consumption is not confirmed.";
    case "accepted": return "Accepted for delivery; model consumption is not confirmed.";
    case "unknown_delivery": return "Delivery uncertain. Draft kept; inspect the task, then R to allow retry.";
    case "rejected": return delivery.reason === "stale_target"
      ? "Task run changed. Message rejected; draft kept. Reopen the composer to review the target."
      : "Message rejected. Draft kept; check task state or remaining budget.";
  }
}
