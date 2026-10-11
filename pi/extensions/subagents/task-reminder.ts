import type { ThreadView } from "./upstream/src/types.ts";
import { displayText } from "./presentation.ts";

const duration = (milliseconds: number) => {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
};

/** A reporting deadline is informational; it neither detects stalls nor changes budgets. */
export function taskReminder(thread: ThreadView, runState?: string, now = Date.now()): { message: string; level: "info" } | undefined {
  if (!["running", "starting"].includes(thread.state)) return;
  const queued = runState === "queued";
  const state = queued ? "queued · waiting for an execution slot" : thread.state === "starting" ? "starting" : "still working";
  const elapsed = duration(now - (thread.lastStartedAt ?? thread.createdAt));
  const activity = queued ? "" : ` · status updated ${duration(now - thread.updatedAt)} ago${thread.status ? ` · ${displayText(thread.status, 120).replace(/\s+/g, " ").trim()}` : ""}`;
  return { level: "info", message: `Subagent ${displayText(thread.path, 96)} · ${state} · elapsed ${elapsed}${activity}. Scheduled progress reminder; execution continues. /agents tasks to inspect.` };
}
