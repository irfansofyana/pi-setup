import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseShell } from "shell-quote";
import {
  type ExtensionCommandContext,
  type ExtensionContext,
  getSelectListTheme,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  colorToRgb,
  rgbColor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  AGENT_COLORS,
  ConfigStore,
  diffAgentSettings,
  parseAgentType,
  serializeAgentType,
} from "../prefs/config.ts";
import { editModelPreferences, MODEL_EDITOR_CANCEL } from "./model-picker.ts";
import { editToolSelection, TOOL_EDITOR_CANCEL, type ToolEditorOptions } from "./tool-picker.ts";
import {
  canOpenDialog,
  dialogEditor,
  dialogMenu,
  dialogHeight,
  frameDialog,
  DIALOG_OPTIONS,
  withDialogSession,
} from "./dialog.ts";
import { getModelPreferences } from "../prefs/models.ts";
import type { LoaderStyle, WidgetMode } from "../prefs/settings.ts";
import { AGENT_PROGRESS_INTERVAL, agentProgressIcon, isAgentLoaderGlyph } from "./agent-loader.ts";
export { AGENT_PROGRESS_INTERVAL, agentProgressIcon } from "./agent-loader.ts";
import { buildStatusTree, lastStarted, type StatusRow } from "./thread-tree.ts";
import { THINKING_LEVELS, type AgentType, type ThreadService, type ThreadView } from "../types.ts";

export type ThreadController = Pick<
  ThreadService,
  "list" | "get" | "output" | "transcript" | "observeTranscript" | "steer" | "stop"
>;

/** Plain terminal-safe text: never pass agent-supplied terminal commands through. */
export function sanitizeText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

type AgentBadgeTheme = Pick<Theme, "fg" | "colors" | "style">;

/** Selected type token, or accent when unset or unknown. Shared by the pill and path. */
function agentColorToken(color: string | undefined): ThemeColor {
  return AGENT_COLORS.includes(color as (typeof AGENT_COLORS)[number])
    ? (color as ThemeColor)
    : "accent";
}

/** Background pill with bold contrasting text and padding. Label is sanitized. */
function contrastPill(label: string, color: string | undefined, theme: AgentBadgeTheme): string {
  const background = theme.colors[agentColorToken(color)];
  const { r, g, b } = colorToRgb(background);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  // Pick whichever of black/white has the higher WCAG contrast ratio.
  const foreground = luminance > Math.sqrt(0.0525) - 0.05 ? 0 : 255;
  return theme.style(` ${sanitizeText(label)} `, {
    bg: background,
    fg: rgbColor(foreground, foreground, foreground),
    bold: true,
  });
}

/** Invalid/untrusted saved icons never reach the terminal. Names remain readable. */
export function agentTypeLabel(
  type: string,
  icon?: string,
  nerdFontIcons = false,
  loaderIcon?: string,
): string {
  const role =
    nerdFontIcons && typeof icon === "string" && /^\p{Co}$/u.test(icon) ? `${icon} ` : "";
  const progress =
    nerdFontIcons && loaderIcon && isAgentLoaderGlyph(loaderIcon) ? `${loaderIcon} ` : "";
  return `${progress}${role}${sanitizeText(type)}`;
}

export function agentTypeBadge(
  type: string,
  color: string | undefined,
  theme: AgentBadgeTheme,
  icon?: string,
  nerdFontIcons = false,
  loaderIcon?: string,
): string {
  return contrastPill(agentTypeLabel(type, icon, nerdFontIcons, loaderIcon), color, theme);
}

function agentPath(path: string, color: string | undefined, theme: AgentBadgeTheme): string {
  return theme.fg(agentColorToken(color), sanitizeText(path));
}

function metricCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Settled active time plus the current live run, only while starting or running. */
function elapsedTotal(thread: ThreadView, now = Date.now()): number {
  const live =
    typeof thread.startedAt === "number" &&
    Number.isFinite(thread.startedAt) &&
    (thread.state === "starting" || thread.state === "running")
      ? now - thread.startedAt
      : 0;
  const total = metricCount(thread.elapsedMs) + live;
  return Number.isFinite(total) ? total : 0;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600) % 24;
  const days = Math.floor(total / 86400);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

const compactCount = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCount(value: number | undefined): string {
  // Intl emits uppercase units (`1.2K`); the widget uses lowercase.
  return compactCount.format(metricCount(value)).toLowerCase();
}

export function threadMetrics(thread: ThreadView, now = Date.now()): string {
  const cost = thread.costUsd === undefined ? "" : ` $${thread.costUsd.toFixed(4)}`;
  return `${formatDuration(elapsedTotal(thread, now))} ↑${formatCount(thread.inputTokens)} ↓${formatCount(thread.outputTokens)}${cost}`;
}

/** Keep the right-hand counters intact; truncate the left side to the remaining columns. */
function fitLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");
  const fitted = truncateToWidth(left, width - rightWidth - 1);
  const pad = width - visibleWidth(fitted) - rightWidth;
  return fitted + " ".repeat(Math.max(0, pad)) + right;
}

function isLive(thread: ThreadView): boolean {
  return thread.path !== "/root" && (thread.state === "starting" || thread.state === "running");
}

export function renderThreads(
  threads: ThreadView[],
  width: number,
  theme: AgentBadgeTheme,
  nerdFontIcons = false,
  loaderStyle: LoaderStyle = "circle",
): string[] {
  const priority = (thread: ThreadView) =>
    thread.state === "starting" || thread.state === "running"
      ? 0
      : thread.state === "paused"
        ? 1
        : 2;
  const visible = threads
    .filter((thread) => thread.path !== "/root")
    .sort(
      (a, b) => priority(a) - priority(b) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
    );
  const limit = visible.length > 8 ? 7 : 8;
  const lines = visible.slice(0, limit).map((thread) => {
    const stateColor =
      thread.state === "failed" ? "error" : thread.state === "paused" ? "warning" : "accent";
    const badge = agentTypeBadge(
      thread.type,
      thread.color,
      theme,
      thread.icon,
      nerdFontIcons,
      agentProgressIcon(thread, nerdFontIcons, Date.now(), true, loaderStyle),
    );
    const path = agentPath(thread.path, thread.color, theme);
    const state = theme.fg(stateColor, `[${sanitizeText(thread.state)}]`);
    const left = `${badge} ${path} ${state} ${sanitizeText(thread.status || thread.task)}`;
    return fitLine(left, theme.fg("muted", threadMetrics(thread)), Math.max(0, width));
  });
  if (visible.length > limit) {
    lines.push(
      truncateToWidth(
        theme.fg("muted", `+${visible.length - limit} more threads · /agents tree`),
        Math.max(0, width),
      ),
    );
  }
  return lines;
}

const WIDGET_ROOT = "/root";
const MAX_WIDGET_LINES = 12;
const AGENT_WIDGET_PLACEMENT = { placement: "aboveEditor" as const };
const AGENT_BROWSER_HINT = "Press ← to open subagent browser";

interface AgentWidgetRenderOptions {
  /** RPC widgets cannot open a terminal browser. */
  showBrowserHint?: boolean;
  nerdFontIcons?: boolean;
  loaderStyle?: LoaderStyle;
  /** RPC snapshots use a static running frame and never start an animation. */
  animate?: boolean;
}

function agentWidgetStatus(
  running: number,
  omitted: number,
  width: number,
  theme: Pick<Theme, "fg">,
  showBrowserHint: boolean,
): string {
  const details = [
    omitted > 0 ? `+${omitted} more agents` : "",
    showBrowserHint && running > 0 ? AGENT_BROWSER_HINT : "",
    showBrowserHint ? "→ collapse" : "",
  ].filter(Boolean);
  return truncateToWidth(
    theme.fg("accent", `${running} running`) +
      (details.length ? theme.fg("muted", ` · ${details.join(" · ")}`) : ""),
    width,
    "",
  );
}

function statePriority(state: ThreadView["state"] | undefined): number {
  if (state === "starting" || state === "running") return 0;
  if (state === "paused") return 1;
  return 2;
}

function agentStateColor(state: ThreadView["state"]): "error" | "warning" | "accent" {
  return state === "failed" ? "error" : state === "paused" ? "warning" : "accent";
}

function agentLine(
  row: StatusRow,
  width: number,
  theme: AgentBadgeTheme,
  nerdFontIcons: boolean,
  animate: boolean,
  loaderStyle: LoaderStyle,
): string {
  const thread = row.thread!;
  const badge = agentTypeBadge(
    thread.type,
    thread.color,
    theme,
    thread.icon,
    nerdFontIcons,
    agentProgressIcon(thread, nerdFontIcons, Date.now(), animate, loaderStyle),
  );
  const left = `${row.prefix}${badge} ${agentPath(thread.path, thread.color, theme)} ${theme.fg(agentStateColor(thread.state), `[${sanitizeText(thread.state)}]`)} ${sanitizeText(thread.task)}`;
  return fitLine(left, theme.fg("muted", threadMetrics(thread)), width);
}

function placeholderLine(row: StatusRow, width: number, theme: AgentBadgeTheme): string {
  return truncateToWidth(
    `${row.prefix}${theme.fg("muted", `${sanitizeText(row.path)}  missing parent`)}`,
    width,
    "",
  );
}

function takeWidgetRows(rows: StatusRow[], budget: number): StatusRow[] {
  const parents = new Map<number, number[]>();
  const stack: number[] = [];
  for (const [index, row] of rows.entries()) {
    while (stack.length && rows[stack[stack.length - 1]!]!.prefix.length >= row.prefix.length)
      stack.pop();
    parents.set(index, [...stack]);
    stack.push(index);
  }
  const rowCost = (row: StatusRow) => (row.path === WIDGET_ROOT ? 0 : 1);
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.thread && row.path !== WIDGET_ROOT)
    .sort(
      (a, b) =>
        statePriority(a.row.thread!.state) - statePriority(b.row.thread!.state) ||
        lastStarted(b.row.thread) - lastStarted(a.row.thread) ||
        a.index - b.index,
    );
  const chosen = new Set<number>();
  let used = 0;
  for (const { index } of candidates) {
    const needed = [...parents.get(index)!, index].filter((ancestor) => !chosen.has(ancestor));
    const cost = needed.reduce((total, ancestor) => total + rowCost(rows[ancestor]!), 0);
    if (used + cost > budget) continue;
    for (const ancestor of needed) chosen.add(ancestor);
    used += cost;
  }
  // If a missing-parent chain cannot fit its agent, retain a useful tree prefix.
  if (!chosen.size) {
    for (const [index, row] of rows.entries()) {
      const cost = rowCost(row);
      if (used + cost > budget) break;
      chosen.add(index);
      used += cost;
    }
  }
  return rows.filter((row, index) => row.path !== WIDGET_ROOT && chosen.has(index));
}

/** Themed agent tree above the editor. Synthetic /root is the main conversation and is omitted. */
export function renderAgentTree(
  threads: ThreadView[],
  width: number,
  theme: AgentBadgeTheme,
  {
    showBrowserHint = true,
    nerdFontIcons = false,
    animate = true,
    loaderStyle = "circle",
  }: AgentWidgetRenderOptions = {},
): string[] {
  const columns = Math.max(0, width);
  const rows = buildStatusTree(threads, new Set());
  const agents = rows.filter((row) => row.thread && row.path !== WIDGET_ROOT);
  if (!agents.length) return [];
  const live = agents.filter(
    (row) => row.thread!.state === "starting" || row.thread!.state === "running",
  ).length;
  const paused = agents.filter((row) => row.thread!.state === "paused").length;
  const heading = fitLine(
    theme.fg("accent", "Agents"),
    theme.fg("muted", `${live} live · ${paused} paused`),
    columns,
  );
  // Reserve the last line for status and browser entry, even with no omissions.
  const visible = takeWidgetRows(rows, MAX_WIDGET_LINES - 2);
  const omitted = agents.length - visible.filter((row) => row.thread).length;
  const lines = [heading];
  for (const row of visible) {
    if (!row.thread) {
      lines.push(placeholderLine(row, columns, theme));
      continue;
    }
    lines.push(agentLine(row, columns, theme, nerdFontIcons, animate, loaderStyle));
  }
  lines.push(agentWidgetStatus(live, omitted, columns, theme, showBrowserHint));
  return lines;
}

/** One-line counts for real agents; starting agents count as running, including tokens. */
export function renderAgentSummary(
  threads: ThreadView[],
  width: number,
  theme: Pick<Theme, "fg">,
  {
    showBrowserHint = true,
    nerdFontIcons = false,
    animate = true,
    loaderStyle = "circle",
  }: AgentWidgetRenderOptions = {},
): string[] {
  const agents = new Map<string, ThreadView>();
  for (const thread of threads) {
    if (thread?.path && thread.path !== WIDGET_ROOT && !agents.has(thread.path))
      agents.set(thread.path, thread);
  }
  if (!agents.size) return [];

  const counts: Record<Exclude<ThreadView["state"], "starting">, number> = {
    running: 0,
    stopped: 0,
    failed: 0,
    paused: 0,
    completed: 0,
  };
  let input = 0;
  let output = 0;
  for (const thread of agents.values()) {
    counts[thread.state === "starting" ? "running" : thread.state] += 1;
    if (isLive(thread)) {
      input += metricCount(thread.inputTokens);
      output += metricCount(thread.outputTokens);
    }
  }
  const statuses: [keyof typeof counts, ThemeColor][] = [
    ["running", "accent"],
    ["stopped", "muted"],
    ["failed", "error"],
    ["paused", "warning"],
    ["completed", "success"],
  ];
  const left =
    statuses
      .filter(([state]) => state === "running" || counts[state] > 0)
      .map(([state, color]) => {
        const progress =
          counts[state] > 0
            ? agentProgressIcon({ state }, nerdFontIcons, Date.now(), animate, loaderStyle)
            : undefined;
        return theme.fg(color, `${progress ? `${progress} ` : ""}${counts[state]} ${state}`);
      })
      .join(theme.fg("muted", ", ")) +
    (showBrowserHint && counts.running > 0 ? theme.fg("muted", " · ← browser") : "");
  const right = theme.fg("muted", `↑${formatCount(input)} ↓${formatCount(output)}`);
  return [fitLine(left, right, Math.max(0, width))];
}

export function updateWidget(
  ctx: ExtensionContext,
  threads: ThreadView[],
  mode: WidgetMode = "full",
  nerdFontIcons = false,
  rootTurnEnded = false,
  loaderStyle: LoaderStyle = "circle",
  showBrowserHint = true,
): void {
  if (!ctx.hasUI) return;
  if (!threads.some((thread) => thread.path !== "/root")) {
    ctx.ui.setWidget("pi-subagent", undefined, AGENT_WIDGET_PLACEMENT);
    return;
  }
  // Retain the tree while either the main turn or any subagent is still active.
  const settled = rootTurnEnded && !threads.some(isLive);
  const render = mode === "minimal" || settled ? renderAgentSummary : renderAgentTree;
  // RPC hosts accept string widgets only; a component factory is ignored.
  if (ctx.mode === "rpc") {
    ctx.ui.setWidget(
      "pi-subagent",
      render(threads, 80, ctx.ui.theme, {
        showBrowserHint: false,
        nerdFontIcons,
        loaderStyle,
        animate: false,
      }),
      AGENT_WIDGET_PLACEMENT,
    );
    return;
  }
  const snapshot = threads.map((thread) => ({ ...thread }));
  ctx.ui.setWidget(
    "pi-subagent",
    (tui) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      if (snapshot.some(isLive) && (mode === "full" || nerdFontIcons)) {
        timer = setInterval(
          () => tui.requestRender(),
          nerdFontIcons ? AGENT_PROGRESS_INTERVAL : 1000,
        );
        timer.unref();
      }
      return {
        render: (width) =>
          render(snapshot, width, ctx.ui.theme, {
            showBrowserHint: !settled && showBrowserHint,
            nerdFontIcons,
            loaderStyle,
          }),
        invalidate: () => {},
        dispose: () => {
          if (timer) clearInterval(timer);
          timer = undefined;
        },
      };
    },
    AGENT_WIDGET_PLACEMENT,
  );
}

export async function showThreads(
  ctx: ExtensionContext,
  controller: ThreadController,
  path?: string,
): Promise<void> {
  if (!ctx.hasUI) return;
  let selectedPath = path;
  while (true) {
    try {
      if (!selectedPath) {
        const threads = controller.list().filter((thread) => thread.path !== "/root");
        if (!threads.length) {
          ctx.ui.notify("No subagent threads.", "info");
          return;
        }
        const labels = threads.map(
          (thread) =>
            `${sanitizeText(thread.path)} [${sanitizeText(thread.state)}] ${sanitizeText(thread.status)}`,
        );
        const selected = await ctx.ui.select("Subagent threads", labels);
        if (selected === undefined) return;
        selectedPath = threads[labels.indexOf(selected)]?.path;
        if (!selectedPath) return;
      }
      if (selectedPath === "/root")
        throw new Error("/root is the current Pi thread, not a subagent.");
      const thread = controller.get(selectedPath);
      const children = controller.list().filter((child) => child.parent === selectedPath);
      const title = `${sanitizeText(thread.path)} [${sanitizeText(thread.state)}] ${sanitizeText(thread.status)}`;
      const action = await ctx.ui.select(title, [
        "View output",
        "View transcript",
        "Send input / resume",
        "Stop",
        ...(children.length ? ["Children"] : []),
        "Back",
      ]);
      if (!action || action === "Back") {
        if (path) return;
        selectedPath = undefined;
        continue;
      }
      if (action === "View output" || action === "View transcript") {
        const text =
          action === "View output"
            ? controller.output(selectedPath)
            : await controller.transcript(selectedPath);
        // Built-in editor is a portable viewer; edits are explicitly discarded.
        await ctx.ui.editor(
          `${sanitizeText(selectedPath)} — READ ONLY (changes discarded)`,
          text.split("\n").map(sanitizeText).join("\n"),
        );
      } else if (action === "Send input / resume") {
        const message = await ctx.ui.editor("Send input / resume retained session", "");
        if (message?.trim()) await controller.steer(selectedPath, message);
      } else if (action === "Stop") {
        if (
          await ctx.ui.confirm(
            "Stop thread",
            `Stop ${sanitizeText(selectedPath)} and its descendants?`,
          )
        )
          await controller.stop(selectedPath);
      } else if (action === "Children") {
        const labels = children.map(
          (child) =>
            `${sanitizeText(child.path)} [${sanitizeText(child.state)}] ${sanitizeText(child.status)}`,
        );
        const selected = await ctx.ui.select("Children", labels);
        if (selected !== undefined)
          selectedPath = children[labels.indexOf(selected)]?.path ?? selectedPath;
      }
    } catch (error) {
      ctx.ui.notify(sanitizeText(error instanceof Error ? error.message : String(error)), "error");
      return;
    }
  }
}

/** Parse editor argv, rejecting shell operators instead of evaluating a shell command. */
export function editorArguments(command: string): string[] {
  const args = parseShell(command, process.env);
  if (!args.length || args.some((arg) => typeof arg !== "string") || !args[0]) {
    throw new Error(
      "VISUAL/EDITOR must be an executable and arguments, without shell operators or globs.",
    );
  }
  return args as string[];
}

async function externalEdit(ctx: ExtensionCommandContext, text: string): Promise<string> {
  if (ctx.mode !== "tui") throw new Error("External editing requires interactive TUI mode.");
  const [command, ...args] = editorArguments(process.env.VISUAL || process.env.EDITOR || "vi");
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const file = join(directory, "agent.md");
  try {
    await writeFile(file, text, "utf8");
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      tui.stop();
      try {
        const result = spawnSync(command!, [...args, file], {
          stdio: "inherit",
          env: process.env,
        });
        if (result.error) throw result.error;
        if (result.status !== 0)
          throw new Error(`Editor exited with status ${result.status ?? result.signal}.`);
      } finally {
        tui.start();
        tui.requestRender(true);
      }
      done();
      return { render: () => [], invalidate: () => {} };
    });
    return await readFile(file, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function editToolList(
  ctx: ExtensionCommandContext,
  type: AgentType,
  field: "allow" | "block",
  options: ToolEditorOptions,
): Promise<void> {
  const value = await editToolSelection(ctx, field, type.tools?.[field], options);
  if (value === TOOL_EDITOR_CANCEL) return;
  if (value === undefined) {
    if (type.tools) delete type.tools[field];
  } else {
    type.tools ??= {};
    type.tools[field] = [...value];
  }
  if (type.tools && !Object.keys(type.tools).length) delete type.tools;
}

const AGENT_COLOR_DEFAULT = "__default__";
const AGENT_COLOR_CANCEL = Symbol("agent-color-cancel");

class AgentColorPickerComponent extends Container {
  private readonly items: {
    value: string;
    label: string;
    description?: string;
  }[];
  private readonly preview: Text;
  private readonly theme: Theme;
  readonly selectList: SelectList;

  constructor(
    private readonly tui: {
      requestRender(force?: boolean): void;
      terminal?: { rows: number };
    },
    theme: Theme,
    currentColor: AgentType["color"] | undefined,
    private readonly agentName: string,
    onSelect: (color: AgentType["color"] | undefined) => void,
    onCancel: () => void,
  ) {
    super();
    this.theme = theme;
    this.items = [
      {
        value: AGENT_COLOR_DEFAULT,
        label: "Default (inherit)",
        description: "Use the default accent background for the type pill",
      },
      ...AGENT_COLORS.map((color) => ({
        value: color,
        label: contrastPill(color, color, theme),
        description: `Type pill background: ${color}`,
      })),
    ];
    this.preview = new Text();
    this.selectList = new SelectList(this.items, 10, getSelectListTheme(), {
      minPrimaryColumnWidth: 18,
      maxPrimaryColumnWidth: 28,
    });
    const selectedIndex = this.items.findIndex(
      (item) => item.value === (currentColor ?? AGENT_COLOR_DEFAULT),
    );
    this.selectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    this.selectList.onSelectionChange = (item) => {
      this.updatePreview(tui, item.value);
    };
    this.selectList.onSelect = (item) => {
      onSelect(item.value === AGENT_COLOR_DEFAULT ? undefined : (item.value as AgentType["color"]));
    };
    this.selectList.onCancel = onCancel;
    this.updatePreview(tui, this.items[selectedIndex >= 0 ? selectedIndex : 0]!.value);
  }

  getItems(): readonly {
    value: string;
    label: string;
    description?: string;
  }[] {
    return this.items;
  }

  render(width: number): string[] {
    const height = dialogHeight(this.tui);
    const budget = Math.max(1, height - 7);
    const selected = this.items.findIndex(
      (item) => item.value === this.selectList.getSelectedItem()?.value,
    );
    const start = Math.max(0, Math.min(selected - budget + 1, this.items.length - budget));
    const body = [
      ` ${truncateToWidth(
        this.preview
          .render(1000)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" "),
        Math.max(1, width - 4),
        "",
      )}`,
      "",
      ...this.items
        .slice(start, start + budget)
        .map(
          (item, i) =>
            `${start + i === selected ? "›" : " "} ${item.label}  ${this.theme.fg("muted", item.description ?? "")}`,
        ),
    ];
    return frameDialog(
      this.theme,
      width,
      height,
      "Agent color",
      body,
      "↑↓ preview · Enter apply · Esc cancel",
    );
  }

  getPreview(): Text {
    return this.preview;
  }

  getSelectList(): SelectList {
    return this.selectList;
  }

  handleInput(keyData: string): void {
    this.selectList.handleInput(keyData);
  }

  private updatePreview(tui: { requestRender(force?: boolean): void }, value: string): void {
    const color = value === AGENT_COLOR_DEFAULT ? undefined : value;
    const badge = agentTypeBadge(this.agentName, color, this.theme);
    const path = agentPath("/root/example-task", color, this.theme);
    this.preview.setText(
      `Preview: ${badge} ${path} ${this.theme.fg("accent", "[running]")} Working`,
    );
    tui.requestRender();
  }
}

async function selectAgentColor(
  ctx: ExtensionCommandContext,
  currentColor: AgentType["color"] | undefined,
  agentName: string,
): Promise<AgentType["color"] | undefined | typeof AGENT_COLOR_CANCEL> {
  return ctx.ui.custom((tui, theme, _keys, done) => {
    return new AgentColorPickerComponent(
      tui,
      theme,
      currentColor,
      agentName,
      (value) => done(value),
      () => done(AGENT_COLOR_CANCEL),
    );
  }, DIALOG_OPTIONS);
}

async function editDocument(
  ctx: ExtensionCommandContext,
  type: AgentType,
  external: boolean,
): Promise<AgentType | undefined> {
  const original = serializeAgentType(type);
  let text = original;
  while (true) {
    try {
      if (external) {
        text = await externalEdit(ctx, text);
      } else {
        const end = text.indexOf("\n---", 4);
        const yaml = await dialogEditor(
          ctx,
          "Agent frontmatter YAML (Markdown body preserved)",
          text.slice(4, end),
        );
        if (yaml === undefined) return;
        text = `---\n${yaml.replace(/\n?$/, "\n")}---\n${type.systemPrompt}`;
      }
      return {
        ...parseAgentType(text),
        filePath: type.filePath,
        source: type.source,
      };
    } catch (error) {
      const diagnostic = sanitizeText(error instanceof Error ? error.message : String(error));
      ctx.ui.notify(`Edit not accepted: ${diagnostic}. Original definition is unchanged.`, "error");
      const action = await dialogMenu(ctx, "Invalid edit — retry?", [
        {
          id: "Retry",
          label: "Retry",
          value: "Continue editing",
          help: diagnostic,
        },
        {
          id: "Cancel",
          label: "Cancel",
          value: "Restore previous definition",
          help: diagnostic,
        },
      ]);
      if (action !== "Retry") return;
    }
  }
}

/** Avoid treating a renamed definition as permission to overwrite another file. */
function assertSaveDestination(
  store: ConfigStore,
  type: AgentType,
  original: AgentType | undefined,
  scope: "user" | "project",
  kind: AgentEditMode = "fork",
): void {
  if (kind === "override" && original && type.name !== original.name) {
    throw new Error("Settings overrides cannot rename the agent; fork it instead.");
  }
  const entries = store.list();
  const sameName = entries.find((entry) => entry.name === type.name);
  if (sameName && (!original || type.name !== original.name)) {
    throw new Error(`Agent type ${type.name} already exists; choose a different name.`);
  }
  const destination = store.destination(type.name, scope, original, kind);
  if (
    existsSync(destination) &&
    (!original?.filePath || resolve(original.filePath) !== destination)
  ) {
    throw new Error(
      `Refusing to overwrite existing definition ${destination}. Edit that definition instead.`,
    );
  }
  // A scope cannot hold both a fork and an override for one name (fail-closed).
  const otherKind: AgentEditMode = kind === "fork" ? "override" : "fork";
  const otherDestination = store.destination(type.name, scope, undefined, otherKind);
  if (
    otherDestination !== destination &&
    existsSync(otherDestination) &&
    (!original?.filePath || resolve(original.filePath) !== otherDestination)
  ) {
    const kept = kind === "fork" ? ".md (full fork)" : ".yml (settings override)";
    throw new Error(
      `Agent type ${type.name} already has a ${otherKind === "fork" ? ".md fork" : ".yml override"} in this scope (${otherDestination}). Remove it before saving a ${kept}.`,
    );
  }
}

const EDIT_MENU_ACTIONS = [
  "Customization",
  "name",
  "description",
  "models",
  "modelSuggestions",
  "thinkingLevel",
  "tools.allow",
  "tools.block",
  "color",
  "icon",
  "systemPrompt",
  "Save scope",
  "Source",
  "Edit frontmatter YAML",
  "External editor (entire Markdown)",
  "Save",
  "Reset to bundled",
  "Cancel",
] as const;

type AgentEditMode = "fork" | "override";

type EditMenuAction = (typeof EDIT_MENU_ACTIONS)[number];

const EDIT_FIELD_LABELS: Record<EditMenuAction, string> = {
  Customization: "Customization",
  name: "Name",
  description: "Description",
  models: "Models",
  modelSuggestions: "Model suggestions",
  thinkingLevel: "Thinking level",
  "tools.allow": "Allowed tools",
  "tools.block": "Blocked tools",
  color: "Color",
  icon: "[labs] Icon",
  systemPrompt: "System prompt",
  "Save scope": "Save scope",
  Source: "Source (read-only)",
  "Edit frontmatter YAML": "Frontmatter YAML",
  "External editor (entire Markdown)": "External editor",
  Save: "Save",
  "Reset to bundled": "Reset to bundled",
  Cancel: "Cancel",
};

const EDIT_FIELD_HELP: Record<EditMenuAction, string> = {
  Customization:
    "Settings override tweaks bundled settings via <name>.yml and keeps receiving prompt updates. Fork copies everything into <name>.md and you own the prompt.",
  name: "Unique type identifier. Renaming retains the original file.",
  description: "Description shown when browsing and spawning agents.",
  models:
    "Ordered model preferences. Unavailable models are skipped at runtime. Advisory names in model suggestions never pin a model.",
  modelSuggestions:
    "Advisory display names to help pick a model. Not provider/model pins; never selected or required. One name per line; empty clears.",
  thinkingLevel: "Reasoning effort. Default follows the parent session.",
  "tools.allow":
    "Pick session tools with checkboxes. Under Allowed (except blocked), an unset or empty allow list allows no tools.",
  "tools.block":
    "Pick session tools to block. Blocked tools take precedence when the policy uses this list.",
  color: "Thread widget color with live preview.",
  icon: "Paste a single Nerd Font glyph from nerdfonts.com/cheat-sheet (not its name or codepoint).\nLeave blank to remove. Display requires [labs] Nerd Font icons in settings and a Nerd Font in your terminal.",
  systemPrompt: "Edit the Markdown prompt body in a multiline dialog.",
  "Save scope": "Project definitions override global definitions with the same name.",
  Source: "Read-only source. Bundled definitions are copied, never overwritten.",
  "Edit frontmatter YAML": "Edit metadata as YAML, preserving the prompt body.",
  "External editor (entire Markdown)": "Edit the complete definition using $VISUAL / $EDITOR.",
  Save: "Validate and save. Existing sessions keep their original configuration.",
  "Reset to bundled":
    "Delete this fork/override file and go back to the definition shipped with the extension. Unsaved edits are discarded.",
  Cancel: "Close without saving any edits.",
};

async function chooseSaveScope(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  current: "user" | "project",
): Promise<"user" | "project" | undefined> {
  const choices = ["Global", ...(store.canSaveProject() ? ["Trusted project"] : [])];
  const value = await dialogMenu(
    ctx,
    "Save scope",
    choices.map((label) => ({ id: label, label })),
    { selectedId: current === "user" ? "Global" : "Trusted project" },
  );
  return value ? (value === "Global" ? "user" : "project") : undefined;
}

/** Omitted tool lists use the default policy; [] is an explicit empty list, not inheritance. */
function toolListMenuValue(names: string[] | undefined): string {
  if (names === undefined) return "Unset (use default policy)";
  if (names.length === 0) return "Empty list";
  return names.join(", ");
}

function modelSuggestionLabel(suggestions: string[] | undefined): string {
  if (suggestions === undefined || suggestions.length === 0) return "None";
  return suggestions.join(", ");
}

function modelSuggestionPrefill(suggestions: string[] | undefined): string {
  return (suggestions ?? []).map((name) => sanitizeText(name)).join("\n");
}

function customizationMenuValue(editMode: AgentEditMode | undefined, isNew: boolean): string {
  if (isNew) return "New full definition (.md)";
  if (editMode === "override") return "Settings override (.yml)";
  if (editMode === "fork") return "Full copy (.md)";
  return "Choose to unlock editing";
}

/** Bundled definitions are read-only until the user picks fork or override. */
function isPureBundled(original: AgentType | undefined): boolean {
  return !!original && !original.customization && original.source === "bundled";
}

async function chooseCustomizationMode(
  ctx: ExtensionCommandContext,
  agentName: string,
  current?: AgentEditMode,
): Promise<AgentEditMode | undefined> {
  const value = await dialogMenu(
    ctx,
    `Customize ${sanitizeText(agentName)}`,
    [
      {
        id: "override",
        label: "Tweak settings",
        value: `${agentName}.yml`,
        help: "Override only settings (models, tools, thinking, color). The prompt stays bundled and keeps receiving updates. System prompt and name stay locked.",
      },
      {
        id: "fork",
        label: "Fork agent",
        value: `${agentName}.md`,
        help: "Copy the full definition including the system prompt. You own the prompt; bundled updates no longer apply. Everything is editable.",
      },
    ],
    { selectedId: current },
  );
  return value === "override" || value === "fork" ? value : undefined;
}

function editMenuLabel(action: EditMenuAction, draft: AgentType): string {
  switch (action) {
    case "name":
      return `name: ${sanitizeText(draft.name)}`;
    case "description":
      return `description: ${sanitizeText(draft.description)}`;
    case "models": {
      const models = getModelPreferences(draft);
      return `models: ${sanitizeText(models?.join(", ") ?? "Default (inherit)")}`;
    }
    case "modelSuggestions":
      return `modelSuggestions: ${sanitizeText(modelSuggestionLabel(draft.modelSuggestions))}`;
    case "thinkingLevel":
      return `thinkingLevel: ${sanitizeText(draft.thinkingLevel ?? "Default (inherit)")}`;
    case "tools.allow":
      return `tools.allow: ${sanitizeText(toolListMenuValue(draft.tools?.allow))}`;
    case "tools.block":
      return `tools.block: ${sanitizeText(toolListMenuValue(draft.tools?.block))}`;
    case "color":
      return `color: ${sanitizeText(draft.color ?? "Default (inherit)")}`;
    case "icon":
      return `icon: ${draft.icon ? "Configured" : "None"}`;
    case "systemPrompt":
      return `systemPrompt: ${draft.systemPrompt.split("\n").length} lines · ${draft.systemPrompt.length} characters`;
    default:
      return action;
  }
}

export async function editAgentTypes(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  nerdFontIcons = false,
  toolEditor: ToolEditorOptions = { getAllTools: () => [], toolFiltering: "allowed" },
): Promise<void> {
  if (!canOpenDialog(ctx)) return;
  await withDialogSession(ctx, (scoped) =>
    editAgentTypesDialog(scoped, store, nerdFontIcons, toolEditor),
  );
}

async function editAgentTypesDialog(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  nerdFontIcons: boolean,
  toolEditor: ToolEditorOptions,
): Promise<void> {
  while (true) {
    const types = store.list();
    const selection = await dialogMenu(ctx, "Agent types", [
      {
        id: "Create new type",
        label: "Create new type",
        value: "New definition",
        help: "Nothing is written until you save.",
      },
      ...types.map((type) => ({
        id: type.name,
        label: type.name,
        renderLabel: (label: string, theme: Theme) =>
          agentTypeBadge(label, type.color, theme, type.icon, nerdFontIcons),
        value: type.description,
        help: `${type.source ?? "user"} · ${type.filePath ?? ""}`,
      })),
    ]);
    if (selection === undefined) return;
    const original = selection === "Create new type" ? undefined : store.get(selection);
    const isNew = !original;
    let draft: AgentType = original
      ? structuredClone(original)
      : { name: "new-agent", description: "New agent", systemPrompt: "" };
    const originalContent = serializeAgentType(draft);
    let selectedId: string | undefined;
    let saveScope: "user" | "project" =
      original?.source === "project" && store.canSaveProject() ? "project" : "user";
    // Bundled definitions stay read-only until the user picks how to own them.
    let editMode: AgentEditMode | undefined = isNew
      ? "fork"
      : (original?.customization?.kind ?? undefined);
    if (!isNew && isPureBundled(original)) {
      const mode = await chooseCustomizationMode(ctx, original.name);
      if (!mode) continue;
      editMode = mode;
    }
    while (true) {
      const baseForDiff =
        editMode === "override" && original
          ? (store.getBase(original.name) ?? original)
          : undefined;
      const dirty =
        editMode === "override" && baseForDiff
          ? Object.keys(diffAgentSettings(baseForDiff, draft)).length > 1
          : !original || serializeAgentType(draft) !== originalContent;
      const field = await dialogMenu(
        ctx,
        `Edit ${sanitizeText(draft.name)} (unsaved)`,
        EDIT_MENU_ACTIONS.filter(
          (action) =>
            action !== "Reset to bundled" ||
            (!isNew && !!original?.customization && !!original.baseSource),
        ).map((action) => {
          const decorated = editMenuLabel(action, draft);
          const separator = decorated.indexOf(": ");
          return {
            id: action,
            label: EDIT_FIELD_LABELS[action],
            valueColor: action === "Save" && dirty ? ("warning" as const) : undefined,
            value:
              action === "Customization"
                ? customizationMenuValue(editMode, isNew)
                : action === "Save" && dirty
                  ? "(changes)"
                  : action === "Source"
                    ? original?.customization
                      ? `${original.customization.scope} ${original.customization.kind} over ${original.baseSource ?? "bundled"}`
                      : (original?.source ?? "New draft")
                    : action === "Save scope"
                      ? saveScope === "user"
                        ? "Global"
                        : "Trusted project"
                      : action === "icon" && nerdFontIcons && draft.icon
                        ? draft.icon
                        : separator >= 0
                          ? decorated.slice(separator + 2)
                          : "",
            help:
              action === "Source"
                ? original?.customization
                  ? `Settings file: ${original.customization.filePath}. Base prompt: ${original.baseFilePath ?? "(bundled)"}.`
                  : (original?.filePath ??
                    "Not saved yet. Bundled definitions are copied, never overwritten.")
                : EDIT_FIELD_HELP[action],
          };
        }),
        {
          selectedId,
          saveId: "Save",
          footer: "↑↓/Tab fields · Enter edit · Ctrl+S save · Esc cancel",
        },
      );
      selectedId = field;
      if (!field || field === "Cancel") break;
      try {
        if (field === "Customization") {
          if (isNew) {
            ctx.ui.notify("New types are always full definitions (.md).", "info");
            continue;
          }
          const mode = await chooseCustomizationMode(ctx, draft.name, editMode);
          if (!mode) continue;
          if (mode !== editMode && mode === "override" && original) {
            // Overrides carry no prompt body; drop any prompt edits.
            const base = store.getBase(original.name) ?? original;
            draft.systemPrompt = base.systemPrompt;
            ctx.ui.notify(
              "Switched to settings override: prompt edits were dropped (the bundled prompt applies).",
              "info",
            );
          }
          editMode = mode;
          continue;
        }
        if (!isNew && !editMode) {
          ctx.ui.notify(
            "Pick Customization first: tweak settings (.yml) or fork the agent (.md).",
            "error",
          );
          continue;
        }
        if (
          editMode === "override" &&
          (field === "name" ||
            field === "systemPrompt" ||
            field === "Edit frontmatter YAML" ||
            field === "External editor (entire Markdown)")
        ) {
          ctx.ui.notify(
            field === "name"
              ? "Settings overrides cannot rename the agent; fork it instead."
              : "The system prompt lives with the bundled definition; fork the agent to edit it.",
            "error",
          );
          continue;
        }
        if (field === "Save") {
          if (!editMode) continue;
          // Round-trip before saving: no partial or invalid configuration is accepted.
          const validated = parseAgentType(serializeAgentType(draft));
          const scope = await chooseSaveScope(ctx, store, saveScope);
          if (!scope) continue;
          assertSaveDestination(store, validated, original, scope, editMode);
          if (editMode === "override") {
            if (
              original?.customization?.kind === "fork" &&
              original.customization.scope === scope
            ) {
              store.removeCustomization(original.name, scope);
            }
            const saved = store.saveOverride(draft.name, validated, scope, original);
            ctx.ui.notify(
              `Saved settings override ${sanitizeText(saved.filePath ?? saved.name)}. Prompt and unset fields follow the base definition.`,
              "info",
            );
            break;
          }
          if (
            original?.customization?.kind === "override" &&
            original.customization.scope === scope
          ) {
            store.removeCustomization(original.name, scope);
          }
          const saved = store.save(validated, scope, original);
          ctx.ui.notify(
            `Saved ${sanitizeText(saved.filePath ?? saved.name)}${original && original.name !== saved.name ? " (original file retained)" : ""}.`,
            "info",
          );
          break;
        }
        if (field === "Reset to bundled") {
          if (!original?.customization || !original.baseSource) continue;
          const { scope, filePath } = original.customization;
          const confirmed = await dialogMenu(
            ctx,
            `Reset ${sanitizeText(original.name)}?`,
            [
              {
                id: "reset",
                label: "Reset",
                help: `Deletes ${filePath} and restores the ${original.baseSource ?? "bundled"} definition.`,
              },
              { id: "keep", label: "Keep" },
            ],
            { selectedId: "keep" },
          );
          if (confirmed !== "reset") continue;
          store.removeCustomization(original.name, scope);
          ctx.ui.notify(
            `Reset ${sanitizeText(original.name)}: deleted ${sanitizeText(filePath)}; using the ${original.baseSource ?? "bundled"} definition.`,
            "info",
          );
          break;
        }
        if (field === "Save scope") {
          const scope = await chooseSaveScope(ctx, store, saveScope);
          if (scope) saveScope = scope;
          continue;
        }
        if (field === "Source") {
          ctx.ui.notify(original?.filePath ?? "This definition has not been saved yet.", "info");
          continue;
        }
        if (field === "External editor (entire Markdown)" || field === "Edit frontmatter YAML") {
          const edited = await editDocument(
            ctx,
            draft,
            field === "External editor (entire Markdown)",
          );
          if (edited) draft = edited;
          continue;
        }
        const candidate = structuredClone(draft);
        if (field === "name" || field === "description" || field === "systemPrompt") {
          const originalValue = candidate[field] ?? "";
          // Editor prefill must not carry terminal controls. An unmodified or
          // SDK-trimmed submit keeps the original, including whitespace and CRLF.
          const prefill = originalValue
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n")
            .map(sanitizeText)
            .join("\n");
          const value = await dialogEditor(ctx, `Agent ${field}`, prefill);
          if (value === undefined) continue;
          candidate[field] = value === prefill || value === prefill.trim() ? originalValue : value;
        } else if (field === "icon") {
          const value = await dialogEditor(
            ctx,
            "Agent icon (Nerd Font glyph; blank to remove)",
            candidate.icon ?? "",
          );
          if (value === undefined) continue;
          const icon = value.trim();
          if (!icon) delete candidate.icon;
          else candidate.icon = icon;
        } else if (field === "models") {
          const value = await editModelPreferences(
            ctx,
            getModelPreferences(candidate),
            candidate.modelSuggestions,
          );
          if (value === MODEL_EDITOR_CANCEL) continue;
          if (value.length === 0) {
            delete candidate.models;
            delete candidate.model;
          } else {
            candidate.models = [...value];
            delete candidate.model;
          }
        } else if (field === "modelSuggestions") {
          const prefill = modelSuggestionPrefill(candidate.modelSuggestions);
          const value = await dialogEditor(
            ctx,
            "Agent modelSuggestions (one display name per line)",
            prefill,
          );
          if (value === undefined) continue;
          if (value === prefill || value === prefill.trim()) continue;
          const names = value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          if (names.length === 0) delete candidate.modelSuggestions;
          else candidate.modelSuggestions = [...names];
        } else if (field === "thinkingLevel") {
          const value = await dialogMenu(
            ctx,
            "Thinking level",
            ["Default (inherit)", ...THINKING_LEVELS].map((label) => ({
              id: label,
              label,
            })),
            { selectedId: candidate.thinkingLevel ?? "Default (inherit)" },
          );
          if (!value) continue;
          if (value === "Default (inherit)") delete candidate.thinkingLevel;
          else candidate.thinkingLevel = value as AgentType["thinkingLevel"];
        } else if (field === "color") {
          const value = await selectAgentColor(ctx, candidate.color, candidate.name);
          if (value === AGENT_COLOR_CANCEL) continue;
          if (value === undefined) delete candidate.color;
          else candidate.color = value;
        } else if (field === "tools.allow" || field === "tools.block") {
          await editToolList(
            ctx,
            candidate,
            field === "tools.allow" ? "allow" : "block",
            toolEditor,
          );
        }
        parseAgentType(serializeAgentType(candidate));
        draft = candidate;
      } catch (error) {
        ctx.ui.notify(
          sanitizeText(error instanceof Error ? error.message : String(error)),
          "error",
        );
      }
    }
  }
}

