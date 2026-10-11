import { homedir } from "node:os";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CostDisplayMode } from "../prefs/settings.ts";

export function footerUsage(entries: readonly SessionEntry[]) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHit: number | undefined;
  const add = (usage: Usage | undefined) => {
    if (!usage) return;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
  };
  for (const entry of entries) {
    if (entry.type === "usage") add(entry.usage);
    else if (entry.type === "message") {
      if (entry.message.role === "assistant") {
        add(entry.message.usage);
        const usage = entry.message.usage;
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        cacheHit = prompt ? (usage.cacheRead / prompt) * 100 : undefined;
      } else if (entry.message.role === "toolResult") add(entry.message.usage);
    } else if (entry.type === "branch_summary" || entry.type === "compaction") add(entry.usage);
  }
  return { ...totals, cacheHit };
}
export const COST_WIDGET_ID = "subagent_cost";
export const COST_WIDGET_EVENT = "pi-footer:update-widget";
export const COST_ICON = "\uf0d6";

export function formatSubagentCost(cost: number, nerdFontIcons: boolean): string {
  return `${nerdFontIcons ? COST_ICON + " " : ""}$${cost.toFixed(4)}`;
}

/** Any extension-owned /footer takes priority; never infer activity from installed packages alone. */
export function hasExternalFooter(pi: Pick<ExtensionAPI, "getCommands">): boolean {
  return pi
    .getCommands()
    .some((command) => command.name === "footer" && command.source === "extension");
}

export class CostFooterController {
  private installed = false;
  private requestRender: (() => void) | undefined;

  private publishedMode: CostDisplayMode | undefined;
  private statusContext: ExtensionContext | undefined;
  constructor(
    private readonly pi: Pick<ExtensionAPI, "getCommands" | "events">,
    private readonly subagentCost: () => number,
    private readonly nerdFontIcons: () => boolean,
    private readonly displayMode: () => CostDisplayMode = () => "pi-footer-status",
    private readonly eventFallback: "footer" | "status" = "footer",
  ) {}

  refresh(ctx: ExtensionContext): void {
    const mode = this.displayMode();
    const value = formatSubagentCost(this.subagentCost(), this.nerdFontIcons());
    if (this.publishedMode !== undefined && this.publishedMode !== mode) {
      this.clear();
      this.reset(ctx);
    }
    this.publishedMode = mode;
    if (mode !== "pi-footer-event") {
      if (ctx.hasUI) {
        this.statusContext = ctx;
        const statusValue =
          mode === "pi-status"
            ? `Total: ${formatSubagentCost(
                footerUsage(ctx.sessionManager.getEntries()).cost + this.subagentCost(),
                this.nerdFontIcons(),
              )}`
            : value;
        ctx.ui.setStatus(COST_WIDGET_ID, statusValue);
      }
      return;
    }
    // Event mode also works in headless sessions; status modes need a UI consumer.
    this.pi.events.emit(COST_WIDGET_EVENT, { widgetId: COST_WIDGET_ID, value });
    if (hasExternalFooter(this.pi)) {
      // Do not clear setFooter here: it could already belong to pi-footer.
      this.installed = false;
      this.requestRender = undefined;
      return;
    }
    if (this.eventFallback === "status") {
      if (ctx.hasUI) { this.statusContext = ctx; ctx.ui.setStatus(COST_WIDGET_ID, value); }
      return;
    }
    if (this.installed) {
      this.requestRender?.();
      return;
    }
    if (this.subagentCost() <= 0 || !ctx.hasUI || ctx.mode !== "tui") return;
    this.requestRender = installCostFooter(ctx, this.subagentCost);
    this.installed = true;
  }

  reset(ctx: ExtensionContext): void {
    if (this.installed && !hasExternalFooter(this.pi)) ctx.ui.setFooter(undefined);
    this.installed = false;
    this.requestRender = undefined;
  }

  clear(): void {
    if (this.publishedMode === "pi-footer-event")
      this.pi.events.emit(COST_WIDGET_EVENT, { widgetId: COST_WIDGET_ID, value: null });
    this.statusContext?.ui.setStatus(COST_WIDGET_ID, undefined);
    this.statusContext = undefined;
    this.publishedMode = undefined;
  }
}

const tokens = (n: number) =>
  n < 1000
    ? String(n)
    : n < 10000
      ? `${(n / 1000).toFixed(1)}k`
      : n < 1000000
        ? `${Math.round(n / 1000)}k`
        : `${(n / 1000000).toFixed(1)}M`;

/** Public extension UI APIs only: never inject fake usage/messages into Pi's transcript. */
export function installCostFooter(
  ctx: ExtensionContext,
  subagentCost: () => number,
): (() => void) | undefined {
  if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui.setFooter) return;
  let requestRender: (() => void) | undefined;
  ctx.ui.setFooter((tui, theme, footerData) => {
    requestRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    let entryCount = -1;
    let totals = footerUsage([]);
    return {
      dispose: unsubscribe,
      invalidate() {
        entryCount = -1;
      },
      render(width: number) {
        const entries = ctx.sessionManager.getEntries();
        const count = entries.length;
        if (count !== entryCount) {
          totals = footerUsage(entries);
          entryCount = count;
        }
        const branch = footerData.getGitBranch();
        const name = ctx.sessionManager.getSessionName();
        const cwd =
          ctx.cwd === homedir()
            ? "~"
            : ctx.cwd.startsWith(homedir() + "/")
              ? "~" + ctx.cwd.slice(homedir().length)
              : ctx.cwd;
        const location = cwd + (branch ? ` (${branch})` : "") + (name ? ` • ${name}` : "");
        const parts: string[] = [];
        if (totals.input) parts.push(`↑${tokens(totals.input)}`);
        if (totals.output) parts.push(`↓${tokens(totals.output)}`);
        if (totals.cacheRead) parts.push(`R${tokens(totals.cacheRead)}`);
        if (totals.cacheWrite) parts.push(`W${tokens(totals.cacheWrite)}`);
        if ((totals.cacheRead || totals.cacheWrite) && totals.cacheHit !== undefined)
          parts.push(`CH${totals.cacheHit.toFixed(1)}%`);
        // Pi's own usage and each child's own usage are disjoint. Never aggregate a parent's descendants twice.
        const subscription =
          ctx.model &&
          (ctx.model.provider === "kimi-coding" || ctx.modelRegistry?.isUsingOAuth(ctx.model));
        parts.push(`$${(totals.cost + subagentCost()).toFixed(3)}${subscription ? " (sub)" : ""}`);
        const context = ctx.getContextUsage();
        if (context) {
          const text = `${context.percent === null ? "?" : context.percent.toFixed(1) + "%"}/${tokens(context.contextWindow)}`;
          parts.push(
            theme.fg(
              (context.percent ?? 0) > 90
                ? "error"
                : (context.percent ?? 0) > 70
                  ? "warning"
                  : "dim",
              text,
            ),
          );
        }
        const left = truncateToWidth(parts.join(" "), width, "");
        let right = ctx.model?.id ?? "no-model";
        if (ctx.model?.reasoning) right += ` • ${ctx.thinkingLevel ?? "off"}`;
        if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
          const withProvider = `(${ctx.model.provider}) ${right}`;
          if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
        }
        const available = width - visibleWidth(left) - 2;
        const stats =
          available > 0
            ? left +
              " ".repeat(
                Math.max(2, width - visibleWidth(left) - Math.min(available, visibleWidth(right))),
              ) +
              truncateToWidth(right, available, "")
            : left;
        const lines = [truncateToWidth(theme.fg("dim", location), width), theme.fg("dim", stats)];
        const statuses = [...footerData.getExtensionStatuses()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) =>
            text
              .replace(/[\r\n\t]/g, " ")
              .replace(/ +/g, " ")
              .trim(),
          );
        if (statuses.length)
          lines.push(truncateToWidth(theme.fg("dim", statuses.join(" ")), width));
        return lines;
      },
    };
  });
  return () => requestRender?.();
}

