import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagerSettings } from "./upstream/src/prefs/settings.ts";
import type { ThreadView } from "./upstream/src/types.ts";
import { updateWidget } from "./upstream/src/ui/ui.ts";

/** Cooperates with the theme's editor instead of claiming Pi's single editor slot. */
export function createManagerPresentation(pi: Pick<ExtensionAPI, "registerShortcut">, options: {
  settings(): ManagerSettings | undefined;
  threads(): ThreadView[];
  openTree(ctx: ExtensionContext): Promise<void>;
}) {
  let collapsed = false, ended = false;
  function refresh(ctx: ExtensionContext, rootTurnEnded: boolean) {
    ended = rootTurnEnded;
    if (!ctx.hasUI) return;
    const settings = options.settings(), threads = options.threads();
    if (!settings || settings.subagentMode === "off") { clear(ctx); return; }
    updateWidget(ctx, threads, collapsed ? "minimal" : settings.widgetMode,
      settings.nerdFontIcons, ended, settings.loaderStyle, false);
    ctx.ui.setWidget("native-subagents-navigation", ctx.mode === "tui" && threads.some(thread => thread.path !== "/root")
      ? ["Ctrl+Shift+A browser · Ctrl+Shift+C collapse/expand"] : undefined);
  }
  function clear(ctx: ExtensionContext) {
    ctx.ui.setWidget("pi-subagent", undefined);
    ctx.ui.setWidget("native-subagents-navigation", undefined);
  }
  pi.registerShortcut?.("ctrl+shift+a", { description: "Open the subagent tree without replacing the theme editor", handler: async ctx => {
    if (ctx.hasUI && ctx.mode === "tui" && options.settings()?.subagentMode !== "off" && options.threads().length)
      await options.openTree(ctx);
  } });
  pi.registerShortcut?.("ctrl+shift+c", { description: "Collapse/expand the subagent fleet widget", handler: async ctx => {
    if (!ctx.hasUI || ctx.mode !== "tui" || options.settings()?.subagentMode === "off") return;
    collapsed = !collapsed; refresh(ctx, ended);
  } });
  return { refresh, clear, reset() { collapsed = false; ended = false; } };
}
