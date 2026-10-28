import { basename } from "node:path";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  aggregate,
  formatCost,
  formatTokens,
  parseDateKey,
  parseRange,
  type AggregatedStats,
  type Bucket,
  type DateRange,
  type RefreshResult,
  type StatsCache,
  type UsageTotals,
} from "./stats.ts";

const PRESETS = ["today", "7d", "30d", "90d", "all"] as const;
const VIEWS = ["overview", "models", "projects", "sessions"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type Done = (value: void) => void;
type View = (typeof VIEWS)[number];
type Color = "text" | "accent" | "muted" | "dim" | "success" | "error" | "warning" | "border" | "borderAccent" | "borderMuted";

export type DashboardTheme = {
  fg(color: Color, text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
};

type DashboardOptions = {
  cache: StatsCache;
  args: string;
  done: Done;
  theme: DashboardTheme;
  refresh?: string;
};

type Column<T> = {
  title: string;
  width: number;
  align?: "left" | "right";
  render: (item: T, index: number) => string;
};

type Comparison = {
  previous?: AggregatedStats;
  label: string;
};

type MetricCard = {
  label: string;
  value: string;
  detail: string;
  trend?: string;
  tone: Color;
};

type Signal = {
  level: "good" | "watch" | "info";
  title: string;
  detail: string;
};

export class PiStatsDashboard {
  private cache: StatsCache;
  private arg: string;
  private stats: AggregatedStats;
  private refresh: string;
  private view: View = "overview";
  private dateEditing = false;
  private dateInput = "";
  private dateError = "";
  private selectedModel = 0;
  private modelExpanded = false;
  private cachedWidth = 0;
  private cachedLines: string[] | undefined;
  private readonly done: Done;
  private readonly theme: DashboardTheme;

  constructor(options: DashboardOptions) {
    this.cache = options.cache;
    this.arg = normalizeArg(options.args);
    this.stats = aggregate(this.cache, parseRange(this.arg));
    this.refresh = options.refresh || "refreshing local cache";
    this.done = options.done;
    this.theme = options.theme;
  }

  setRefreshResult(result: RefreshResult): void {
    this.cache = result.cache;
    this.stats = aggregate(this.cache, parseRange(this.arg));
    this.clampModelSelection();
    const errors = result.errors.length ? `, ${result.errors.length} errors` : "";
    this.refresh = `indexed ${result.totalFiles} files (${result.parsedFiles} parsed, ${result.reusedFiles} cached${errors})`;
    this.invalidate();
  }

  setRefreshError(error: unknown): void {
    this.refresh = `index failed: ${error instanceof Error ? error.message : String(error)}`;
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const safeWidth = Math.max(20, width);
    const lines = [
      ...renderHeader(this.stats, this.refresh, safeWidth, this.theme),
      ...renderNavigation(this.arg, this.view, safeWidth, this.theme),
    ];

    if (this.dateEditing || this.dateError) {
      lines.push(renderDatePrompt(this.dateInput, this.dateError, safeWidth, this.theme));
    }

    lines.push("");
    if (this.view === "overview") lines.push(...this.renderOverview(safeWidth));
    else if (this.view === "models") lines.push(...this.renderModels(safeWidth));
    else if (this.view === "projects") lines.push(...this.renderProjects(safeWidth));
    else lines.push(...this.renderSessions(safeWidth));

    lines.push("");
    lines.push(renderFooter(this.view, this.modelExpanded, safeWidth, this.theme));

    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => fit(line, width));
    return this.cachedLines;
  }

  handleInput(data: string): void {
    if (this.dateEditing) {
      this.handleDateInput(data);
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const shortcut = printable.length === 1 ? printable.toLowerCase() : printable;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || shortcut === "q") {
      this.done();
      return;
    }

    if (this.view === "models") {
      if (matchesKey(data, Key.up) || shortcut === "k") {
        this.moveModel(-1);
        return;
      }
      if (matchesKey(data, Key.down) || shortcut === "j") {
        this.moveModel(1);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.modelExpanded = !this.modelExpanded;
        this.invalidate();
        return;
      }
    }

    if (shortcut === "1") this.setArg("today");
    else if (shortcut === "2") this.setArg("7d");
    else if (shortcut === "3") this.setArg("30d");
    else if (shortcut === "4") this.setArg("90d");
    else if (shortcut === "5") this.setArg("all");
    else if (shortcut === "d") this.startDateInput();
    else if (shortcut === "o") this.setView("overview");
    else if (shortcut === "m") this.setView("models");
    else if (shortcut === "p") this.setView("projects");
    else if (shortcut === "s") this.setView("sessions");
    else if (matchesKey(data, Key.tab)) this.cycleView(1);
    else if (matchesKey(data, Key.right)) this.cycleRange(1);
    else if (matchesKey(data, Key.left)) this.cycleRange(-1);
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = 0;
  }

  private renderOverview(width: number): string[] {
    const comparison = buildComparison(this.cache, this.stats);
    const cards = overviewCards(this.stats, comparison, this.theme);
    const signals = decisionSignals(this.stats, comparison);
    return [
      ...renderCardGrid(cards, width, this.theme),
      "",
      ...renderBox("DECISION SIGNALS", renderSignals(signals, width - 4, this.theme), width, "warning", this.theme),
      "",
      ...renderActivityPanel(this.stats, width, this.theme),
    ];
  }

  private renderModels(width: number): string[] {
    const rows = this.stats.models.slice(0, 12);
    const lines = renderSelectableTable(
      "MODEL EFFICIENCY",
      rows,
      modelColumns(width, this.stats.totals.freshTokens),
      width,
      "accent",
      this.theme,
      this.selectedModel,
    );
    if (this.modelExpanded && rows[this.selectedModel]) {
      lines.push("");
      lines.push(...renderModelDetail(rows[this.selectedModel]!, this.stats, width, this.theme));
    }
    return lines;
  }

  private renderProjects(width: number): string[] {
    return renderTable("TOP PROJECTS", this.stats.projects.slice(0, 12), projectColumns(width), width, "success", this.theme);
  }

  private renderSessions(width: number): string[] {
    return renderTable("TOP SESSIONS", this.stats.sessions.slice(0, 14), sessionColumns(width), width, "warning", this.theme);
  }

  private handleDateInput(data: string): void {
    const printable = decodeKittyPrintable(data) ?? data;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.dateEditing = false;
      this.dateError = "";
    } else if (matchesKey(data, Key.enter)) {
      const next = this.dateInput.trim().toLowerCase();
      if (isValidRangeArg(next)) {
        this.setArg(next);
        this.dateEditing = false;
        this.dateError = "";
      } else {
        this.dateError = "Use today, 7d, 30d, 90d, all, or YYYY-MM-DD..YYYY-MM-DD";
      }
    } else if (matchesKey(data, Key.backspace)) {
      this.dateInput = this.dateInput.slice(0, -1);
      this.dateError = "";
    } else if (/^[\x20-\x7e]+$/.test(printable)) {
      this.dateInput = (this.dateInput + printable).slice(0, 40);
      this.dateError = "";
    }
    this.invalidate();
  }

  private startDateInput(): void {
    this.dateEditing = true;
    this.dateInput = "";
    this.dateError = "";
    this.invalidate();
  }

  private setView(view: View): void {
    this.view = view;
    this.modelExpanded = false;
    this.invalidate();
  }

  private setArg(arg: string): void {
    this.arg = normalizeArg(arg);
    this.stats = aggregate(this.cache, parseRange(this.arg));
    this.dateError = "";
    this.modelExpanded = false;
    this.clampModelSelection();
    this.invalidate();
  }

  private cycleRange(delta: number): void {
    const current = PRESETS.indexOf(this.arg as (typeof PRESETS)[number]);
    const next = current === -1 ? 1 : (current + delta + PRESETS.length) % PRESETS.length;
    this.setArg(PRESETS[next]!);
  }

  private cycleView(delta: number): void {
    const current = VIEWS.indexOf(this.view);
    this.setView(VIEWS[(current + delta + VIEWS.length) % VIEWS.length]!);
  }

  private moveModel(delta: number): void {
    const count = Math.min(12, this.stats.models.length);
    if (!count) return;
    this.selectedModel = (this.selectedModel + delta + count) % count;
    this.modelExpanded = false;
    this.invalidate();
  }

  private clampModelSelection(): void {
    this.selectedModel = Math.min(this.selectedModel, Math.max(0, Math.min(12, this.stats.models.length) - 1));
  }
}

export function normalizeArg(args: string): string {
  const text = args.trim().toLowerCase();
  if (!text || text === "30") return "30d";
  if (text === "7") return "7d";
  if (text === "90") return "90d";
  return isValidRangeArg(text) ? text : "30d";
}

function isValidRangeArg(arg: string): boolean {
  const text = arg.trim().toLowerCase();
  if (!text || ["today", "7d", "30d", "90d", "all"].includes(text)) return true;
  const custom = text.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (!custom) return false;
  const start = parseDateKey(custom[1]!);
  const end = parseDateKey(custom[2]!);
  return start !== undefined && end !== undefined && end >= start;
}

function renderHeader(stats: AggregatedStats, refresh: string, width: number, theme: DashboardTheme): string[] {
  const title = `${theme.bold(theme.fg("text", "stats"))} ${theme.fg("dim", "│")} ${theme.fg("accent", stats.range.label)}`;
  const statusTone: Color = refresh.includes("failed") || refresh.includes("errors") ? "error" : refresh.includes("refreshing") ? "warning" : "success";
  const status = theme.fg(statusTone, refresh);
  if (width < 76 || visibleWidth(title) + visibleWidth(status) + 2 > width) return [fit(title, width), fit(status, width)];
  return [fit(`${title}${" ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(status)))}${status}`, width)];
}

function renderNavigation(activeRange: string, activeView: View, width: number, theme: DashboardTheme): string[] {
  const ranges = PRESETS.map((preset, index) => {
    const label = `${index + 1}:${preset}`;
    return preset === activeRange ? theme.bg("selectedBg", theme.bold(` ${label} `)) : theme.fg("dim", ` ${label} `);
  }).join(" ");
  const views: Array<[View, string]> = [
    ["overview", "O:overview"],
    ["models", "M:models"],
    ["projects", "P:projects"],
    ["sessions", "S:sessions"],
  ];
  const viewLine = views.map(([view, label]) => view === activeView ? theme.bg("selectedBg", theme.bold(` ${label} `)) : theme.fg("muted", ` ${label} `)).join(" ");
  return [fit(`${ranges} ${theme.fg("dim", "d:custom  ←/→:range")}`, width), fit(`${viewLine} ${theme.fg("dim", "tab:view")}`, width)];
}

function renderDatePrompt(input: string, error: string, width: number, theme: DashboardTheme): string {
  const prompt = `${theme.fg("warning", "date>")} ${input}${theme.bold("_")}`;
  const help = error ? theme.fg("error", error) : theme.fg("dim", "enter:apply  esc:cancel  e.g. 2026-06-01..2026-06-30");
  return fit(`${prompt}  ${help}`, width);
}

function renderFooter(view: View, expanded: boolean, width: number, theme: DashboardTheme): string {
  const modelHint = view === "models" ? `  ↑↓/jk:select  enter:${expanded ? "collapse" : "inspect"}` : "";
  return fit(theme.fg("dim", `1–5:range  o/m/p/s:view${modelHint}  q/esc:close`), width);
}

function buildComparison(cache: StatsCache, stats: AggregatedStats): Comparison {
  const range = stats.range;
  if (range.start === undefined || range.end === undefined) return { label: "No prior-period comparison for all time" };
  const duration = range.end - range.start;
  const now = Date.now();
  const observedDuration = now > range.start && now < range.end ? now - range.start : duration;
  const previousStart = range.start - duration;
  const previousRange: DateRange = {
    label: "previous period",
    start: previousStart,
    end: previousStart + observedDuration,
  };
  return { previous: aggregate(cache, previousRange), label: "vs previous period" };
}

function overviewCards(stats: AggregatedStats, comparison: Comparison, theme: DashboardTheme): MetricCard[] {
  const previous = comparison.previous?.totals;
  const current = stats.totals;
  const cacheRate = cacheLeverage(current);
  const previousCacheRate = previous ? cacheLeverage(previous) : undefined;
  const efficiency = costPerMillion(current);
  const previousEfficiency = previous ? costPerMillion(previous) : undefined;
  return [
    {
      label: "FRESH TOKENS",
      value: formatTokens(current.freshTokens),
      detail: `${formatTokens(current.input)} in · ${formatTokens(current.output)} out`,
      trend: deltaLabel(current.freshTokens, previous?.freshTokens, false, comparison.label, theme),
      tone: "success",
    },
    {
      label: "COST",
      value: formatCost(current.cost),
      detail: `${current.messages} messages · ${stats.sessionCount} sessions`,
      trend: deltaLabel(current.cost, previous?.cost, true, comparison.label, theme),
      tone: current.cost > 100 ? "error" : "warning",
    },
    {
      label: "CACHE LEVERAGE",
      value: percent(cacheRate),
      detail: `${formatTokens(current.cacheRead)} read`,
      trend: pointDeltaLabel(cacheRate, previousCacheRate, comparison.label, theme),
      tone: cacheRate >= 0.5 ? "success" : "warning",
    },
    {
      label: "COST / 1M FRESH",
      value: efficiency === undefined ? "n/a" : formatCost(efficiency),
      detail: "Lower is more efficient",
      trend: deltaLabel(efficiency, previousEfficiency, true, comparison.label, theme),
      tone: "accent",
    },
  ];
}

function renderCardGrid(cards: MetricCard[], width: number, theme: DashboardTheme): string[] {
  const columns = width >= 112 ? 4 : width >= 64 ? 2 : 1;
  const gap = columns > 1 ? 2 : 0;
  const cardWidth = Math.max(20, Math.floor((width - gap * (columns - 1)) / columns));
  const rendered = cards.map((card) => renderCard(card, cardWidth, theme));
  const lines: string[] = [];
  for (let i = 0; i < rendered.length; i += columns) {
    const row = rendered.slice(i, i + columns);
    for (let line = 0; line < 6; line++) lines.push(row.map((card) => padAnsi(card[line] || "", cardWidth)).join(" ".repeat(gap)));
    if (i + columns < rendered.length) lines.push("");
  }
  return lines;
}

function renderCard(card: MetricCard, width: number, theme: DashboardTheme): string[] {
  const inner = Math.max(2, width - 2);
  const border = theme.fg(card.tone, "─".repeat(inner));
  return [
    `${theme.fg(card.tone, "╭")}${border}${theme.fg(card.tone, "╮")}`,
    `${theme.fg(card.tone, "│")}${padAnsi(` ${theme.fg("dim", card.label)}`, inner)}${theme.fg(card.tone, "│")}`,
    `${theme.fg(card.tone, "│")}${padAnsi(` ${theme.bold(card.value)}`, inner)}${theme.fg(card.tone, "│")}`,
    `${theme.fg(card.tone, "│")}${padAnsi(` ${theme.fg("muted", card.detail)}`, inner)}${theme.fg(card.tone, "│")}`,
    `${theme.fg(card.tone, "│")}${padAnsi(` ${card.trend || theme.fg("dim", "No comparison")}`, inner)}${theme.fg(card.tone, "│")}`,
    `${theme.fg(card.tone, "╰")}${border}${theme.fg(card.tone, "╯")}`,
  ].map((line) => fit(line, width));
}

function decisionSignals(stats: AggregatedStats, comparison: Comparison): Signal[] {
  if (!stats.eventCount) return [{ level: "info", title: "No activity in this range", detail: "Change the date range or wait for the local cache refresh." }];
  const signals: Signal[] = [];
  const previous = comparison.previous;
  const topModel = [...stats.models].sort((a, b) => b.freshTokens - a.freshTokens)[0];
  const currentCache = cacheLeverage(stats.totals);
  const previousCache = previous ? cacheLeverage(previous.totals) : undefined;
  const costChange = relativeDelta(stats.totals.cost, previous?.totals.cost);

  if (costChange !== undefined && costChange > 0.25) {
    signals.push({ level: "watch", title: `Spend increased ${percent(costChange)}`, detail: `${formatCost(stats.totals.cost)} now vs ${formatCost(previous!.totals.cost)} previously. Inspect the Models view for the driver.` });
  } else if (costChange !== undefined && costChange < -0.15) {
    signals.push({ level: "good", title: `Spend decreased ${percent(Math.abs(costChange))}`, detail: `Usage cost fell to ${formatCost(stats.totals.cost)}. Compare fresh-token volume before treating this as an efficiency gain.` });
  }

  if (previousCache !== undefined && currentCache < previousCache - 0.1) {
    signals.push({ level: "watch", title: "Cache leverage dropped", detail: `${percent(currentCache)} now vs ${percent(previousCache)} previously. Check whether prompts or model routing changed.` });
  } else if (currentCache >= 0.6) {
    signals.push({ level: "good", title: "Strong cache leverage", detail: `${percent(currentCache)} of reusable input came from cache reads.` });
  }

  if (topModel && stats.totals.freshTokens > 0) {
    const share = topModel.freshTokens / stats.totals.freshTokens;
    signals.push({
      level: share >= 0.75 ? "watch" : "info",
      title: `${topModel.label} carries ${percent(share)} of fresh usage`,
      detail: share >= 0.75 ? "Model usage is concentrated; inspect efficiency before standardizing further." : "Open Models and press Enter to inspect its efficiency profile.",
    });
  }

  if (!signals.length) signals.push({ level: "info", title: "Usage is stable", detail: "No material cost or cache shift was detected for this period." });
  return signals.slice(0, 3);
}

function renderSignals(signals: Signal[], width: number, theme: DashboardTheme): string[] {
  const icons = { good: "✓", watch: "!", info: "•" } as const;
  const tones: Record<Signal["level"], Color> = { good: "success", watch: "warning", info: "accent" };
  const lines: string[] = [];
  for (const signal of signals) {
    lines.push(...wrapTextWithAnsi(`${theme.fg(tones[signal.level], icons[signal.level])} ${theme.bold(signal.title)}`, width));
    lines.push(...wrapTextWithAnsi(`  ${theme.fg("muted", signal.detail)}`, width));
  }
  return lines;
}

function modelColumns(width: number, totalFreshTokens: number): Column<Bucket>[] {
  const compactMode = width < 74;
  if (compactMode) {
    return [
      { title: "model", width: Math.max(12, width - 27), render: (b) => b.label },
      { title: "cost", width: 8, align: "right", render: (b) => formatCost(b.cost) },
      { title: "fresh", width: 10, align: "right", render: (b) => formatTokens(b.freshTokens) },
    ];
  }
  return [
    { title: "model", width: Math.max(18, width - 57), render: (b) => b.label },
    { title: "share", width: 7, align: "right", render: (b) => percentOf(b.freshTokens, totalFreshTokens) },
    { title: "cost", width: 9, align: "right", render: (b) => formatCost(b.cost) },
    { title: "$/1m", width: 9, align: "right", render: (b) => formatOptionalCost(costPerMillion(b)) },
    { title: "cache", width: 7, align: "right", render: (b) => percent(cacheLeverage(b)) },
    { title: "sess", width: 5, align: "right", render: (b) => String(b.sessions.size) },
  ];
}

function projectColumns(width: number): Column<Bucket>[] {
  return [
    { title: "project", width: Math.max(14, width - 42), render: (b) => b.label },
    { title: "cost", width: 9, align: "right", render: (b) => formatCost(b.cost) },
    { title: "fresh", width: 10, align: "right", render: (b) => formatTokens(b.freshTokens) },
    { title: "sess", width: 5, align: "right", render: (b) => String(b.sessions.size) },
  ];
}

function sessionColumns(width: number): Column<Bucket>[] {
  return [
    { title: "session", width: Math.max(16, width - 50), render: (b) => b.label },
    { title: "cost", width: 9, align: "right", render: (b) => formatCost(b.cost) },
    { title: "fresh", width: 10, align: "right", render: (b) => formatTokens(b.freshTokens) },
    { title: "project", width: 16, render: (b) => String(b.meta?.project || basename(String(b.meta?.cwd || ""))) },
  ];
}

function renderModelDetail(model: Bucket, stats: AggregatedStats, width: number, theme: DashboardTheme): string[] {
  const overallEfficiency = costPerMillion(stats.totals);
  const modelEfficiency = costPerMillion(model);
  const share = stats.totals.freshTokens ? model.freshTokens / stats.totals.freshTokens : 0;
  const provider = String(model.meta?.provider || "unknown");
  const efficiencyNote = modelEfficiency === undefined
    ? "Pricing data is unavailable for this model."
    : overallEfficiency !== undefined && modelEfficiency > overallEfficiency * 1.25
      ? `Above the overall ${formatCost(overallEfficiency)}/1M baseline; reserve it for work that benefits from the premium.`
      : `At or below the overall ${formatOptionalCost(overallEfficiency)}/1M baseline.`;
  const body = [
    `${theme.bold(model.label)} ${theme.fg("dim", `via ${provider}`)}`,
    `${theme.fg("muted", "Usage")}  ${percent(share)} share · ${formatTokens(model.freshTokens)} fresh · ${model.messages} messages`,
    `${theme.fg("muted", "Reach")}  ${model.sessions.size} sessions · ${model.projects.size} projects`,
    `${theme.fg("muted", "Efficiency")}  ${formatOptionalCost(modelEfficiency)}/1M fresh · ${percent(cacheLeverage(model))} cache leverage`,
    `${theme.fg("warning", "Decision")}  ${efficiencyNote}`,
  ];
  return renderBox("MODEL INSPECTOR", body, width, "accent", theme);
}

function renderSelectableTable<T>(title: string, rows: T[], columns: Column<T>[], width: number, tone: Color, theme: DashboardTheme, selected: number): string[] {
  return renderTableBase(title, rows, columns, width, tone, theme, selected);
}

function renderTable<T>(title: string, rows: T[], columns: Column<T>[], width: number, tone: Color, theme: DashboardTheme): string[] {
  return renderTableBase(title, rows, columns, width, tone, theme);
}

function renderTableBase<T>(title: string, rows: T[], columns: Column<T>[], width: number, tone: Color, theme: DashboardTheme, selected?: number): string[] {
  const inner = Math.max(12, width - 2);
  const fitted = fitColumns(columns, Math.max(8, inner - 2));
  const lines = [borderLine(title, width, tone, theme)];
  lines.push(tableRow(fitted, fitted.map((column) => column.title), width, tone, theme, false));
  lines.push(`${theme.fg(tone, "├")}${theme.fg(tone, "─".repeat(inner))}${theme.fg(tone, "┤")}`);
  if (!rows.length) lines.push(`${theme.fg(tone, "│")}${padAnsi(` ${theme.fg("dim", "No data in this range")}`, inner)}${theme.fg(tone, "│")}`);
  rows.forEach((row, index) => {
    const values = fitted.map((column) => column.render(row, index));
    let line = tableRow(fitted, values, width, tone, theme, selected === index);
    if (selected === index) line = theme.bg("selectedBg", line);
    lines.push(line);
  });
  lines.push(`${theme.fg(tone, "╰")}${theme.fg(tone, "─".repeat(inner))}${theme.fg(tone, "╯")}`);
  return lines.map((line) => fit(line, width));
}

function tableRow<T>(columns: Column<T>[], values: string[], width: number, tone: Color, theme: DashboardTheme, selected: boolean): string {
  const cells = columns.map((column, index) => {
    const marker = index === 0 && selected ? theme.fg("accent", "›") : " ";
    const available = Math.max(1, column.width - (index === 0 ? 1 : 0));
    const value = cropAnsi(values[index] || "", available);
    const padded = column.align === "right" ? padStartAnsi(value, available) : padAnsi(value, available);
    return index === 0 ? `${marker}${padded}` : padded;
  });
  return fit(`${theme.fg(tone, "│")} ${cells.join(` ${theme.fg("borderMuted", "│")} `)} ${theme.fg(tone, "│")}`, width);
}

function fitColumns<T>(columns: Column<T>[], available: number): Column<T>[] {
  const next = columns.map((column) => ({ ...column }));
  while (next.length > 1 && next.length * 4 + (next.length - 1) * 3 > available) next.pop();
  const gaps = Math.max(0, next.length - 1) * 3;
  const budget = Math.max(next.length * 4, available - gaps);
  let total = next.reduce((sum, column) => sum + column.width, 0);
  while (total > budget) {
    const candidate = next.reduce((best, column, index) => column.width > next[best]!.width && column.width > 4 ? index : best, 0);
    if (next[candidate]!.width <= 4) break;
    next[candidate]!.width--;
    total--;
  }
  return next;
}

function renderBox(title: string, body: string[], width: number, tone: Color, theme: DashboardTheme): string[] {
  const inner = Math.max(2, width - 2);
  const top = borderLine(title, width, tone, theme);
  const bottom = `${theme.fg(tone, "╰")}${theme.fg(tone, "─".repeat(inner))}${theme.fg(tone, "╯")}`;
  const rows = body.length ? body : [theme.fg("dim", "No data")];
  const wrapped = rows.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, inner - 2)));
  return [top, ...wrapped.map((line) => `${theme.fg(tone, "│")}${padAnsi(` ${line}`, inner)}${theme.fg(tone, "│")}`), bottom].map((line) => fit(line, width));
}

function borderLine(title: string, width: number, tone: Color, theme: DashboardTheme): string {
  const inner = Math.max(2, width - 2);
  const label = ` ${title} `;
  const rest = "─".repeat(Math.max(0, inner - visibleWidth(label)));
  return `${theme.fg(tone, "╭")}${theme.fg(tone, label)}${theme.fg(tone, rest)}${theme.fg(tone, "╮")}`;
}

function activityTitle(stats: AggregatedStats): string {
  const range = heatRange(stats.range, stats.daily);
  return range ? `ACTIVITY · ${shortDate(range.start)} → ${shortDate(range.end)}` : "ACTIVITY";
}

function renderActivityPanel(stats: AggregatedStats, width: number, theme: DashboardTheme): string[] {
  const contentWidth = Math.max(8, width - 4);
  let body: string[];

  if (width >= 92) {
    const leftWidth = Math.min(54, Math.max(40, Math.floor((contentWidth - 3) * 0.42)));
    const rightWidth = Math.max(24, contentWidth - leftWidth - 3);
    const calendar = [theme.bold(theme.fg("success", "CALENDAR")), ...heatmap(stats, leftWidth, theme)];
    const pulse = [theme.bold(theme.fg("accent", "ACTIVITY PULSE")), ...activityPulse(stats, rightWidth, theme)];
    body = joinColumns(calendar, pulse, leftWidth, rightWidth, theme);
  } else {
    body = [
      theme.bold(theme.fg("success", "CALENDAR")),
      ...heatmap(stats, contentWidth, theme),
      "",
      theme.bold(theme.fg("accent", "ACTIVITY PULSE")),
      ...activityPulse(stats, contentWidth, theme),
    ];
  }

  return renderBox(activityTitle(stats), body, width, "success", theme);
}

function joinColumns(left: string[], right: string[], leftWidth: number, rightWidth: number, theme: DashboardTheme): string[] {
  const height = Math.max(left.length, right.length);
  const divider = theme.fg("borderMuted", " │ ");
  return Array.from({ length: height }, (_, index) =>
    `${padAnsi(left[index] || "", leftWidth)}${divider}${padAnsi(right[index] || "", rightWidth)}`,
  );
}

function heatmap(stats: AggregatedStats, width: number, theme: DashboardTheme): string[] {
  const available = Math.max(4, width - 4);
  const range = heatRange(stats.range, stats.daily);
  if (!range) return [theme.fg("dim", "No activity in this range")];
  let start = startOfUtcWeek(range.start);
  const end = range.end;
  const naturalWeeks = Math.floor((end - start) / (7 * DAY_MS)) + 1;
  const cellWidth = Math.max(1, Math.min(3, Math.floor(available / naturalWeeks)));
  const maxWeeks = Math.max(1, Math.min(53, Math.floor(available / cellWidth)));
  let weeks = naturalWeeks;
  if (weeks > maxWeeks) {
    weeks = maxWeeks;
    start = startOfUtcWeek(end - (weeks - 1) * 7 * DAY_MS);
  }
  const max = Math.max(...[...stats.daily.values()].map((day) => day.freshTokens), 0);
  const rows: string[] = [];
  if (weeks >= 4) rows.push(theme.fg("dim", `    ${monthAxis(start, weeks, range.start, end, cellWidth)}`));
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let day = 0; day < 7; day++) {
    let line = `${theme.fg("dim", labels[day]!)} `;
    for (let week = 0; week < weeks; week++) {
      const timestamp = start + (week * 7 + day) * DAY_MS;
      const gap = " ".repeat(Math.max(0, cellWidth - 1));
      if (timestamp < range.start || timestamp > end) line += " ".repeat(cellWidth);
      else line += `${heatChar(stats.daily.get(shortDate(timestamp))?.freshTokens || 0, max, theme)}${gap}`;
    }
    rows.push(line);
  }
  rows.push(`${theme.fg("dim", "    · none  ")}${theme.fg("success", "░ low  ▒ med  ")}${theme.fg("warning", "▓ high  ")}${theme.bold(theme.fg("error", "█ peak"))}`);
  return rows;
}

function activityPulse(stats: AggregatedStats, width: number, theme: DashboardTheme): string[] {
  const range = heatRange(stats.range, stats.daily);
  if (!range) return [theme.fg("dim", "No activity in this range")];
  const activeEntries = [...stats.daily.entries()].filter(([, totals]) => totals.freshTokens > 0).sort(([a], [b]) => a.localeCompare(b));
  const activeDays = activeEntries.length;
  const periodDays = Math.max(1, Math.floor((range.end - range.start) / DAY_MS) + 1);
  const peak = [...activeEntries].sort((a, b) => b[1].freshTokens - a[1].freshTokens)[0];
  const activeSet = new Set(activeEntries.map(([day]) => day));
  const weekday = busiestWeekday(activeEntries);
  const chartWidth = Math.max(8, width);
  const chart = activitySparkline(stats, range, chartWidth, theme);
  const peakValue = peak ? `${shortMonthDay(Date.parse(`${peak[0]}T00:00:00.000Z`))} · ${formatTokens(peak[1].freshTokens)}` : "none";
  const average = activeDays ? formatTokens(stats.totals.freshTokens / activeDays) : "0";
  return [
    pulseMetric("Active days", `${activeDays} / ${periodDays} (${percent(activeDays / periodDays)})`, theme),
    pulseMetric("Peak", peakValue, theme),
    pulseMetric("Avg / active day", average, theme),
    pulseMetric("Streak", `${currentStreak(activeSet, stats.range.end === undefined ? shortDate(Date.now()) : shortDate(range.end))} current · ${longestStreak(activeSet)} best`, theme),
    pulseMetric("Busiest weekday", weekday, theme),
    "",
    theme.fg("muted", "FRESH TOKEN TREND"),
    chart.line,
    theme.fg("dim", `low ${formatTokens(chart.min)}  ·  high ${formatTokens(chart.max)}`),
  ].map((line) => fit(line, width));
}

function pulseMetric(label: string, value: string, theme: DashboardTheme): string {
  return `${padAnsi(theme.fg("muted", label), 19)} ${theme.bold(value)}`;
}

function activitySparkline(stats: AggregatedStats, range: { start: number; end: number }, width: number, theme: DashboardTheme): { line: string; min: number; max: number } {
  const values: number[] = [];
  for (let timestamp = range.start; timestamp <= range.end; timestamp += DAY_MS) {
    values.push(stats.daily.get(shortDate(timestamp))?.freshTokens || 0);
  }
  const bucketCount = Math.max(1, Math.min(width, values.length));
  const buckets: number[] = [];
  for (let index = 0; index < bucketCount; index++) {
    const start = Math.floor((index * values.length) / bucketCount);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / bucketCount));
    buckets.push(Math.max(...values.slice(start, end)));
  }
  const max = Math.max(...buckets, 0);
  const positive = buckets.filter((value) => value > 0);
  const min = positive.length ? Math.min(...positive) : 0;
  const blocks = "▁▂▃▄▅▆▇█";
  const line = buckets.map((value) => {
    if (!value || !max) return theme.fg("dim", "·");
    const level = Math.min(blocks.length - 1, Math.max(0, Math.ceil((value / max) * blocks.length) - 1));
    const tone: Color = level >= 6 ? "error" : level >= 4 ? "warning" : "success";
    return theme.fg(tone, blocks[level]!);
  }).join("");
  return { line, min, max };
}

function busiestWeekday(entries: Array<[string, UsageTotals]>): string {
  if (!entries.length) return "none";
  const totals = Array.from({ length: 7 }, () => 0);
  for (const [day, usage] of entries) totals[new Date(`${day}T00:00:00.000Z`).getUTCDay()]! += usage.freshTokens;
  const index = totals.indexOf(Math.max(...totals));
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][index]!;
}

function longestStreak(activeDays: Set<string>): number {
  const days = [...activeDays].sort();
  let best = 0;
  let current = 0;
  let previous = 0;
  for (const day of days) {
    const timestamp = Date.parse(`${day}T00:00:00.000Z`);
    current = previous && timestamp - previous === DAY_MS ? current + 1 : 1;
    best = Math.max(best, current);
    previous = timestamp;
  }
  return best;
}

function currentStreak(activeDays: Set<string>, endDay: string): number {
  let streak = 0;
  let timestamp = Date.parse(`${endDay}T00:00:00.000Z`);
  while (activeDays.has(shortDate(timestamp))) {
    streak++;
    timestamp -= DAY_MS;
  }
  return streak;
}

function heatRange(range: DateRange, daily: AggregatedStats["daily"]): { start: number; end: number } | undefined {
  const keys = [...daily.keys()].sort();
  if (!keys.length && (range.start === undefined || range.end === undefined)) return undefined;
  const start = range.start ?? Date.parse(`${keys[0]}T00:00:00.000Z`);
  const endExclusive = range.end ?? Date.parse(`${keys[keys.length - 1]}T00:00:00.000Z`) + DAY_MS;
  return { start, end: endExclusive - DAY_MS };
}

function monthAxis(start: number, weeks: number, visibleStart: number, visibleEnd: number, cellWidth: number): string {
  const chars = Array.from({ length: weeks * cellWidth }, () => " ");
  let lastMonth = -1;
  for (let week = 0; week < weeks; week++) {
    const timestamp = start + week * 7 * DAY_MS;
    if (timestamp < visibleStart - 6 * DAY_MS || timestamp > visibleEnd) continue;
    const date = new Date(timestamp);
    const month = date.getUTCMonth();
    if (month === lastMonth) continue;
    const monthName = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const label = cellWidth === 1 ? monthName[0]! : monthName;
    const position = Math.min(week * cellWidth, Math.max(0, chars.length - label.length));
    for (let index = 0; index < label.length && position + index < chars.length; index++) chars[position + index] = label[index]!;
    lastMonth = month;
  }
  return chars.join("");
}

function heatChar(value: number, max: number, theme: DashboardTheme): string {
  if (!value || !max) return theme.fg("dim", "·");
  const ratio = value / max;
  if (ratio < 0.25) return theme.fg("success", "░");
  if (ratio < 0.5) return theme.fg("success", "▒");
  if (ratio < 0.75) return theme.fg("warning", "▓");
  return theme.bold(theme.fg("error", "█"));
}

function shortMonthDay(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function cacheLeverage(totals: UsageTotals): number {
  const reusableInput = totals.input + totals.cacheRead;
  return reusableInput > 0 ? totals.cacheRead / reusableInput : 0;
}

function costPerMillion(totals: UsageTotals): number | undefined {
  return totals.freshTokens > 0 && totals.cost > 0 ? (totals.cost / totals.freshTokens) * 1_000_000 : undefined;
}

function relativeDelta(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined || previous === 0) return undefined;
  return (current - previous) / previous;
}

function deltaLabel(current: number | undefined, previous: number | undefined, lowerIsBetter: boolean, label: string, theme: DashboardTheme): string | undefined {
  const delta = relativeDelta(current, previous);
  if (delta === undefined) return undefined;
  const better = lowerIsBetter ? delta <= 0 : delta >= 0;
  const arrow = delta > 0.005 ? "↑" : delta < -0.005 ? "↓" : "→";
  return theme.fg(Math.abs(delta) < 0.005 ? "dim" : better ? "success" : "warning", `${arrow} ${percent(Math.abs(delta))} ${label}`);
}

function pointDeltaLabel(current: number, previous: number | undefined, label: string, theme: DashboardTheme): string | undefined {
  if (previous === undefined) return undefined;
  const points = (current - previous) * 100;
  const arrow = points > 0.05 ? "↑" : points < -0.05 ? "↓" : "→";
  const tone: Color = Math.abs(points) < 0.05 ? "dim" : points > 0 ? "success" : "warning";
  return theme.fg(tone, `${arrow} ${Math.abs(points).toFixed(1)} pts ${label}`);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

function percentOf(value: number, total: number): string {
  return percent(total ? value / total : 0);
}

function formatOptionalCost(value: number | undefined): string {
  return value === undefined ? "n/a" : formatCost(value);
}

function shortDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function startOfUtcWeek(timestamp: number): number {
  const date = new Date(timestamp);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return start - date.getUTCDay() * DAY_MS;
}

function fit(text: string, width: number): string {
  return width <= 0 ? "" : truncateToWidth(text, width, "");
}

function cropAnsi(text: string, width: number): string {
  return width <= 0 ? "" : truncateToWidth(text, width, width > 1 ? "…" : "");
}

function padAnsi(text: string, width: number): string {
  const cropped = cropAnsi(text, width);
  return cropped + " ".repeat(Math.max(0, width - visibleWidth(cropped)));
}

function padStartAnsi(text: string, width: number): string {
  const cropped = cropAnsi(text, width);
  return " ".repeat(Math.max(0, width - visibleWidth(cropped))) + cropped;
}
