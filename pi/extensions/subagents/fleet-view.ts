import type { ThreadView } from "./upstream/src/types.ts";
import { displayText } from "./presentation.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Safe display metadata only. Never expose provider errors or raw tool arguments/results. */
export type AgentMetrics = {
  runState?: string;
  turns?: number;
  toolUses?: number;
  totalTokens?: number;
  softTurns?: number;
  hardTurns?: number;
};
export type AgentSelection = { path?: string; identity?: string | number };
export type AgentTone = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";
export type AgentRow = {
  text: string;
  parts?: { text: string; tone: AgentTone }[];
  selection?: AgentSelection;
};

export const agentIdentity = (thread: ThreadView) => thread.costId ?? thread.createdAt;
export const agentLabel = (path: string) => displayText(path.replace(/^\/root\//, ""), 64);
/** Status transitions never reorder the row a user is navigating toward. */
export const orderedAgents = (threads: readonly ThreadView[]) => threads.filter(thread => thread.path !== "/root")
  .sort((a, b) => a.createdAt - b.createdAt || a.path.localeCompare(b.path));
const singleLine = (value: unknown, cap: number) => displayText(value, cap).replace(/\s+/g, " ").trim();
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const tones = new Set(["accent", "success", "warning", "error", "muted", "dim", "text"]);
export const agentTone = (thread: ThreadView): AgentTone => tones.has(thread.color ?? "") ? thread.color as AgentTone : "accent";

export function agentState(thread: ThreadView, metrics?: AgentMetrics): string {
  if (["starting", "running"].includes(thread.state) && metrics?.runState === "queued") return "queued";
  return thread.state;
}

export function agentActivity(thread: ThreadView, metrics?: AgentMetrics): string {
  const state = agentState(thread, metrics);
  if (state === "failed") return "Failed · error details hidden";
  if (state === "queued") return "Waiting for an execution slot";
  return singleLine(thread.status, 120) || (({ running: "Working…", starting: "Starting…", paused: "Waiting for your decision", completed: "Completed", stopped: "Stopped" } as Record<string, string>)[state] ?? state);
}

function elapsed(thread: ThreadView, now: number): string {
  const ms = (finite(thread.elapsedMs) ? thread.elapsedMs : 0) +
    (["starting", "running"].includes(thread.state) && finite(thread.startedAt) ? Math.max(0, now - thread.startedAt) : 0);
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
function tokens(thread: ThreadView, metrics?: AgentMetrics): string | undefined {
  const values: number[] = [];
  if (finite(metrics?.totalTokens)) values.push(metrics.totalTokens);
  if (finite(thread.inputTokens) || finite(thread.outputTokens)) values.push((finite(thread.inputTokens) ? thread.inputTokens : 0) + (finite(thread.outputTokens) ? thread.outputTokens : 0));
  if (!values.length) return undefined;
  const count = Math.max(...values);
  return `${count >= 1000 ? `${(count / 1000).toFixed(1)}k` : Math.floor(count)} tokens`;
}

export function agentStats(thread: ThreadView, metrics?: AgentMetrics, now = Date.now()): string {
  return [
    finite(metrics?.turns) ? `${metrics.turns} turn${metrics.turns === 1 ? "" : "s"}` : undefined,
    finite(metrics?.toolUses) ? `${metrics.toolUses} tool${metrics.toolUses === 1 ? "" : "s"}` : undefined,
    tokens(thread, metrics),
    elapsed(thread, now),
  ].filter(Boolean).join(" · ");
}

/** One task list for idle display and keyboard selection; every worker row is identity-bound. */
export function fleetOverview(
  threads: readonly ThreadView[],
  maxLines: number,
  metrics: (path: string) => AgentMetrics | undefined = () => undefined,
  now = Date.now(),
  options: { width?: number; focused?: AgentSelection; keyboard?: boolean } = {},
): AgentRow[] {
  const limit = Math.max(1, Math.floor(maxLines));
  const width = Math.max(0, Math.floor(options.width ?? 10000));
  const fit = (text: string) => truncateToWidth(text, width, "…");
  const workers = orderedAgents(threads).map(thread => ({ thread, metrics: metrics(thread.path) }));
  if (!workers.length) return [];
  const counts = { running: 0, queued: 0, paused: 0, completed: 0, failed: 0, stopped: 0 };
  for (const worker of workers) {
    const state = agentState(worker.thread, worker.metrics);
    counts[state === "starting" ? "running" : state as keyof typeof counts]++;
  }
  const totals = [
    `${counts.running} running`, `${counts.queued} queued`,
    counts.paused ? `${counts.paused} paused` : undefined,
    counts.completed ? `${counts.completed} done` : undefined,
    counts.failed ? `${counts.failed} failed` : undefined,
    counts.stopped ? `${counts.stopped} stopped` : undefined,
  ].filter(Boolean).join(" · ");
  const selected = options.focused;
  const entries: (typeof workers[number] | undefined)[] = selected ? [undefined, ...workers] : workers;
  const selectedIndex = selected?.path ? Math.max(0, entries.findIndex(worker => worker?.thread.path === selected.path)) : 0;
  function workerRow(worker: typeof workers[number] | undefined, index: number): AgentRow {
    const focused = !!selected && index === selectedIndex;
    if (!worker) return { text: fit(`${focused ? "›" : " "} Main`), selection: {}, parts: [{ text: fit(`${focused ? "›" : " "} Main`), tone: focused ? "accent" : "muted" }] };
    const { thread, metrics: info } = worker, state = agentState(thread, info);
    const symbol = ({ running: "●", starting: "●", queued: "○", paused: "Ⅱ", completed: "✓", failed: "!", stopped: "■" } as Record<string, string>)[state] ?? "·";
    const nameWidth = width >= 20 ? Math.max(1, Math.min(Math.floor(width * 0.4), width - state.length - 3)) : width;
    const lead = truncateToWidth(`${focused ? "› " : ""}${symbol} ${agentLabel(thread.path)}`, nameWidth, "…");
    const rest = truncateToWidth(` · ${state} · ${singleLine(thread.type, 24)} · ${agentStats(thread, info, now)}`, Math.max(0, width - visibleWidth(lead)), "…");
    return { text: lead + rest, parts: [{ text: lead, tone: focused ? "accent" : agentTone(thread) },
      { text: rest, tone: state === "failed" ? "error" : "muted" }], selection: { path: thread.path, identity: agentIdentity(thread) } };
  }
  // Tiny docks show the recipient, never just help for an invisible selection.
  if (limit === 1 && selected) return [workerRow(entries[selectedIndex], selectedIndex)];
  const heading = fit(`Tasks · ${totals}`);
  const rows: AgentRow[] = [{ text: heading, parts: [{ text: heading, tone: "accent" }] }];
  if (limit === 1) return rows;
  const room = limit - 2;
  const perWorker = room >= 2 ? 2 : 1;
  const count = Math.max(selected ? 1 : 0, Math.floor(Math.max(0, room) / perWorker));
  const start = selected ? Math.max(0, Math.min(selectedIndex - count + 1, entries.length - count)) : 0;
  for (const [offset, worker] of entries.slice(start, start + count).entries()) {
    const row = workerRow(worker, start + offset); rows.push(row);
    if (perWorker === 2 && worker) rows.push({ text: fit(`  └ ${agentActivity(worker.thread, worker.metrics)} · ${singleLine(worker.thread.task, 100)}`), selection: row.selection });
  }
  const hidden = Math.max(0, entries.length - count);
  rows.push({ text: fit(`${hidden ? `+${hidden} more · ` : ""}${selected ? "↑↓ select · Enter view · Esc Main" : options.keyboard === false ? "/agents tasks · inspect and steer" : "←/↓ tasks · click to view"}`) });
  return rows.slice(0, limit);
}
