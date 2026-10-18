import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, getKeybindings, isKeyRelease, isKeyRepeat, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { limits } from "./contracts.ts";
import { agentActivity, agentIdentity, agentLabel, agentState, agentStats, orderedAgents, type AgentMetrics, type AgentSelection } from "./fleet-view.ts";
import { displayText } from "./presentation.ts";
import { deliveryNotice, type TaskDelivery, type TaskDeliveryMode, type TaskService, type TaskTarget } from "./task-controls.ts";
import { TaskViewStore } from "./task-view-state.ts";
import { projectTaskMessages, taskText, wrapTaskMessages, type TaskLine, type TaskMessage } from "./task-transcript.ts";
import { dialogHeight, frameDialog } from "./upstream/src/ui/dialog.ts";
import type { ThreadView, TranscriptSnapshot } from "./upstream/src/types.ts";

export type TaskDraft = { identity: string | number; text: string };
export type TaskPanelOptions = {
  host: TUI;
  theme: Theme;
  threads(): readonly ThreadView[];
  metrics?(path: string): AgentMetrics | undefined;
  service: TaskService;
  views?: TaskViewStore;
  selection: AgentSelection;
  drafts: Map<string, TaskDraft>;
  done(): void;
  onError?(phase: string, error: unknown): void;
};
type Selection = { path: string; identity: string | number };
type PendingSend = Selection & { text: string };
type Delivery = Selection & { result: TaskDelivery };
// Reopening a panel must not duplicate an unresolved send or overfill its recoverable draft.
type DraftScope = { pending: Map<string, PendingSend>; listeners: Set<(delivery: Delivery) => void>; views: TaskViewStore };
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
  private readonly views: TaskViewStore;
  private mode: TaskDeliveryMode = "steer";
  private target: TaskTarget | undefined;
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
    this.draftScope = scopesByDrafts.get(options.drafts) ?? { pending: new Map(), listeners: new Set(), views: new TaskViewStore() };
    scopesByDrafts.set(options.drafts, this.draftScope);
    this.pending = this.draftScope.pending;
    this.views = options.views ?? this.draftScope.views;
    this.draftChanged = delivery => this.guard("delivery callback", () => {
      if (this.closed) return;
      this.refreshContent();
      if (!this.unavailable && this.current(delivery) && this.selection?.path === delivery.path && this.selection.identity === delivery.identity) {
        const state = this.views.get(delivery); state.delivery = delivery.result; state.retryAllowed = false;
        this.notice = deliveryNotice(delivery.result);
        this.noticeFailed = ["rejected", "unknown_delivery"].includes(delivery.result.status);
      }
      host.requestRender();
    }, undefined);
    this.editor = this.createEditor();
    const path = options.selection.path;
    const thread = path && path !== "/root" ? options.threads().find(item => item.path === path) : undefined;
    try {
      if (path && path !== "/root" && (options.selection.identity !== undefined || thread)) {
        this.select({ path, identity: options.selection.identity ?? agentIdentity(thread!) });
      }
      this.draftScope.listeners.add(this.draftChanged);
    } catch (error) { this.dispose(); throw error; }
  }

  get focused(): boolean { return this.focusedState; }
  set focused(value: boolean) { this.guard("focus", () => { this.focusedState = value; this.editor.focused = value && this.editing; }, undefined); }
  get selected(): AgentSelection | undefined { return this.selection && { ...this.selection }; }

  refresh(): void {
    this.guard("refresh", () => this.refreshContent(), undefined);
  }
  private refreshContent(): void {
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
    this.guard("input", () => this.input(data), undefined);
  }
  private input(data: string): void {
    if (this.closed || !this.focused) return;
    this.refreshContent();
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
    // A configured composer submission/newline wins over panel navigation keys.
    if (this.editing && (submit || keys.matches(data, "tui.input.newLine"))) {
      if (!this.canCompose()) { this.enlarge(); return; }
      // Pi's editor handles Tab completion before submit bindings, even without a provider.
      if (tab && submit && !keys.matches(data, "tui.input.newLine")) this.editor.onSubmit?.(this.editor.getExpandedText());
      else this.editor.handleInput(data);
      this.saveDraft(); this.options.host.requestRender(); return;
    }
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
    if (matchesKey(data, "s") || matchesKey(data, "f")) {
      if (isKeyRepeat(data)) return;
      this.mode = matchesKey(data, "f") ? "follow_up" : "steer";
      this.compose(true); return;
    }
    if (matchesKey(data, "r") && this.selection && this.current() && !isKeyRepeat(data)) {
      const state = this.views.get(this.selection);
      if (state.delivery?.status === "unknown_delivery") {
        state.retryAllowed = true; this.notice = "Retry enabled. Review the task and message before sending again.";
        this.options.host.requestRender();
      }
      return;
    }
    if (enter) { this.compose(true); return; }
    if (matchesKey(data, Key.up) || keys.matches(data, "tui.select.up")) this.scroll(-1);
    else if (matchesKey(data, Key.down) || keys.matches(data, "tui.select.down")) this.scroll(1);
    else if (matchesKey(data, Key.home)) { this.follow = false; this.scrollTop = 0; this.anchor = this.rows[0]?.key; this.options.host.requestRender(); }
    else if (matchesKey(data, Key.end)) { this.follow = true; this.anchor = undefined; this.options.host.requestRender(); }
  }

  render(width: number): string[] {
    return this.guard("render", () => this.renderContent(width), []);
  }
  private renderContent(width: number): string[] {
    this.renderedWidth = width;
    this.refreshContent();
    const { host, theme } = this.options;
    const height = dialogHeight(host), inner = Math.max(1, width - 4), budget = Math.max(0, height - 4);
    const thread = this.current(), selection = this.selection;
    const roster = orderedAgents(this.options.threads());
    const index = selection ? roster.findIndex(item => item.path === selection.path && agentIdentity(item) === selection.identity) : -1;
    if (index >= 0) this.previousIndex = index;
    const info = thread && this.options.metrics?.(thread.path);
    const state = !thread || this.unavailable ? "unavailable" : agentState(thread, info);
    const title = `Task ${index >= 0 ? index + 1 : "–"}/${roster.length} · ${selection ? agentLabel(selection.path, info?.name) : "none selected"} · ${state}`;
    if (width < 4 || height < 4) return frameDialog(theme, width, height, "Enlarge terminal · Esc close", [], "Esc close");

    const bottom: string[] = [];
    if (!this.canCompose() && budget >= 1) bottom.push(theme.fg("warning", "Enlarge terminal to compose; draft kept."));
    else if (this.notice && budget >= 4) bottom.push(theme.fg(this.noticeFailed ? "warning" : "muted", this.notice));
    if (this.editing && this.canCompose()) {
      if (budget >= 7) bottom.push(theme.fg("accent", `${this.pendingForSelection() ? "Sending" : this.mode === "follow_up" ? "Follow up after completion" : "Steer current work"} · ${selection ? agentLabel(selection.path, info?.name) : "task"}${state === "unavailable" ? " · sending disabled" : ""}`));
      const editorRows = this.editor.render(inner).slice(1, -1);
      const room = Math.max(1, Math.min(4, Math.floor(budget / 3)));
      const cursor = editorRows.findIndex(line => line.includes(CURSOR_MARKER));
      const start = Math.max(0, cursor - room + 1);
      bottom.push(...editorRows.slice(start, start + room));
    } else if (this.editor.getText() && budget >= 5) bottom.push(theme.fg("muted", "Draft saved · Tab to compose"));

    const available = Math.max(0, budget - bottom.length);
    const metadata: string[] = [];
    if (thread && !this.unavailable) {
      if (available >= 8) metadata.push(theme.fg("muted", `Target: ${displayText(thread.path, 160)}`));
      if (available >= 2) metadata.push(...wrapTextWithAnsi(`Task: ${displayText(thread.task, 512)}`, inner).slice(0, available >= 8 ? 2 : 1));
      if (available >= 5) metadata.push(theme.fg("muted", `${displayText(thread.type, 24)} · ${displayText(thread.model ?? "model pending", 120)}${thread.thinkingLevel ? ` · ${thread.thinkingLevel}` : ""}`));
      if (available >= 8) metadata.push(theme.fg("muted", `${agentStats(thread, info)}${info?.hardTurns !== undefined ? ` · max ${info.hardTurns} turns` : ""}`));
      if (available >= 5) metadata.push(theme.fg("muted", this.tools ? `Tools: ${this.tools}` : `Activity: ${agentActivity(thread, info)}`));
      if (available >= 10 && ["completed", "failed", "stopped", "paused"].includes(state))
        metadata.push(theme.fg("muted", "Session retained · follow-up uses remaining budget"));
    } else if (available >= 2) metadata.push(theme.fg("warning", "This task is unavailable. Sending is disabled."));
    const unread = selection ? this.views.unread(selection) : 0;
    if (available - metadata.length >= 4) metadata.push(theme.fg("dim", `Messages${unread ? ` · ${unread} new` : ""} · ${this.follow ? "following live" : "scrolled · End to follow"}`));
    this.viewport = Math.max(0, available - metadata.length);
    const rows = this.content(inner, thread);
    const max = Math.max(0, rows.length - this.viewport);
    const waiting = this.revision < 0 && !this.observationFailed && !this.unavailable;
    if (this.follow) this.scrollTop = max;
    else if (!waiting) {
      const anchored = this.anchor === undefined ? -1 : rows.findIndex(row => row.key === this.anchor);
      this.scrollTop = Math.max(0, Math.min(max, anchored >= 0 ? anchored : this.scrollTop));
      this.anchor = rows[this.scrollTop]?.key;
    }
    const top = waiting ? 0 : this.scrollTop;
    const visible = rows.slice(top, top + this.viewport).map(row => theme.fg(row.tone, row.text));
    if (this.follow && this.focused && this.viewport > 0 && thread && selection && !this.unavailable && !waiting) this.views.markSeen(selection, this.messages);
    while (visible.length < this.viewport) visible.push("");
    const keys = getKeybindings();
    const label = (key: string) => key.split("+").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("+");
    const submitLabel = label(keys.getKeys("tui.input.submit")[0] ?? "enter");
    const newlineLabel = label(keys.getKeys("tui.input.newLine")[0] ?? "shift+enter");
    const action = state === "unavailable" ? "draft" : this.mode === "follow_up" ? "follow-up" : "steer";
    const uncertain = thread && selection && this.views.get(selection).delivery?.status === "unknown_delivery" && !this.views.get(selection).retryAllowed;
    const footer = this.editing ? `${submitLabel} send · Esc save · Tab browse · ${newlineLabel} newline`
      : uncertain ? "R allow retry · Enter review draft · Esc close"
      : inner < 76 ? `Enter ${action} · S steer/F follow-up · Esc close`
      : `Enter ${action} · S steer/F follow-up · Esc close · ←/→ task · ↑↓ scroll · End live`;
    return frameDialog(theme, width, height, title, [...metadata, ...visible, ...bottom].map(line => ` ${truncateToWidth(line, inner, "", true)}`), footer);
  }

  invalidate(): void { this.guard("invalidate", () => { this.editor.invalidate(); this.contentDirty = true; }, undefined); }
  close(): void {
    if (this.closed) return;
    this.dispose();
    try { this.options.done(); } catch (error) { this.reportFailure("close", error); }
  }
  dispose(): void {
    if (this.closed) return;
    // Cleanup must continue even if the failing component cannot serialize its draft.
    try { this.saveDraft(); } catch { /* Keep the last successfully saved draft. */ }
    try { this.saveReading(); } catch { /* Cleanup must continue after a UI failure. */ }
    this.closed = true;
    try { this.editor.focused = false; } catch { /* Continue detaching observers. */ }
    this.detach();
    this.draftScope.listeners.delete(this.draftChanged);
    this.messages = []; this.rows = [];
  }

  private guard<T>(phase: string, action: () => T, fallback: T): T {
    if (this.closed) return fallback;
    try { return action(); } catch (error) {
      if (!this.closed) { this.dispose(); this.reportFailure(phase, error); }
      return fallback;
    }
  }
  private reportFailure(phase: string, error: unknown): void {
    try {
      if (this.options.onError) this.options.onError(phase, error);
      else this.options.done();
    } catch { /* Recovery is the final UI boundary; never throw into Pi. */ }
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
    editor.onSubmit = text => { void this.send(text).catch(error => {
      if (!this.closed) { this.dispose(); this.reportFailure("send callback", error); }
    }); };
    return editor;
  }
  private compose(editing: boolean) {
    if (editing && !this.canCompose()) { this.enlarge(); return; }
    if (editing && this.notice === "Enlarge terminal to compose; draft kept.") this.notice = "";
    if (editing && (!this.editing || !this.target) && this.selection) this.target = this.options.service.taskTarget?.(this.selection);
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
    this.saveDraft(); this.saveReading(); this.detach(); this.selection = selection; this.target = undefined;
    // setText() preserves Pi's undo history; a new composer prevents cross-task undo.
    this.editor.focused = false; this.editor = this.createEditor();
    this.unavailable = !this.current(); this.notice = ""; this.noticeFailed = false;
    this.messages = []; this.tools = ""; this.observationFailed = false; this.contentDirty = true;
    const reading = this.views.get(selection);
    this.follow = reading.follow; this.scrollTop = reading.scrollTop; this.anchor = reading.anchor;
    this.mode = reading.mode ?? (["running", "starting"].includes(this.current()?.state ?? "") ? "steer" : "follow_up");
    if (reading.delivery) { this.notice = deliveryNotice(reading.delivery); this.noticeFailed = ["rejected", "unknown_delivery"].includes(reading.delivery.status); }
    const draft = this.options.drafts.get(selection.path);
    this.draftRecord = draft?.identity === selection.identity ? draft : undefined;
    // Explicit selection of a new identity starts its own empty draft.
    if (draft && !this.draftRecord && !this.unavailable) this.options.drafts.delete(selection.path);
    this.setText(this.draftRecord?.text ?? "");
    if (!this.unavailable) this.attach(selection);
    if (this.editing) this.target = this.options.service.taskTarget?.(selection);
    this.options.host.requestRender();
  }
  private saveReading() {
    if (!this.selection || !this.current()) return;
    Object.assign(this.views.get(this.selection), { follow: this.follow, scrollTop: this.scrollTop, anchor: this.anchor, mode: this.mode });
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
    const accept = (snapshot: TranscriptSnapshot) => this.guard("transcript callback", () => {
      this.refreshContent();
      if (!live() || (snapshot.thread && (snapshot.thread.path !== selection.path || agentIdentity(snapshot.thread) !== selection.identity))) return;
      if (snapshot.generation < this.generation || (snapshot.generation === this.generation && snapshot.revision <= this.revision)) return;
      this.generation = snapshot.generation; this.revision = snapshot.revision;
      this.messages = projectTaskMessages(snapshot); this.contentDirty = true;
      this.views.receive(selection, snapshot);
      const recent = snapshot.tools.slice(-12);
      const tools = [...recent.filter(tool => tool.state === "running"), ...recent.filter(tool => tool.state !== "running")].slice(0, 4);
      this.tools = tools.map(tool => `${displayText(tool.toolName, 32)} (${tool.isError ? "failed" : tool.state === "running" ? "running" : "completed"})`).join(" · ");
      this.options.host.requestRender();
    }, undefined);
    void Promise.resolve().then(() => live() ? observe.call(this.options.service, selection.path, accept) : undefined).then(observation => {
      if (!observation) return;
      if (!live()) { observation.unsubscribe(); return; }
      this.unsubscribe = observation.unsubscribe; accept(observation.snapshot);
    }).catch(() => this.guard("transcript subscription", () => {
      if (live()) { this.observationFailed = true; this.contentDirty = true; this.options.host.requestRender(); }
    }, undefined));
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
    this.refreshContent();
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
    const reading = this.views.get(selection);
    if (reading.delivery?.status === "unknown_delivery" && !reading.retryAllowed) {
      this.setText(text); this.saveDraft(); this.notice = deliveryNotice(reading.delivery);
      this.noticeFailed = true; this.options.host.requestRender(); return;
    }
    const target = this.target, mode = this.mode, sendTask = this.options.service.sendTask;
    if (!target || !sendTask) {
      this.setText(text); this.saveDraft(); this.notice = "Task controls unavailable. Draft kept; use /agents fleet.";
      this.noticeFailed = true; this.options.host.requestRender(); return;
    }
    const pending = { ...selection, text }; this.pending.set(selection.path, pending);
    let dispatched = false, result: TaskDelivery = { status: "rejected" };
    try {
      this.setText(""); this.saveDraft(); this.notice = "Sending…"; this.noticeFailed = false; this.compose(false);
      dispatched = true;
      result = await sendTask.call(this.options.service, target, mode, text);
    } catch {
      result = { status: dispatched ? "unknown_delivery" : "rejected" };
    } finally {
      try {
        const existing = this.options.drafts.get(selection.path);
        if (this.current(selection) && (!existing || existing.identity === selection.identity)) {
          reading.delivery = result; reading.retryAllowed = false;
          if (["rejected", "unknown_delivery"].includes(result.status)) {
            const current = !this.closed && this.selection?.path === selection.path && this.selection.identity === selection.identity ? this.editor.getExpandedText() : existing?.text ?? "";
            const restored = current ? `${text}\n\n${current}` : text;
            const draft = { identity: selection.identity, text: restored }; this.options.drafts.set(selection.path, draft);
            if (!this.closed && this.selection?.path === selection.path && this.selection.identity === selection.identity) {
              this.draftRecord = draft; this.setText(restored);
              this.notice = deliveryNotice(result); this.noticeFailed = true;
              if (result.status === "rejected" && result.reason !== "stale_target") {
                this.compose(true); this.target = target;
              }
            }
          }
        }
      } finally {
        if (this.pending.get(selection.path) === pending) this.pending.delete(selection.path);
        for (const listener of this.draftScope.listeners) {
          try { listener({ ...selection, result }); } catch { /* Rendering cannot change a delivery outcome. */ }
        }
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
