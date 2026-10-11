import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, isKeyRepeat, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Keybinding, OverlayHandle, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { getRootEditorKeybindings, onRootEditorInput } from "../../themes/pi-irfan-devs/root-editor.ts";
import type { ManagerSettings } from "./upstream/src/prefs/settings.ts";
import type { ThreadService, ThreadView } from "./upstream/src/types.ts";
import { DIALOG_OPTIONS } from "./upstream/src/ui/dialog.ts";
import { createInlineNavigation, type NavigationKey } from "./inline-navigation.ts";
import { agentIdentity, orderedAgents, type AgentMetrics, type AgentRow, type AgentSelection } from "./fleet-view.ts";
import { TaskPanel, type TaskDraft } from "./task-panel.ts";

type EditorView = Component & { getText(): string; isShowingAutocomplete(): boolean };

/** A task dock plus a disposable detail panel; the root editor keeps its own input and submit hooks. */
export function createManagerPresentation(options: {
  settings(): ManagerSettings | undefined;
  threads(): ThreadView[];
  metrics?(path: string): AgentMetrics | undefined;
  service(): ThreadService;
  /** Must attest the actual root editor, not merely instanceof CustomEditor. */
  isEditor(component: unknown): component is EditorView;
  renderOther?(ctx: ExtensionContext, settings: ManagerSettings, threads: ThreadView[], ended: boolean): void;
}) {
  let context: ExtensionContext | undefined, tui: TUI | undefined, offInput: (() => void) | undefined;
  let pasting = false, pasteTail = "", generation = 0, opening = false;
  let heldAction: NavigationKey | undefined;
  let clock: ReturnType<typeof setInterval> | undefined, panel: TaskPanel | undefined;
  let boundEditor: EditorView | undefined, offEditorInput: (() => void) | undefined;
  let drafts = new Map<string, TaskDraft>();
  const warn = (message: string) => { try { context?.ui.notify(message, "warning"); } catch { /* UI may be closing. */ } };
  const editor = (): EditorView | undefined => {
    if (!tui || tui.hasOverlay()) return;
    const focus = tui.getFocusedComponent();
    return options.isEditor(focus) ? focus : undefined;
  };
  const navigation = createInlineNavigation({
    threads: options.threads, metrics: options.metrics,
    editor: { getText: () => editor()?.getText() ?? context?.ui.getEditorText() ?? "" },
    openDetails: selection => { if (context) launch(context, selection); },
    changed: () => tui?.requestRender(),
  });
  function bindEditor() {
    const focus = editor();
    if (focus === boundEditor) return;
    offEditorInput?.(); offEditorInput = undefined; boundEditor = focus;
    if (focus) offEditorInput = onRootEditorInput(focus, data => input(data)?.consume === true);
  }

  function launch(ctx: ExtensionContext, selection: AgentSelection) {
    if (opening || panel || !ctx.hasUI || ctx.mode !== "tui" || options.settings()?.subagentMode === "off") return;
    if (!options.threads().some(thread => thread.path === selection.path && agentIdentity(thread) === selection.identity)) return;
    if (!tui || tui.hasOverlay()) { ctx.ui.notify("Return to the main prompt before opening a task.", "info"); return; }
    const host = tui;
    const ownGeneration = generation;
    opening = true;
    let view: TaskPanel | undefined;
    let overlay: OverlayHandle | undefined;
    try {
      view = new TaskPanel({ host, theme: ctx.ui.theme, threads: options.threads, metrics: options.metrics,
        service: options.service(), selection, drafts, done: () => {
          // ctx.ui.custom's close pops the top overlay in Pi 1.1.0. Retain an
          // exact public handle so cleanup cannot close another extension's UI.
          overlay?.hide(); view?.dispose();
          if (ownGeneration !== generation) return;
          panel = undefined; opening = false;
          if (options.isEditor(host.getFocusedComponent())) navigation.focus(view?.selected);
          else navigation.reset();
          host.requestRender();
        } });
      panel = view;
      overlay = host.showOverlay(view, DIALOG_OPTIONS.overlayOptions);
      opening = false;
    } catch {
      overlay?.hide(); view?.dispose(); panel = undefined; opening = false;
      warn("Task view could not open. Try /agents tasks again.");
    }
  }
  /** Explicit command fallback also works with another theme's root editor. */
  function open(ctx: ExtensionContext, path?: string) {
    if (!ctx.hasUI) return;
    if (ctx.mode !== "tui") { ctx.ui.notify("Task panels require terminal mode. Use /agents fleet here.", "warning"); return; }
    const thread = orderedAgents(options.threads()).find(thread => path === undefined || thread.path === path);
    if (!thread) { ctx.ui.notify("No matching task. Start a subagent first.", "info"); return; }
    launch(ctx, { path: thread.path, identity: agentIdentity(thread) });
  }

  function ordinaryArrow(data: string, key: NavigationKey, focus: EditorView): boolean {
    const actions: Partial<Record<NavigationKey, Keybinding>> = {
      left: "tui.editor.cursorLeft", right: "tui.editor.cursorRight", up: "tui.editor.cursorUp", down: "tui.editor.cursorDown",
      pageUp: "tui.editor.pageUp", pageDown: "tui.editor.pageDown",
    };
    const action = actions[key];
    if (!action) return true;
    for (const keys of [getKeybindings(), getRootEditorKeybindings(focus)].filter(value => !!value)) {
      if (!keys.matches(data, action)) return false;
      for (const other of Object.keys(keys.getResolvedBindings())) {
        if (other === action || other === `tui.altScreen.${key}`) continue;
        if ((other.startsWith("tui.editor.") || other.startsWith("tui.input.") || other.startsWith("app.") || other.startsWith("tui.altScreen.")) &&
            keys.matches(data, other as Keybinding)) return false;
      }
    }
    return true;
  }
  function input(data: string) {
    if (context?.mode !== "tui" || !context.hasUI || options.settings()?.subagentMode === "off" || opening || panel) return;
    const focus = editor();
    if (!focus) return;
    if (data.includes("\x1b[200~")) {
      navigation.handle("edit", { focused: true, autocomplete: false });
      pasting = !data.includes("\x1b[201~"); pasteTail = pasting ? data.slice(-5) : ""; return;
    }
    if (pasting) {
      const combined = pasteTail + data; pasting = !combined.includes("\x1b[201~"); pasteTail = pasting ? combined.slice(-5) : ""; return;
    }
    // Also guard direct component dispatch; a tap must have only one effect.
    if (isKeyRelease(data)) return;
    if (!isKeyRepeat(data)) heldAction = undefined;
    if (focus.isShowingAutocomplete()) return;
    let key: NavigationKey | undefined;
    if (matchesKey(data, Key.escape)) key = "escape";
    else if (matchesKey(data, Key.left)) key = "left";
    else if (matchesKey(data, Key.right)) key = "right";
    else if (matchesKey(data, Key.up)) key = "up";
    else if (matchesKey(data, Key.down)) key = "down";
    else if (matchesKey(data, Key.pageUp)) key = "pageUp";
    else if (matchesKey(data, Key.pageDown)) key = "pageDown";
    else if (matchesKey(data, Key.enter)) key = "enter";
    if (!key) { navigation.handle("edit", { focused: true, autocomplete: false }); return; }
    if (!ordinaryArrow(data, key, focus)) return;
    if (isKeyRepeat(data) && (key === "enter" || key === "escape")) return navigation.picking || heldAction === key ? { consume: true } : undefined;
    if (navigation.handle(key, { focused: true, autocomplete: false })) {
      if (key === "enter" || key === "escape") heldAction = key;
      return { consume: true };
    }
  }

  function stopClock() { if (clock) clearInterval(clock); clock = undefined; }
  function refreshClock() {
    const active = () => options.threads().some(thread => thread.path !== "/root" && ["starting", "running"].includes(thread.state));
    if (!active()) { stopClock(); return; }
    if (!clock) {
      clock = setInterval(() => {
        if (!context || options.settings()?.subagentMode === "off" || !active()) { stopClock(); return; }
        tui?.requestRender();
      }, 1000);
      clock.unref?.();
    }
  }
  function refresh(ctx: ExtensionContext, ended: boolean) {
    if (!ctx.hasUI) { if (context) clear(context); return; }
    const settings = options.settings();
    if (!settings || settings.subagentMode === "off" || !orderedAgents(options.threads()).length) { clear(ctx); return; }
    ctx.ui.setWidget("native-subagents-navigation", undefined);
    if (ctx.mode !== "tui") { reset(); options.renderOther?.(ctx, settings, options.threads(), ended); return; }
    if (context && context.ui !== ctx.ui) reset();
    context = ctx;
    // The terminal listener only discovers root replacements. Actual navigation
    // runs inside the theme's editor, after registered extension shortcuts.
    if (!offInput) offInput = ctx.ui.onTerminalInput(() => { bindEditor(); });
    const live = new Map(orderedAgents(options.threads()).map(thread => [thread.path, agentIdentity(thread)]));
    for (const [path, draft] of drafts) if (live.get(path) !== draft.identity) drafts.delete(path);
    navigation.reconcile(); panel?.refresh(); refreshClock();
    ctx.ui.setWidget("pi-subagent", (host, theme) => {
      tui = host; bindEditor();
      let renderedRows: AgentRow[] = [];
      return new class extends Text {
        render(width: number) {
          const rows = Math.max(1, Math.min(settings.widgetMode === "minimal" && !navigation.picking ? 4 : 10, host.terminal.rows - 10));
          renderedRows = navigation.view(rows, width, !!editor() || (!!panel && !!boundEditor));
          const palette = context?.ui.theme ?? theme;
          this.setText(renderedRows.map(row => truncateToWidth(
            row.parts ? row.parts.map(part => palette.fg(part.tone, part.text)).join("") : palette.fg("muted", row.text),
            Math.max(0, width), "",
          )).join("\n"));
          return super.render(width);
        }
        handleMouse(event: TuiMouseEvent) {
          if (context !== ctx || opening || panel || pasting || event.type !== "click" || event.button !== "left" ||
            event.shift || event.alt || event.ctrl || !Number.isInteger(event.y) || event.y < 0 ||
            ctx.mode !== "tui" || options.settings()?.subagentMode === "off") return;
          const focus = editor();
          if (!focus || focus.isShowingAutocomplete()) return;
          const selection = renderedRows[event.y]?.selection;
          if (!selection || !navigation.open(selection)) return;
          host.requestRender(); return { handled: true, render: true };
        }
      }("", 0, 0);
    });
  }
  function reset() {
    generation++; stopClock(); offInput?.(); offInput = undefined;
    offEditorInput?.(); offEditorInput = undefined; boundEditor = undefined;
    const previous = panel; panel = undefined; opening = false;
    // Replace the map so a late rejection from an old panel cannot populate a new session.
    drafts = new Map(); previous?.close(); navigation.reset();
    context = undefined; tui = undefined; pasting = false; pasteTail = ""; heldAction = undefined;
  }
  function clear(ctx: ExtensionContext) {
    reset();
    if (ctx.hasUI) { ctx.ui.setWidget("pi-subagent", undefined); ctx.ui.setWidget("native-subagents-navigation", undefined); }
  }
  return { refresh, clear, reset, open };
}
