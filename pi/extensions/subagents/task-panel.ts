import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, getKeybindings, isKeyRelease, isKeyRepeat, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { limits } from "./contracts.ts";
import { agentActivity, agentIdentity, agentLabel, agentState, agentStats, orderedAgents, type AgentMetrics, type AgentSelection } from "./fleet-view.ts";
import { displayText } from "./presentation.ts";
import { projectTaskMessages, taskText, wrapTaskMessages, type TaskLine, type TaskMessage } from "./task-transcript.ts";
import { dialogHeight, frameDialog } from "./upstream/src/ui/dialog.ts";
import type { ThreadService, ThreadView, TranscriptSnapshot } from "./upstream/src/types.ts";

export type TaskDraft = { identity: string | number; text: string };
export type TaskPanelOptions = {
  host: TUI;
  theme: Theme;
  threads(): readonly ThreadView[];
  metrics?(path: string): AgentMetrics | undefined;
  service: ThreadService;
  selection: AgentSelection;
  drafts: Map<string, TaskDraft>;
  done(): void;
};
type Selection = { path: string; identity: string | number };
type PendingSend = Selection & { text: string };
type Delivery = Selection & { failed: boolean };
// Reopening a panel must not duplicate an unresolved send or overfill its recoverable draft.
type DraftScope = { pending: Map<string, PendingSend>; listeners: Set<(delivery: Delivery) => void> };
const scopesByDrafts = new WeakMap<Map<string, TaskDraft>, DraftScope>();

/** A public Pi overlay. It owns only its composer, never Main's editor or execution authority. */
export class TaskPanel {
  private editor: Editor;
  private selection: Selection | undefined;
  private previousIndex = 0;
  private editing = false;
  private focusedState = false;
  private closed = false;
  private unavailable = false;
  private writingEditor = false;
  private draftRecord: TaskDraft | undefined;
  private readonly pending: Map<string, PendingSend>;
  private readonly draftScope: DraftScope;
  private readonly draftChanged: (delivery: Delivery) => void;
  private notice = "";
  private noticeFailed = false;
  private pasting = false;
  private discardingPaste = false;
  private pasteTail = "";
  private attachment = 0;
  private unsubscribe: (() => void) | undefined;
  private revision = -1;
  private generation = -1;
  private observationFailed = false;
  private messages: TaskMessage[] = [];
  private tools = "";
  private rows: TaskLine[] = [];
  private contentWidth = 0;
  private contentDirty = true;
  private fallback = "";
  private follow = true;
  private scrollTop = 0;
  private anchor: string | undefined;
  private viewport = 1;
  private renderedWidth: number | undefined;

  constructor(private readonly options: TaskPanelOptions) {
    const { host } = options;
    this.draftScope = scopesByDrafts.get(options.drafts) ?? { pending: new Map(), listeners: new Set() };
    scopesByDrafts.set(options.drafts, this.draftScope);
    this.pending = this.draftScope.pending;
    this.draftChanged = delivery => {
      if (this.closed) return;
      this.refresh();
      if (!this.unavailable && this.current(delivery) && this.selection?.path === delivery.path && this.selection.identity === delivery.identity) {
        this.notice = delivery.failed ? "Message rejected. Draft kept; check task state or remaining budget."
          : "Accepted for delivery; model consumption is not confirmed.";
        this.noticeFailed = delivery.failed;
      }
      host.requestRender();
    };
    this.draftScope.listeners.add(this.draftChanged);
    this.editor = this.createEditor();
    const path = options.selection.path;
    const thread = path && path !== "/root" ? options.threads().find(item => item.path === path) : undefined;
    if (path && path !== "/root" && (options.selection.identity !== undefined || thread)) {
      this.select({ path, identity: options.selection.identity ?? agentIdentity(thread!) });
    }
  }

  get focused(): boolean { return this.focusedState; }
  set focused(value: boolean) { this.focusedState = value; this.editor.focused = value && this.editing; }
  get selected(): AgentSelection | undefined { return this.selection && { ...this.selection }; }

  refresh(): void {
    if (this.closed) return;
    if (this.selection && !this.unavailable && !this.current()) {
      this.saveDraft(); this.unavailable = true; this.detach();
      this.notice = "Task unavailable. Draft kept; choose another task or close."; this.noticeFailed = true;
      this.options.host.requestRender();
    }
    const selection = this.selection;
    const draft = selection && this.options.drafts.get(selection.path);
    // Another panel's late send failure may restore a draft after this one opened.
    if (draft && draft.identity === selection?.identity && draft !== this.draftRecord) {
      this.draftRecord = draft; this.setText(draft.text); this.options.host.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.closed || !this.focused) return;
    this.refresh();
    if (this.pasting || this.discardingPaste || data.includes("\x1b[200~")) {
      if (!this.pasting && !this.discardingPaste && !this.canCompose()) { this.discardingPaste = true; this.enlarge(); }
      this.paste(data);
      return;
    }
    if (isKeyRelease(data)) return;
    const keys = getKeybindings();
    const enter = matchesKey(data, Key.enter), submit = keys.matches(data, "tui.input.submit");
    const escape = matchesKey(data, Key.escape), tab = matchesKey(data, Key.tab);
    if (isKeyRepeat(data) && (enter || submit || escape || tab)) return;
    if (escape) {
      if (this.editing) { this.saveDraft(); this.compose(false); } else this.close();
      return;
    }
    if (tab) { this.saveDraft(); this.compose(!this.editing); return; }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.scroll(matchesKey(data, Key.pageUp) ? -this.viewport : this.viewport); return;
    }
    if ((!this.editing || this.editor.getText() === "") && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      this.switchTask(matchesKey(data, Key.left) ? -1 : 1); return;
    }
    if (this.editing) {
      if (!this.canCompose()) { this.enlarge(); return; }
      this.editor.handleInput(data); this.saveDraft(); this.options.host.requestRender(); return;
    }
    if (enter) { this.compose(true); return; }
    if (matchesKey(data, Key.up) || keys.matches(data, "tui.select.up")) this.scroll(-1);
    else if (matchesKey(data, Key.down) || keys.matches(data, "tui.select.down")) this.scroll(1);
    else if (matchesKey(data, Key.home)) { this.follow = false; this.scrollTop = 0; this.anchor = this.rows[0]?.key; this.options.host.requestRender(); }
    else if (matchesKey(data, Key.end)) { this.follow = true; this.anchor = undefined; this.options.host.requestRender(); }
  }

  render(width: number): string[] {
    this.renderedWidth = width;
    this.refresh();
    const { host, theme } = this.options;
    const height = dialogHeight(host), inner = Math.max(1, width - 4), budget = Math.max(0, height - 4);
    const thread = this.current(), selection = this.selection;
    const roster = orderedAgents(this.options.threads());
    const index = selection ? roster.findIndex(item => item.path === selection.path && agentIdentity(item) === selection.identity) : -1;
    if (index >= 0) this.previousIndex = index;
    const info = thread && this.options.metrics?.(thread.path);
    const state = !thread || this.unavailable ? "unavailable" : agentState(thread, info);
    const title = `Task ${index >= 0 ? index + 1 : "–"}/${roster.length} · ${selection ? agentLabel(selection.path) : "none selected"} · ${state}`;
    if (width < 4 || height < 4) return frameDialog(theme, width, height, "Enlarge terminal · Esc close", [], "Esc close");

    const bottom: string[] = [];
    if (!this.canCompose() && budget >= 1) bottom.push(theme.fg("warning", "Enlarge terminal to compose; draft kept."));
    else if (this.notice && budget >= 4) bottom.push(theme.fg(this.noticeFailed ? "warning" : "muted", this.notice));
    if (this.editing && this.canCompose()) {
      if (budget >= 7) bottom.push(theme.fg("accent", `${this.pendingForSelection() ? "Sending" : state === "running" || state === "starting" || state === "queued" ? "Steer" : "Resume"} ${selection ? agentLabel(selection.path) : "task"}${state === "unavailable" ? " · sending disabled" : ""}`));
      const editorRows = this.editor.render(inner).slice(1, -1);
      const room = Math.max(1, Math.min(4, Math.floor(budget / 3)));
      const cursor = editorRows.findIndex(line => line.includes(CURSOR_MARKER));
      const start = Math.max(0, cursor - room + 1);
      bottom.push(...editorRows.slice(start, start + room));
    } else if (this.editor.getText() && budget >= 5) bottom.push(theme.fg("muted", "Draft saved · Tab to compose"));

    const available = Math.max(0, budget - bottom.length);
    const metadata: string[] = [];
    if (thread && !this.unavailable) {
      if (available >= 2) metadata.push(...wrapTextWithAnsi(`Task: ${displayText(thread.task, 512)}`, inner).slice(0, available >= 8 ? 2 : 1));
      if (available >= 5) metadata.push(theme.fg("muted", `${displayText(thread.type, 24)} · ${displayText(thread.model ?? "model pending", 120)}${thread.thinkingLevel ? ` · ${thread.thinkingLevel}` : ""}`));
      if (available >= 8) metadata.push(theme.fg("muted", `${agentStats(thread, info)}${info?.hardTurns !== undefined ? ` · max ${info.hardTurns} turns` : ""}`));
      if (available >= 5) metadata.push(theme.fg("muted", this.tools ? `Tools: ${this.tools}` : `Activity: ${agentActivity(thread, info)}`));
    } else if (available >= 2) metadata.push(theme.fg("warning", "This task is unavailable. Sending is disabled."));
    if (available - metadata.length >= 4) metadata.push(theme.fg("dim", `Messages · ${this.follow ? "following live" : "scrolled · End to follow"}`));
    this.viewport = Math.max(0, available - metadata.length);
    const rows = this.content(inner, thread);
    const max = Math.max(0, rows.length - this.viewport);
    if (this.follow) this.scrollTop = max;
    else {
      const anchored = this.anchor === undefined ? -1 : rows.findIndex(row => row.key === this.anchor);
      this.scrollTop = Math.max(0, Math.min(max, anchored >= 0 ? anchored : this.scrollTop));
      this.anchor = rows[this.scrollTop]?.key;
    }
    const visible = rows.slice(this.scrollTop, this.scrollTop + this.viewport).map(row => theme.fg(row.tone, row.text));
    while (visible.length < this.viewport) visible.push("");
    const keys = getKeybindings();
    const label = (key: string) => key.split("+").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("+");
    const submitLabel = label(keys.getKeys("tui.input.submit")[0] ?? "enter");
    const newlineLabel = label(keys.getKeys("tui.input.newLine")[0] ?? "shift+enter");
    const action = state === "unavailable" ? "draft" : ["running", "starting", "queued"].includes(state) ? "steer" : "resume";
    const footer = this.editing ? `${submitLabel} send · Esc save · Tab browse · ${newlineLabel} newline`
      : inner < 76 ? `Enter ${action} · Esc close · ←/→ task · ↑↓ scroll`
      : `Enter ${action} · Esc close · ←/→ task · ↑↓ scroll · PgUp/PgDn · End live`;
    return frameDialog(theme, width, height, title, [...metadata, ...visible, ...bottom].map(line => ` ${truncateToWidth(line, inner, "", true)}`), footer);
  }

  invalidate(): void { this.editor.invalidate(); this.contentDirty = true; }
  close(): void {
    if (this.closed) return;
    this.dispose(); this.options.done();
  }
  dispose(): void {
    if (this.closed) return;
    this.saveDraft(); this.closed = true; this.editor.focused = false; this.detach();
    this.draftScope.listeners.delete(this.draftChanged);
    this.messages = []; this.rows = [];
  }

  private current(selection = this.selection): ThreadView | undefined {
    return selection && this.options.threads().find(thread => thread.path === selection.path && agentIdentity(thread) === selection.identity);
  }
  private createEditor(): Editor {
    const { host, theme } = this.options;
    const editor = new Editor(host, {
      borderColor: text => theme.fg("border", text),
      selectList: {
        selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text), noMatch: text => theme.fg("warning", text),
      },
    }, { paddingX: 0 });
    editor.focused = this.focused && this.editing;
    editor.onChange = () => { if (!this.writingEditor) this.saveDraft(); };
    editor.onSubmit = text => { void this.send(text); };
    return editor;
  }
  private compose(editing: boolean) {
    if (editing && !this.canCompose()) { this.enlarge(); return; }
    if (editing && this.notice === "Enlarge terminal to compose; draft kept.") this.notice = "";
    this.editing = editing; this.editor.focused = this.focused && editing; this.options.host.requestRender();
  }
  private canCompose() {
    return (this.renderedWidth ?? Math.floor((this.options.host.terminal.columns ?? 80) * 0.9)) >= 20 && dialogHeight(this.options.host) >= 8;
  }
  private enlarge() {
    this.notice = "Enlarge terminal to compose; draft kept."; this.noticeFailed = true; this.options.host.requestRender();
  }
  private setText(text: string) {
    this.writingEditor = true;
    try { this.editor.setText(text); } finally { this.writingEditor = false; }
  }
  private saveDraft(text = this.editor.getExpandedText()) {
    const selection = this.selection;
    if (!selection) return;
    const existing = this.options.drafts.get(selection.path);
    if (existing && existing.identity !== selection.identity) return;
    const pending = this.pending.get(selection.path);
    const reserve = pending?.identity === selection.identity ? Buffer.byteLength(pending.text, "utf8") + 2 : 0;
    if (Buffer.byteLength(text, "utf8") > Math.max(0, limits.mailboxBytesPerThread - reserve)) {
      this.setText(existing?.text ?? "");
      this.notice = "Draft limit reached. Existing text kept; wait for the pending send or shorten the draft.";
      this.noticeFailed = true; return;
    }
    if (existing?.text === text) { this.draftRecord = existing; return; }
    this.draftRecord = { identity: selection.identity, text };
    this.options.drafts.set(selection.path, this.draftRecord);
  }
  private select(selection: Selection) {
    this.saveDraft(); this.detach(); this.selection = selection;
    // setText() preserves Pi's undo history; a new composer prevents cross-task undo.
    this.editor.focused = false; this.editor = this.createEditor();
    this.unavailable = !this.current(); this.notice = ""; this.noticeFailed = false;
    this.messages = []; this.tools = ""; this.observationFailed = false; this.contentDirty = true;
    this.follow = true; this.scrollTop = 0; this.anchor = undefined;
    const draft = this.options.drafts.get(selection.path);
    this.draftRecord = draft?.identity === selection.identity ? draft : undefined;
    // Explicit selection of a new identity starts its own empty draft.
    if (draft && !this.draftRecord && !this.unavailable) this.options.drafts.delete(selection.path);
    this.setText(this.draftRecord?.text ?? "");
    if (!this.unavailable) this.attach(selection);
    this.options.host.requestRender();
  }
  private switchTask(direction: -1 | 1) {
    const roster = orderedAgents(this.options.threads());
    if (!roster.length) return;
    const index = roster.findIndex(thread => thread.path === this.selection?.path);
    const next = !this.selection ? 0 : index >= 0 ? index + direction : this.previousIndex + (direction < 0 ? -1 : 0);
    if (next < 0 || next >= roster.length) return;
    const thread = roster[next]; this.previousIndex = next;
    this.select({ path: thread.path, identity: agentIdentity(thread) });
  }
  private detach() {
    this.attachment++;
    try { this.unsubscribe?.(); } catch { /* An optional observer cannot break the panel. */ }
    this.unsubscribe = undefined; this.revision = this.generation = -1;
  }
  private attach(selection: Selection) {
    const attachment = this.attachment, observe = this.options.service.observeTranscript;
    if (!observe) { this.observationFailed = true; return; }
    const live = () => !this.closed && !this.unavailable && this.attachment === attachment && !!this.current(selection);
    const accept = (snapshot: TranscriptSnapshot) => {
      this.refresh();
      if (!live() || (snapshot.thread && (snapshot.thread.path !== selection.path || agentIdentity(snapshot.thread) !== selection.identity))) return;
      if (snapshot.generation < this.generation || (snapshot.generation === this.generation && snapshot.revision <= this.revision)) return;
      this.generation = snapshot.generation; this.revision = snapshot.revision;
      this.messages = projectTaskMessages(snapshot); this.contentDirty = true;
      const recent = snapshot.tools.slice(-12);
      const tools = [...recent.filter(tool => tool.state === "running"), ...recent.filter(tool => tool.state !== "running")].slice(0, 4);
      this.tools = tools.map(tool => `${displayText(tool.toolName, 32)} (${tool.isError ? "failed" : tool.state === "running" ? "running" : "completed"})`).join(" · ");
      this.options.host.requestRender();
    };
    void Promise.resolve().then(() => live() ? observe.call(this.options.service, selection.path, accept) : undefined).then(observation => {
      if (!observation) return;
      if (!live()) { observation.unsubscribe(); return; }
      this.unsubscribe = observation.unsubscribe; accept(observation.snapshot);
    }).catch(() => {
      if (live()) { this.observationFailed = true; this.contentDirty = true; this.options.host.requestRender(); }
    });
  }
  private content(width: number, thread?: ThreadView): TaskLine[] {
    const fallback = this.unavailable || !this.selection ? "Task unavailable. Choose another task or close."
      : thread?.state === "failed" ? "Task failed; inspect its structured outcome in /agents fleet."
      : thread?.output || (this.observationFailed ? "Live messages unavailable; task status remains visible." : "Waiting for agent messages…");
    if (this.contentDirty || width !== this.contentWidth || fallback !== this.fallback) {
      this.contentWidth = width; this.fallback = fallback; this.contentDirty = false;
      const messages = this.messages.length ? this.messages : [{ key: "fallback", role: "Agent" as const, text: taskText(fallback.slice(-12_000)), offset: Math.max(0, fallback.length - 12_000), omitted: fallback.length > 12_000 }];
      this.rows = wrapTaskMessages(messages, width);
    }
    return this.rows;
  }
  private scroll(offset: number) {
    const max = Math.max(0, this.rows.length - this.viewport);
    this.scrollTop = Math.max(0, Math.min(max, this.scrollTop + offset));
    this.follow = offset > 0 && this.scrollTop >= max;
    this.anchor = this.follow ? undefined : this.rows[this.scrollTop]?.key;
    this.options.host.requestRender();
  }
  private pendingForSelection() {
    const selection = this.selection;
    return selection && this.pending.get(selection.path)?.identity === selection.identity;
  }
  private async send(text: string) {
    if (this.closed) return;
    this.refresh();
    const selection = this.selection;
    if (!text.trim()) { this.compose(false); return; }
    if (!this.canCompose()) { this.setText(text); this.saveDraft(); this.enlarge(); return; }
    if (!selection || this.unavailable || !this.current() || this.pendingForSelection() || Buffer.byteLength(text, "utf8") > limits.mailboxBytesPerThread) {
      this.setText(text); this.saveDraft();
      this.notice = this.pendingForSelection() ? "A message is still sending. Draft kept."
        : Buffer.byteLength(text, "utf8") > limits.mailboxBytesPerThread ? `Message limit ${limits.mailboxBytesPerThread / 1024} KiB. Shorten this draft before sending.`
        : "Task unavailable. Sending disabled; draft kept.";
      this.noticeFailed = true; this.options.host.requestRender(); return;
    }
    const pending = { ...selection, text }; this.pending.set(selection.path, pending);
    this.setText(""); this.saveDraft(); this.notice = "Sending…"; this.noticeFailed = false; this.compose(false);
    let failed = false;
    try {
      await this.options.service.steer(selection.path, text);
    } catch {
      failed = true;
      const existing = this.options.drafts.get(selection.path);
      if (this.current(selection) && (!existing || existing.identity === selection.identity)) {
        const current = !this.closed && this.selection?.path === selection.path && this.selection.identity === selection.identity ? this.editor.getExpandedText() : existing?.text ?? "";
        const restored = current ? `${text}\n\n${current}` : text;
        const draft = { identity: selection.identity, text: restored }; this.options.drafts.set(selection.path, draft);
        if (!this.closed && this.selection?.path === selection.path && this.selection.identity === selection.identity) {
          this.draftRecord = draft; this.setText(restored);
          this.notice = "Message rejected. Draft kept; check task state or remaining budget."; this.noticeFailed = true;
          this.compose(true);
        }
      }
    } finally {
      if (this.pending.get(selection.path) === pending) this.pending.delete(selection.path);
      for (const listener of this.draftScope.listeners) {
        try { listener({ ...selection, failed }); } catch { /* Rendering cannot change a delivery outcome. */ }
      }
    }
  }
  private paste(data: string) {
    const combined = this.pasteTail + data, end = combined.indexOf("\x1b[201~");
    const length = end < 0 ? data.length : Math.max(0, end + 6 - this.pasteTail.length);
    if (!this.discardingPaste) {
      if (!this.editing) this.compose(true);
      this.editor.handleInput(data.slice(0, length));
      this.saveDraft(); this.options.host.requestRender();
    }
    this.pasting = !this.discardingPaste && end < 0;
    this.discardingPaste = this.discardingPaste && end < 0;
    this.pasteTail = end < 0 ? combined.slice(-5) : "";
    if (length < data.length) this.handleInput(data.slice(length));
  }
}
