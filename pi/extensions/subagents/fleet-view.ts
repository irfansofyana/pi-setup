import type { ThreadView } from "./upstream/src/types.ts";
import { displayText } from "./presentation.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Safe display metadata only. Never expose provider errors or raw tool arguments/results. */
export type AgentMetrics = {
  name?: string;
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
  action?: "review";
  parts?: { text: string; tone: AgentTone }[];
  selection?: AgentSelection;
};

export function completionGrace(thread: ThreadView, now = Date.now()): boolean {
  return ["completed", "stopped"].includes(thread.state) && now - thread.updatedAt < 5000;
}

export const agentIdentity = (thread: ThreadView) => thread.costId ?? thread.createdAt;
export const agentLabel = (path: string, name?: string) => displayText((name?.trim() || path).split("/").at(-1) || path, 48);
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
  if (state === "completed" || state === "stopped") return "Session retained · follow-up uses remaining budget";
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

/** Resting summary: completed lifetimes remain accessible without taking individual rows. */
export function compactFleetOverview(
  threads: readonly ThreadView[], maxLines: number,
  metrics: (path: string) => AgentMetrics | undefined = () => undefined,
  options: { width?: number; unread?(thread: ThreadView): number } = {},
): AgentRow[] {
  const all = orderedAgents(threads);
  const limit = Math.max(0, Math.floor(maxLines));
  if (!all.length || !limit) return [];
  const width = Math.max(0, options.width ?? 10000);
  const fit = (text: string) => truncateToWidth(text, width, "…");
  const counts = new Map<string, number>();
  let unread = 0;
  for (const thread of all) {
    const state = agentState(thread, metrics(thread.path));
    const label = state === "starting" ? "running" : state;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    unread += options.unread?.(thread) ?? 0;
  }
  const labels = ["failed", "paused", "running", "queued", "completed", "stopped"]
    .filter(state => counts.has(state)).map(state => `${counts.get(state)} ${state}`);
  if (unread) labels.push(`${unread} unread`);
  const heading = fit(`Subagents · ${labels.join(" · ")}`);
  const rows: AgentRow[] = [{ text: heading, action: "review", parts: [{ text: heading, tone: counts.has("failed") ? "error" : counts.has("paused") ? "warning" : "muted" }] }];
  const attention = (thread: ThreadView) => ["failed", "paused"].includes(thread.state) ? 0 : 1;
  const active = all.filter(thread => !["completed", "stopped"].includes(thread.state)).sort((a, b) => attention(a) - attention(b));
  for (const thread of active.slice(0, limit - 1)) {
    const info = metrics(thread.path), state = agentState(thread, info);
    const symbol = state === "failed" ? "!" : state === "paused" ? "Ⅱ" : state === "queued" ? "○" : "●";
    const lead = truncateToWidth(`  ${symbol} ${agentLabel(thread.path, info?.name)}`, Math.max(1, Math.floor(width * 0.45)), "…");
    const detail = truncateToWidth(` · ${state === "paused" ? "Waiting for your decision" : agentActivity(thread, info)}`, Math.max(0, width - visibleWidth(lead)), "…");
    const tone = state === "failed" ? "error" : state === "paused" ? "warning" : "muted";
    rows.push({ text: lead + detail, parts: [{ text: lead, tone }, { text: detail, tone }], selection: { path: thread.path, identity: agentIdentity(thread) } });
  }
  return rows;
}

/** One task list for idle display and keyboard selection; every worker row is identity-bound. */
export function fleetOverview(
  threads: readonly ThreadView[],
  maxLines: number,
  metrics: (path: string) => AgentMetrics | undefined = () => undefined,
  now = Date.now(),
  options: { width?: number; focused?: AgentSelection; keyboard?: boolean; collapseCompleted?: boolean; unread?(thread: ThreadView): number } = {},
): AgentRow[] {
  const limit = Math.max(1, Math.floor(maxLines));
  const width = Math.max(0, Math.floor(options.width ?? 10000));
  const fit = (text: string) => truncateToWidth(text, width, "…");
  const all = orderedAgents(threads);
  if (!all.length) return [];
  const folded = options.collapseCompleted && !options.focused
    ? all.filter(thread => ["completed", "stopped"].includes(thread.state) && !completionGrace(thread, now)) : [];
  const foldedUnread = folded.reduce((sum, thread) => sum + (options.unread?.(thread) ?? 0), 0);
  const workers = all.filter(thread => !folded.includes(thread)).map(thread => ({ thread, metrics: metrics(thread.path) }));
  const reviewHint = options.keyboard === false ? "/agents tasks" : "←/↓ review";
  if (!workers.length) {
    const completed = folded.filter(thread => thread.state === "completed").length;
    const stopped = folded.length - completed;
    const summary = [completed ? `✓ ${completed} subagent${completed === 1 ? "" : "s"} completed` : "",
      stopped ? `${stopped} stopped` : ""].filter(Boolean).join(" · ");
    return [{ text: fit(`${summary}${foldedUnread ? ` · ${foldedUnread} new` : ""} · ${reviewHint}`), action: "review" }];
  }
  const counts = { running: 0, queued: 0, paused: 0, completed: 0, failed: 0, stopped: 0 };
  for (const worker of workers) {
    const state = agentState(worker.thread, worker.metrics);
    counts[state === "starting" ? "running" : state as keyof typeof counts]++;
  }
  const totals = [
    counts.running ? `${counts.running} running` : undefined, counts.queued ? `${counts.queued} queued` : undefined,
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
    const lead = truncateToWidth(`${focused ? "› " : ""}${symbol} ${agentLabel(thread.path, info?.name)}`, nameWidth, "…");
    const unread = options.unread?.(thread) ?? 0;
    const rest = truncateToWidth(` · ${state}${unread ? ` · ${unread} new` : ""} · ${singleLine(thread.type, 24)} · ${elapsed(thread, now)}`, Math.max(0, width - visibleWidth(lead)), "…");
    return { text: lead + rest, parts: [{ text: lead, tone: focused ? "accent" : agentTone(thread) },
      { text: rest, tone: state === "failed" ? "error" : "muted" }], selection: { path: thread.path, identity: agentIdentity(thread) } };
  }
  // Tiny docks show the recipient, never just help for an invisible selection.
  if (limit === 1 && selected) return [workerRow(entries[selectedIndex], selectedIndex)];
  const heading = fit(`Subagents · ${totals}`);
  const rows: AgentRow[] = [{ text: heading, parts: [{ text: heading, tone: "accent" }] }];
  if (limit === 1) return rows;
  const room = limit - 2;
  const perWorker = room >= 2 ? 2 : 1;
  const count = Math.max(selected ? 1 : 0, Math.floor(Math.max(0, room) / perWorker));
  const start = selected ? Math.max(0, Math.min(selectedIndex - count + 1, entries.length - count)) : 0;
  for (const [offset, worker] of entries.slice(start, start + count).entries()) {
    const row = workerRow(worker, start + offset); rows.push(row);
    if (perWorker === 2 && worker && !["completed", "stopped"].includes(worker.thread.state)) rows.push({ text: fit(`  └ ${agentActivity(worker.thread, worker.metrics)}`), selection: row.selection });
  }
  const hidden = Math.max(0, entries.length - count);
  const foldedLabel = [folded.filter(thread => thread.state === "completed").length,
    folded.filter(thread => thread.state === "stopped").length]
    .map((count, i) => count ? `${count} ${i === 0 ? "completed" : "stopped"}` : "").filter(Boolean).join(" · ");
  rows.push({ text: fit(`${hidden ? `+${hidden} more · ` : ""}${foldedLabel ? `${foldedLabel} · ` : ""}${foldedUnread ? `${foldedUnread} new · ` : ""}${selected ? "↑↓ select · Enter view · Esc Main" : folded.length ? reviewHint : options.keyboard === false ? "/agents tasks · inspect and steer" : "←/↓ subagents · click to view"}`),
    ...(folded.length ? { action: "review" as const } : {}) });
  return rows.slice(0, limit);
}
