import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, Text, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_MANAGER_SETTINGS } from "./upstream/src/prefs/settings.ts";
import { CostFooterController } from "./upstream/src/ui/cost-footer.ts";
import { createManagerPresentation } from "./manager-presentation.ts";
import { createRootThreadService } from "./root-service.ts";
import type { TaskPanel } from "./task-panel.ts";
import type { ThreadView } from "./upstream/src/types.ts";
import { markRootEditor, dispatchRootEditorInput } from "../../themes/pi-irfan-devs/root-editor.ts";

const previousKeys = getKeybindings();
beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
afterEach(() => setKeybindings(previousKeys));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(mode = "tui", initiallyUnrelated = false) {
  const settings = { ...DEFAULT_MANAGER_SETTINGS };
  const widgets = new Map<string, any>(), listeners = new Set<any>();
  const sent: { path: string; text: string }[] = [], main: string[] = [];
  const notices: { text: string; level: string }[] = [];
  const threads: ThreadView[] = ["map", "review"].map((name, i) => ({ path: `/root/${name}`, parent: "/root", owner: "/root",
    type: "scout", task: `Read ${name}`, state: "running", status: "Tool: read", createdAt: i + 1, updatedAt: 1, costId: name, output: `Output ${name}` }));
  const originalSubmit = (text: string) => main.push(text);
  const root = { text: "", autocomplete: false, onSubmit: originalSubmit, disableSubmit: false,
    getText() { return this.text; }, isShowingAutocomplete() { return this.autocomplete; }, render() { return []; }, invalidate() {} };
  markRootEditor(root);
  let focus: unknown = initiallyUnrelated ? { ...root } : root, overlay = false, fallback = 0, opens = 0, renders = 0;
  let panel: TaskPanel | undefined;
  const overlays: any[] = [];
  const service: any = {
    steer: async (path: string, text: string) => { sent.push({ path, text }); return threads.find(t => t.path === path); },
    taskTarget: (selection: any) => ({ ...selection, threadId: "thread-test", runId: "run-test" }),
    sendTask: async (target: any, _mode: string, text: string) => { sent.push({ path: target.path, text }); return { status: "accepted" }; },
  };
  const tui: any = { terminal: { rows: 30, columns: 100 }, hasOverlay: () => overlay || overlays.length > 0, getFocusedComponent: () => focus,
    requestRender() { renders++; },
    showOverlay(component: any) {
      opens++; overlays.push(component); panel = component; component.focused = true; focus = component;
      return { hide() {
        const index = overlays.indexOf(component); if (index < 0) return;
        overlays.splice(index, 1); component.focused = false;
        if (focus === component) focus = overlays.at(-1) ?? root;
      } };
    },
  };
  const theme: any = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value,
    bold: (value: string) => value };
  const ctx: any = { mode, hasUI: true, ui: {
    theme, setWidget(name: string, content: any) { widgets.set(name, content); },
    getEditorText: () => root.text, setEditorText() { throw Error("Main draft must not be changed"); },
    setEditorComponent() { throw Error("Main editor must not be replaced"); },
    onTerminalInput(handler: any) { listeners.add(handler); return () => listeners.delete(handler); },
    notify(text: string, level: string) { notices.push({ text, level }); },
  } };
  const presentation = createManagerPresentation({ settings: () => settings, threads: () => threads, service: () => service,
    isEditor: (value): value is typeof root => value === root,
    renderOther(context) { fallback++; context.ui.setWidget("pi-subagent", ["RPC fleet"]); } });
  let component: any;
  function refresh() {
    presentation.refresh(ctx, false);
    const factory = widgets.get("pi-subagent"); component = typeof factory === "function" ? factory(tui, theme) : undefined;
  }
  refresh();
  const input = (data: string) => {
    [...listeners][0]?.(data);
    return !tui.hasOverlay() && focus === root && dispatchRootEditorInput(root, data) ? { consume: true } : undefined;
  };
  const choose = () => { input("\x1b[D"); input("\x1b[B"); input("\r"); };
  return { presentation, settings, threads, widgets, listeners, root, main, sent, service, tui, ctx, input, choose, refresh, overlays, notices,
    render: (width = 140) => component?.render(width) ?? [], close: () => panel?.close(),
    get panel() { return panel; }, get component() { return component; }, get opens() { return opens; }, get renders() { return renders; }, get fallback() { return fallback; },
    set focus(value: unknown) { focus = value; }, set overlay(value: boolean) { overlay = value; } };
}

test("Kitty arrow release does not move selection twice; Enter release/repeat never reopens or sends", async () => {
  const f = fixture();
  try {
    f.input("\x1b[1;1:1D"); f.input("\x1b[1;1:3D");
    f.input("\x1b[1;1:1B"); f.input("\x1b[1;1:3B");
    assert.match(f.render().join("\n"), /›.*map/);
    f.input("\x1b[13;1:1u"); f.input("\x1b[13;1:3u"); f.input("\x1b[13;1:2u");
    assert.equal(f.opens, 1); assert.match(f.panel!.render(100).join("\n"), /map/);
    assert.deepEqual(f.sent, []);
    f.close(); await flush();
    f.input("\x1b[13;1:2u"); assert.equal(f.opens, 1);
  } finally { f.presentation.clear(f.ctx); }
});

test("completion grace clock renders the collapsed summary before it stops", () => {
  const set = globalThis.setInterval, clear = globalThis.clearInterval, now = Date.now;
  let time = 10000, clears = 0; const ticks: (() => void)[] = [];
  Date.now = () => time;
  (globalThis as any).setInterval = (tick: () => void) => { ticks.push(tick); return { unref() {} }; };
  (globalThis as any).clearInterval = () => { clears++; };
  let f: ReturnType<typeof fixture> | undefined;
  try {
    f = fixture();
    for (const thread of f.threads) { thread.state = "completed"; thread.updatedAt = time; }
    f.refresh(); assert.equal(ticks.length, 1);
    assert.match(f.render().join("\n"), /map/);
    time += 5000; const before = f.renders; ticks[0]();
    assert.ok(f.renders > before); assert.equal(clears, 1);
    assert.equal(f.render().length, 1); assert.match(f.render()[0], /2 subagents completed/);
    f.component.handleMouse({ type: "click", button: "left", y: 0 });
    assert.match(f.render().join("\n"), /Main/);
    assert.equal(f.opens, 0, "summary expands without choosing a recipient");
  } finally { f?.presentation.clear(f.ctx); Date.now = now; globalThis.setInterval = set; globalThis.clearInterval = clear; }
});

test("panel render failure restores Main and leaves its draft and callback intact", () => {
  const f = fixture(); const submit = f.root.onSubmit, fg = f.ctx.ui.theme.fg;
  try {
    f.choose(); f.root.text = "keep main draft";
    f.ctx.ui.theme.fg = () => { throw new TypeError("renderer failure"); };
    assert.doesNotThrow(() => f.panel!.render(100));
    assert.equal(f.overlays.length, 0); assert.equal(f.tui.getFocusedComponent(), f.root);
    assert.equal(f.root.text, "keep main draft"); assert.equal(f.root.onSubmit, submit);
    assert.match(f.notices.at(-1)!.text, /render.*TypeError/);
    f.ctx.ui.theme.fg = fg; f.root.text = ""; f.choose();
    assert.equal(f.overlays.length, 1, "a failed panel can be reopened");
  } finally { f.ctx.ui.theme.fg = fg; f.presentation.clear(f.ctx); }
});

test("dock render failure falls back once and does not capture prompt input", () => {
  const f = fixture(); const fg = f.ctx.ui.theme.fg;
  try {
    f.ctx.ui.theme.fg = () => { throw Error("renderer failure"); };
    assert.doesNotThrow(() => f.render());
    assert.match(f.render().join("\n"), /\/agents tasks/);
    assert.equal(f.notices.length, 1);
    assert.equal(f.input("\x1b[D"), undefined);
    f.root.onSubmit("still usable"); assert.deepEqual(f.main, ["still usable"]);
  } finally { f.ctx.ui.theme.fg = fg; f.presentation.clear(f.ctx); }
});

test("panel failure beneath another overlay removes only the failed task view", () => {
  const f = fixture(); const fg = f.ctx.ui.theme.fg;
  try {
    f.choose(); const unrelated = { focused: true }; f.overlays.push(unrelated); f.focus = unrelated;
    f.ctx.ui.theme.fg = () => { throw Error("render failed"); };
    assert.doesNotThrow(() => f.panel!.render(100));
    assert.deepEqual(f.overlays, [unrelated]); assert.equal(f.tui.getFocusedComponent(), unrelated);
  } finally { f.ctx.ui.theme.fg = fg; f.presentation.clear(f.ctx); }
});

test("root Enter remapped to newline is never stolen by task selection", () => {
  const f = fixture();
  try {
    getKeybindings().setUserBindings({ "tui.input.submit": "ctrl+s", "tui.input.newLine": "enter" });
    f.input("\x1b[D"); f.input("\x1b[B");
    assert.equal(f.input("\r"), undefined); assert.equal(f.opens, 0);
  } finally { f.presentation.clear(f.ctx); }
});

test("a navigation input failure consumes that key before releasing the root hook", () => {
  const f = fixture(); const autocomplete = f.root.isShowingAutocomplete;
  try {
    f.input("\x1b[D"); f.input("\x1b[B");
    f.root.isShowingAutocomplete = () => { throw Error("editor status unavailable"); };
    assert.equal(f.input("\r")?.consume, true, "the failing action must not become a Main submission");
    assert.equal(f.opens, 0); assert.equal(f.notices.length, 1);
    f.root.isShowingAutocomplete = autocomplete;
    assert.equal(f.input("\r"), undefined, "subsequent input returns to Main");
  } finally { f.root.isShowingAutocomplete = autocomplete; f.presentation.clear(f.ctx); }
});

test("held arrows move deliberately and clamp without wrapping to another recipient", () => {
  const f = fixture();
  try {
    f.input("\x1b[D"); f.input("\x1b[B");
    for (let i = 0; i < 8; i++) f.input("\x1b[1;1:2B");
    assert.match(f.render().join("\n"), /›.*review/);
    f.input("\r"); assert.match(f.panel!.render(100).join("\n"), /review/);
  } finally { f.presentation.clear(f.ctx); }
});

test("holding Escape after leaving task selection cannot fall through to Main interrupt", () => {
  const f = fixture();
  try {
    f.input("\x1b[D");
    assert.equal(f.input("\x1b[27;1:1u")?.consume, true);
    assert.equal(f.input("\x1b[27;1:2u")?.consume, true);
    assert.equal(f.input("\x1b[27;1:3u"), undefined);
    assert.equal(f.input("\x1b[27;1:1u"), undefined, "a new press belongs to Main");
  } finally { f.presentation.clear(f.ctx); }
});

test("drafts, autocomplete, overlays and initially focused unrelated editors keep every key", () => {
  const f = fixture("tui", true);
  try {
    assert.equal(f.input("\x1b[D"), undefined);
    f.focus = f.root; f.root.text = "Main draft"; assert.equal(f.input("\x1b[D"), undefined);
    f.root.text = ""; f.root.autocomplete = true; assert.equal(f.input("\x1b[D"), undefined);
    f.root.autocomplete = false; f.overlay = true; assert.equal(f.input("\x1b[D"), undefined);
    assert.equal(f.opens, 0); assert.deepEqual(f.sent, []);
  } finally { f.presentation.clear(f.ctx); }
});

test("bracketed paste and ordinary typing leave task focus and flow only to Main", () => {
  const f = fixture();
  try {
    f.input("\x1b[D"); f.input("\x1b[200~");
    assert.equal(f.input("\x1b[B"), undefined); assert.equal(f.input("\r"), undefined); f.input("\x1b[201~");
    assert.doesNotMatch(f.render().join("\n"), /›/);
    f.root.onSubmit("/reload"); assert.deepEqual(f.main, ["/reload"]); assert.deepEqual(f.sent, []);
    f.input("\x1b[D"); f.input("x"); assert.doesNotMatch(f.render().join("\n"), /›/);
  } finally { f.presentation.clear(f.ctx); }
});

test("remapped arrow actions and remapped submit retain their host behavior", () => {
  const f = fixture();
  try {
    getKeybindings().setUserBindings({ "tui.editor.cursorLeft": "ctrl+b", "tui.input.submit": "left" });
    assert.equal(f.input("\x1b[D"), undefined); assert.equal(f.opens, 0);
  } finally { f.presentation.clear(f.ctx); }
});

test("click opens task panel without changing Main draft or callback; stale rows reject", () => {
  const f = fixture(); const submit = f.root.onSubmit;
  const click: any = { type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 100, height: 12, shift: false, alt: false, ctrl: false };
  try {
    f.root.text = "Main draft"; f.render();
    f.threads[0].costId = "replacement";
    assert.equal(f.component.handleMouse(click), undefined); assert.equal(f.opens, 0);
    f.render(); assert.equal(f.component.handleMouse(click)?.handled, true);
    assert.equal(f.root.text, "Main draft"); assert.equal(f.root.onSubmit, submit);
    assert.ok(f.component instanceof Text);
  } finally { f.presentation.clear(f.ctx); }
});

test("task-panel messages use exact-run steering and cannot execute Main commands", async () => {
  const f = fixture(); const controls: any[] = [];
  const current: any = { runId: "run-active" };
  const scope: any = { get: () => f.threads[0], list: () => f.threads };
  Object.assign(f.service, createRootThreadService({ manager: { scope: () => scope }, handleFor: () => ({ threadId: "thread-bound" }), inspect: () => current } as any,
    async request => { controls.push(request); return { version: 1, controlId: "control", runId: current.runId, status: "accepted" }; }));
  try {
    f.choose(); await flush(); f.panel!.render(100);
    f.panel!.handleInput("\r"); f.panel!.handleInput("/reload"); f.panel!.handleInput("\r"); await flush();
    assert.deepEqual(controls[0], { version: 1, operation: "steer", threadId: "thread-bound", expectedRunId: "run-active", message: "/reload" });
    assert.deepEqual(f.main, []);
  } finally { f.presentation.clear(f.ctx); }
});

test("refresh keeps one input subscription; reset closes panel and restores normal Main input", async () => {
  const f = fixture(); const original = f.root.onSubmit;
  try {
    f.refresh(); f.refresh(); assert.equal(f.listeners.size, 1); f.choose();
    f.presentation.clear(f.ctx); await flush();
    assert.equal(f.listeners.size, 0); assert.equal(f.root.onSubmit, original);
    assert.equal(f.widgets.get("pi-subagent"), undefined);
    f.root.onSubmit("normal Main"); assert.deepEqual(f.main, ["normal Main"]);
  } finally { f.presentation.clear(f.ctx); }
});

test("session cleanup removes only its own panel beneath an unrelated overlay", () => {
  const f = fixture();
  try {
    f.choose(); const owned = f.panel;
    const unrelated = { focused: true }; f.overlays.push(unrelated); f.focus = unrelated;
    f.presentation.clear(f.ctx);
    assert.deepEqual(f.overlays, [unrelated]); assert.equal(f.tui.getFocusedComponent(), unrelated);
    assert.ok(!f.overlays.includes(owned));
  } finally { f.presentation.clear(f.ctx); }
});

test("tiny task dock shows recipient and all rendered rows fit terminal cells", () => {
  const f = fixture();
  try {
    f.input("\x1b[D"); f.input("\x1b[B");
    f.tui.terminal.rows = 11;
    assert.equal(f.render().length, 1); assert.match(f.render()[0], /map/);
    for (const width of [0, 1, 8, 20, 80]) assert.ok(f.render(width).every((line: string) => visibleWidth(line) <= width));
  } finally { f.presentation.clear(f.ctx); }
});

test("RPC/headless modes never register terminal keys or open custom task panels", () => {
  const f = fixture("rpc");
  try {
    assert.equal(f.listeners.size, 0); assert.equal(f.fallback, 1);
    f.presentation.open(f.ctx); assert.equal(f.opens, 0);
    f.ctx.hasUI = false; f.refresh(); assert.equal(f.listeners.size, 0);
  } finally { f.presentation.clear(f.ctx); }
});

test("active display clock is single, stops when settled, and is disposed on shutdown", () => {
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  const ticks: (() => void)[] = []; let clears = 0;
  (globalThis as any).setInterval = (tick: () => void) => { ticks.push(tick); return { unref() {} }; };
  (globalThis as any).clearInterval = () => { clears++; };
  let f: ReturnType<typeof fixture> | undefined;
  try {
    f = fixture(); f.refresh(); assert.equal(ticks.length, 1);
    const renders = f.renders; ticks[0](); assert.equal(f.renders, renders + 1);
    for (const thread of f.threads) thread.state = "completed";
    ticks[0](); assert.equal(clears, 1);
    f.threads[0].state = "running"; f.refresh(); assert.equal(ticks.length, 2);
    f.presentation.clear(f.ctx); assert.equal(clears, 2); assert.equal(f.listeners.size, 0);
  } finally { f?.presentation.clear(f.ctx); globalThis.setInterval = set; globalThis.clearInterval = clear; }
});

test("closing a different task returns selection to that task without changing Main's draft", () => {
  const f = fixture();
  try {
    f.choose(); f.panel!.render(100); f.panel!.handleInput("\x1b[C");
    f.root.text = "Main draft"; f.close();
    assert.match(f.render().join("\n"), /›.*review/); assert.equal(f.root.text, "Main draft");
  } finally { f.presentation.clear(f.ctx); }
});

test("cost display continues using Signature status instead of replacing its footer", () => {
  const statuses = new Map<string, unknown>(); let replaced = 0;
  const controller = new CostFooterController({ getCommands: () => [], events: { emit() {} } } as any,
    () => 0.125, () => false, () => "pi-footer-event", "status");
  const ctx: any = { hasUI: true, mode: "tui", ui: { setStatus: (key: string, value: unknown) => statuses.set(key, value), setFooter: () => { replaced++; } } };
  controller.refresh(ctx); assert.equal(statuses.get("subagent_cost"), "$0.1250"); assert.equal(replaced, 0);
  controller.clear(); controller.reset(ctx); assert.equal(statuses.get("subagent_cost"), undefined);
});
