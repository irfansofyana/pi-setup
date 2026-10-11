import type { ThreadView } from "./upstream/src/types.ts";
import { agentIdentity, compactFleetOverview, fleetOverview, orderedAgents, type AgentMetrics, type AgentRow, type AgentSelection } from "./fleet-view.ts";

export type NavigationKey = "left" | "right" | "up" | "down" | "enter" | "escape" | "pageUp" | "pageDown" | "edit";
export type NavigationContext = { focused: boolean; autocomplete: boolean };
type Options = {
  threads(): readonly ThreadView[];
  editor: { getText(): string };
  openDetails(selection: AgentSelection): unknown;
  changed(): void;
  metrics?(path: string): AgentMetrics | undefined;
  unread?(thread: ThreadView): number;
};

/** Focuses a task row; never changes the root composer or its submission recipient. */
export function createInlineNavigation(options: Options) {
  let picking = false;
  let highlighted: AgentSelection = {};
  const workers = () => orderedAgents(options.threads());
  const choices = (): AgentSelection[] => [{}, ...workers().map(thread => ({ path: thread.path, identity: agentIdentity(thread) }))];
  function reconcile() {
    const threads = workers();
    if (highlighted.path && !threads.some(thread => thread.path === highlighted.path && agentIdentity(thread) === highlighted.identity)) {
      highlighted = {}; options.changed();
    }
    if (!threads.length) picking = false;
  }
  function reset() { picking = false; highlighted = {}; options.changed(); }
  function focus(selection?: AgentSelection) {
    highlighted = selection ? { ...selection } : {}; picking = true;
    reconcile(); options.changed();
  }
  function open(selection: AgentSelection): boolean {
    reconcile();
    if (!selection.path) { reset(); return true; }
    const thread = workers().find(thread => thread.path === selection.path && agentIdentity(thread) === selection.identity);
    if (!thread) return false;
    highlighted = { path: thread.path, identity: agentIdentity(thread) }; picking = true;
    options.openDetails(highlighted); options.changed(); return true;
  }
  function handle(key: NavigationKey, context: NavigationContext): boolean {
    if (!context.focused || context.autocomplete) return false;
    reconcile();
    if (options.editor.getText() !== "") {
      if (picking) reset();
      return false;
    }
    if (!picking) {
      if ((key === "left" || key === "down") && workers().length) {
        picking = true; highlighted = {}; options.changed(); return true;
      }
      return false;
    }
    if (key === "escape" || key === "right") { reset(); return true; }
    if (key === "enter") { open(highlighted); return true; }
    if (key === "up" || key === "down" || key === "pageUp" || key === "pageDown") {
      const entries = choices();
      const current = Math.max(0, entries.findIndex(entry => entry.path === highlighted.path));
      if (key === "up" && current === 0) { reset(); return true; }
      const step = key === "pageUp" ? -5 : key === "pageDown" ? 5 : key === "up" ? -1 : 1;
      highlighted = entries[Math.max(0, Math.min(entries.length - 1, current + step))];
      options.changed(); return true;
    }
    if (key === "left") return true;
    reset(); return false; // Typing and paste continue into the unchanged Main editor.
  }
  function view(maxLines = 12, width?: number, keyboard = true): AgentRow[] {
    reconcile();
    if (!picking) return compactFleetOverview(workers(), maxLines, options.metrics, { width, unread: options.unread });
    return fleetOverview(workers(), maxLines, options.metrics, Date.now(), { width, keyboard, collapseCompleted: !picking,
      focused: picking && keyboard ? highlighted : undefined, unread: options.unread });
  }
  return { handle, open, focus, view, render: (rows = 12) => view(rows).map(row => row.text), reset, reconcile,
    get picking() { return picking; } };
}
