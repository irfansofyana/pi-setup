import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { TaskPanel, type TaskDraft } from "./task-panel.ts";
import { limits } from "./contracts.ts";
import type { ThreadService, ThreadView, TranscriptListener, TranscriptObservation, TranscriptSnapshot } from "./upstream/src/types.ts";

const LEFT = "\x1b[D", RIGHT = "\x1b[C", UP = "\x1b[A", DOWN = "\x1b[B", PAGE_UP = "\x1b[5~", END = "\x1b[F", ESC = "\x1b";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const theme = { fg: (_tone: string, text: string) => text } as Theme;
const thread = (path: string, createdAt: number): ThreadView => ({
  path, costId: `${path}-original`, createdAt, updatedAt: createdAt, parent: "/root", owner: "/root", type: "scout",
  state: "running", task: `Inspect ${path}`, status: "Reading files", model: "provider/model", thinkingLevel: "high",
});
const snapshot = (text: string, revision = 1, generation = 0): TranscriptSnapshot => ({
  revision, generation, inheritedCount: 0, tools: [], assistant: null,
  messages: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text }] }] as any,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: { observe?: ThreadService["observeTranscript"]; steer?: ThreadService["steer"]; drafts?: Map<string, TaskDraft>; selection?: { path?: string; identity?: string | number } } = {}) {
  const threads = [thread("/root/second", 2), thread("/root/first", 1)];
  const drafts = overrides.drafts ?? new Map<string, TaskDraft>();
  const listeners = new Map<string, TranscriptListener>();
  const sent: { path: string; text: string | undefined }[] = [];
  let closed = 0, disposed = 0, observations = 0, renders = 0;
  const host = { terminal: { rows: 24, columns: 100 }, requestRender() { renders++; } } as TUI;
  const service = {
    observeTranscript: overrides.observe ?? (async (path: string, listener: TranscriptListener) => {
      observations++; listeners.set(path, listener);
      return { snapshot: snapshot(`Visible message for ${path}`), unsubscribe() { disposed++; } };
    }),
    steer: overrides.steer ?? (async (path: string, text?: string) => { sent.push({ path, text }); return threads.find(item => item.path === path)!; }),
  } as ThreadService;
  const panel = new TaskPanel({ host, theme, threads: () => threads, metrics: () => ({ turns: 2, toolUses: 3, totalTokens: 1234 }), service,
    selection: overrides.selection ?? { path: "/root/first", identity: "/root/first-original" }, drafts, done() { closed++; } });
  panel.focused = true;
  const render = (width = 100) => panel.render(width).map(stripTerminalSequences).join("\n");
  const type = (text: string) => { for (const char of text) panel.handleInput(char === "\n" ? "\x1b[13;2u" : char); };
  return { panel, threads, drafts, listeners, host, sent, render, type,
    get closed() { return closed; }, get disposed() { return disposed; }, get observations() { return observations; }, get renders() { return renders; } };
}

test("opening a panel renders its waiting message before the transcript arrives", async () => {
  const observation = deferred<TranscriptObservation>();
  const f = fixture({ observe: () => observation.promise });
  try {
    assert.match(f.render(60), /Waiting for agent messages/);
    await flush();
    observation.resolve({ snapshot: snapshot("First live message"), unsubscribe() {} });
    await flush();
    assert.match(f.render(60), /First live message/);
  } finally { f.panel.close(); }
});

test("panel shows wrapped live messages and metadata without private transcript fields", async () => {
  const f = fixture(); await flush();
  const next = snapshot("A readable message that wraps across the narrow viewport instead of vanishing at its edge.", 2);
  next.tools = [{ toolCallId: "t", toolName: "read", state: "running", args: "PRIVATE_ARGS", result: "PRIVATE_RESULT" }];
  next.error = "PRIVATE_ERROR"; f.listeners.get("/root/first")!(next);
  const text = f.render(55);
  assert.match(text, /provider\/model/); assert.match(text, /read \(running\)/);
  assert.match(text, /its edge\./); assert.doesNotMatch(text, /PRIVATE_/);
  assert.match(text, /Enter.*steer/i); f.panel.close();
});

test("release and repeat events cannot double compose, send, toggle or close", async () => {
  const f = fixture(); await flush();
  f.panel.handleInput("\x1b[13;1:3u"); assert.doesNotMatch(f.render(), /Enter send/);
  f.panel.handleInput("\x1b[13;1:2u"); assert.doesNotMatch(f.render(), /Enter send/);
  f.panel.handleInput("\r"); f.type("one message");
  f.panel.handleInput("\x1b[13;1:2u"); f.panel.handleInput("\x1b[13;1:3u");
  assert.equal(f.sent.length, 0);
  f.panel.handleInput("\r"); await flush(); assert.equal(f.sent.length, 1);
  f.panel.handleInput("\x1b[27;1:2u"); assert.equal(f.closed, 0); f.panel.close();
});

test("composer retains multiline drafts across browse, task switching and close", async () => {
  const f = fixture(); await flush();
  f.panel.handleInput("\r"); f.type("first line\nsecond line"); f.panel.handleInput(ESC);
  f.panel.handleInput(RIGHT); f.panel.handleInput("\r"); f.type("second task draft");
  f.panel.handleInput(LEFT); assert.match(f.render(), /Task 2\/2/); // nonempty composer edits its cursor
  f.panel.handleInput(ESC); f.panel.handleInput(LEFT); f.panel.handleInput("\t");
  assert.match(f.render(), /first line/); assert.match(f.render(), /second line/);
  f.panel.close();
  assert.equal(f.drafts.get("/root/first")?.text, "first line\nsecond line");
  assert.equal(f.drafts.get("/root/second")?.text, "second task draft");
  assert.equal(f.sent.length, 0);
});

test("Undo in a newly selected task cannot restore another task's draft", async () => {
  const f = fixture(); await flush(); const keys = getKeybindings();
  try {
    keys.setUserBindings({ "tui.editor.undo": "ctrl+z" });
    f.panel.handleInput("\r"); f.type("FIRST_TASK_PRIVATE_DRAFT"); f.panel.handleInput(ESC);
    f.panel.handleInput(RIGHT); f.panel.handleInput("\r"); f.panel.handleInput("\x1a");
    assert.doesNotMatch(f.render(), /FIRST_TASK_PRIVATE_DRAFT/);
    f.type("second task message"); f.panel.handleInput("\r"); await flush();
    assert.deepEqual(f.sent, [{ path: "/root/second", text: "second task message" }]);
    assert.equal(f.drafts.get("/root/first")?.text, "FIRST_TASK_PRIVATE_DRAFT");
  } finally { keys.setUserBindings({}); f.panel.close(); }
});

test("task selection follows stable creation order and does not wrap or select Main", async () => {
  const f = fixture(); await flush();
  f.panel.handleInput(LEFT); assert.match(f.render(), /Task 1\/2/);
  f.threads[1].state = "completed"; f.panel.refresh(); f.panel.handleInput(RIGHT);
  assert.match(f.render(), /Task 2\/2/); assert.match(f.render(), /Inspect \/root\/second/);
  f.panel.handleInput(RIGHT); assert.match(f.render(), /Task 2\/2/); f.panel.close();
});

test("bracketed paste is editor text, and expanded multiline input steers the selected task", async () => {
  const f = fixture(); await flush();
  f.panel.handleInput("\r"); f.panel.handleInput("\x1b[200~");
  f.panel.handleInput("line one\nline two"); f.panel.handleInput("\x1b[201~");
  assert.equal(f.sent.length, 0); f.panel.handleInput("\r"); await flush();
  assert.deepEqual(f.sent, [{ path: "/root/first", text: "line one\nline two" }]);
  assert.match(f.render(), /Accepted.*consumption/); f.panel.close();
});

test("a rejected send restores its draft after close, preserving newer same-task text", async () => {
  const send = deferred<ThreadView>(); const f = fixture({ steer: () => send.promise }); await flush();
  f.panel.handleInput("\r"); f.type("rejected draft"); f.panel.handleInput("\r");
  f.panel.close(); f.drafts.set("/root/first", { identity: "/root/first-original", text: "new draft" });
  send.reject(Error("PRIVATE_PROVIDER_ERROR")); await flush();
  assert.equal(f.drafts.get("/root/first")?.text, "rejected draft\n\nnew draft");
  assert.equal(f.closed, 1);
});

test("late rejection cannot write to a replacement task's draft", async () => {
  const send = deferred<ThreadView>(); const f = fixture({ steer: () => send.promise }); await flush();
  f.panel.handleInput("\r"); f.type("old draft"); f.panel.handleInput("\r"); f.panel.close();
  f.threads[1].costId = "replacement"; f.drafts.set("/root/first", { identity: "replacement", text: "replacement draft" });
  send.reject(Error("no")); await flush();
  assert.deepEqual(f.drafts.get("/root/first"), { identity: "replacement", text: "replacement draft" });
});

test("reopening shares pending delivery and receives its recovered draft without polling", async () => {
  const send = deferred<ThreadView>(); const first = fixture({ steer: () => send.promise }); await flush();
  first.panel.handleInput("\r"); first.type("pending message"); first.panel.handleInput("\r"); first.panel.close();
  const reopened = fixture({ drafts: first.drafts }); await flush(); reopened.panel.handleInput("\r"); reopened.type("new text");
  reopened.panel.handleInput("\r"); await flush(); assert.equal(reopened.sent.length, 0);
  const renders = reopened.renders; send.reject(Error("no")); await flush();
  assert.ok(reopened.renders > renders); assert.match(reopened.render(), /pending message/); assert.match(reopened.render(), /new text/);
  assert.match(reopened.render(), /rejected/);
  reopened.panel.close();
});

test("reaped or replaced selection becomes unavailable and cannot steer its replacement", async () => {
  const f = fixture(); await flush(); f.panel.handleInput("\r"); f.type("old identity message");
  f.threads[1].costId = "replacement"; f.panel.refresh(); f.panel.handleInput("\r"); await flush();
  assert.match(f.render(), /unavailable/i); assert.equal(f.sent.length, 0); assert.equal(f.disposed, 1);
  f.panel.handleInput(ESC); f.panel.handleInput(RIGHT); assert.match(f.render(), /Task 2\/2/);
  f.panel.close();
});

test("late observations are detached after switching and stale snapshot revisions are ignored", async () => {
  const first = deferred<TranscriptObservation>(); let firstListener!: TranscriptListener, detached = 0;
  const f = fixture({ observe: async (path, listener) => {
    if (path === "/root/first") { firstListener = listener; return first.promise; }
    return { snapshot: snapshot("Second task live", 5, 2), unsubscribe() {} };
  } }); await flush();
  f.panel.handleInput(RIGHT); await flush();
  first.resolve({ snapshot: snapshot("OLD_LATE_SNAPSHOT"), unsubscribe() { detached++; } }); await flush();
  firstListener(snapshot("OLD_LATE_CALLBACK", 200));
  assert.match(f.render(), /Second task live/); assert.doesNotMatch(f.render(), /OLD_LATE/); assert.equal(detached, 1);
  f.panel.close();
});

test("outdated transcript revisions and older generations cannot replace newer live text", async () => {
  const f = fixture(); await flush(); const update = f.listeners.get("/root/first")!;
  update(snapshot("Newest observed message", 5, 2));
  update(snapshot("STALE_SAME_GENERATION", 4, 2)); update(snapshot("STALE_PREVIOUS_GENERATION", 500, 1));
  assert.match(f.render(), /Newest observed message/); assert.doesNotMatch(f.render(), /STALE_/);
  f.panel.close();
});

test("a panel opened on Main never observes or submits to the root conversation", async () => {
  const f = fixture({ selection: { path: "/root" } }); await flush();
  f.panel.handleInput("\r"); f.type("cannot target Main"); f.panel.handleInput("\r"); await flush();
  assert.equal(f.observations, 0); assert.equal(f.sent.length, 0); assert.equal(f.drafts.has("/root"), false);
  assert.match(f.render(), /unavailable/); f.panel.close();
});

test("closing before attachment resolves detaches the late observer without rendering again", async () => {
  const observed = deferred<TranscriptObservation>(); let disposed = 0;
  const f = fixture({ observe: () => observed.promise }); await flush(); f.panel.close();
  const renders = f.renders;
  observed.resolve({ snapshot: snapshot("Late message"), unsubscribe() { disposed++; } }); await flush();
  assert.equal(disposed, 1); assert.equal(f.renders, renders); assert.equal(f.closed, 1);
});

test("scrolled history remains stable as output appends, while End resumes following", async () => {
  const f = fixture(); await flush(); const first = Array.from({ length: 60 }, (_, i) => `History line ${i}`).join("\n");
  f.listeners.get("/root/first")!(snapshot(first, 2)); f.render(); f.panel.handleInput(PAGE_UP);
  const before = f.render().split("\n").filter(line => line.includes("History line"));
  f.listeners.get("/root/first")!(snapshot(first + "\nNewest live line", 3));
  assert.deepEqual(f.render().split("\n").filter(line => line.includes("History line")), before);
  assert.doesNotMatch(f.render(), /Newest live line/);
  f.panel.handleInput(END); assert.match(f.render(), /Newest live line/);
  f.panel.close();
});

test("completion keeps panel open and refresh does not attach another observer", async () => {
  const f = fixture(); await flush(); f.threads[1].state = "completed";
  f.panel.refresh(); f.panel.refresh(); assert.equal(f.observations, 1); assert.equal(f.closed, 0);
  assert.match(f.render(), /completed/); assert.match(f.render(), /resume/i);
  f.panel.close(); f.panel.close(); f.panel.dispose(); assert.equal(f.closed, 1); assert.equal(f.disposed, 1);
});

test("unavailable observation falls back to safely wrapped multiline output", async () => {
  const f = fixture({ observe: async () => { throw Error("PRIVATE_OBSERVER_ERROR"); } }); await flush();
  f.threads[1].state = "completed"; f.threads[1].output = "First retained line\nSecond retained line\x1b]0;PRIVATE_TITLE\x07";
  const rows = f.panel.render(60).map(stripTerminalSequences);
  assert.ok(rows.some(line => line.includes("First retained line") && !line.includes("Second retained line")));
  assert.ok(rows.some(line => line.includes("Second retained line")));
  assert.doesNotMatch(rows.join("\n"), /PRIVATE_/); f.panel.close();
});

test("panel and multiline composer fit narrow and short overlays with the cursor visible", async () => {
  const f = fixture(); await flush(); f.panel.handleInput("\r"); f.type("界字\n".repeat(12) + "tail");
  for (const rows of [2, 5, 12, 24, 50]) for (const width of [0, 1, 3, 4, 20, 80]) {
    f.host.terminal.rows = rows; const lines = f.panel.render(width);
    assert.ok(lines.length <= Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.9))));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (rows >= 12 && width >= 20) assert.ok(lines.some(line => line.includes(CURSOR_MARKER)));
  }
  f.panel.close();
});

test("a terminal too small to show the composer cannot silently compose or submit", async () => {
  const f = fixture(); await flush(); f.host.terminal.rows = 4; f.render(30);
  f.panel.handleInput("\r"); f.type("invisible"); f.panel.handleInput("\r");
  assert.equal(f.sent.length, 0); assert.equal(f.drafts.get("/root/first")?.text ?? "", "");
  assert.match(f.render(30), /Enlarge terminal/);
  f.host.terminal.rows = 24; f.render(100); f.panel.handleInput("\r"); f.type("visible draft");
  f.host.terminal.rows = 4; f.render(30); f.panel.handleInput("\r"); await flush();
  assert.equal(f.sent.length, 0); assert.equal(f.drafts.get("/root/first")?.text, "visible draft");
  f.panel.close();
});

test("discarded small-terminal paste drains controls through its split end marker after resize", async () => {
  const f = fixture(); await flush(); f.host.terminal.rows = 4; f.render(30);
  f.panel.handleInput("\x1b[200~"); f.panel.handleInput(ESC);
  assert.equal(f.closed, 0);
  f.host.terminal.rows = 24; f.render(100);
  f.panel.handleInput(RIGHT); f.panel.handleInput("\r"); f.panel.handleInput("discarded text");
  f.panel.handleInput("\x1b[20"); f.panel.handleInput("1~");
  assert.equal(f.panel.selected?.path, "/root/first"); assert.equal(f.sent.length, 0);
  assert.equal(f.drafts.get("/root/first")?.text ?? "", "");
  f.panel.handleInput("\r"); f.type("intentional message"); f.panel.handleInput("\r"); await flush();
  assert.deepEqual(f.sent, [{ path: "/root/first", text: "intentional message" }]); f.panel.close();
});

test("failed tool metadata is shown without exposing its payload", async () => {
  const f = fixture(); await flush(); const next = snapshot("Public response", 2);
  next.tools = [{ toolCallId: "t", toolName: "read", state: "completed", isError: true, args: "PRIVATE_ARGS", result: "PRIVATE_ERROR" }];
  f.listeners.get("/root/first")!(next);
  assert.match(f.render(), /read \(failed\)/); assert.doesNotMatch(f.render(), /PRIVATE_/); f.panel.close();
});

test("pending sends reserve draft space so rejected text remains bounded and recoverable", async () => {
  const send = deferred<ThreadView>(); const f = fixture({ steer: () => send.promise }); await flush();
  const original = "x".repeat(limits.mailboxBytesPerThread - 16);
  f.panel.handleInput("\r"); f.panel.handleInput(`\x1b[200~${original}\x1b[201~`); f.panel.handleInput("\r");
  f.panel.handleInput("\t"); f.type("kept");
  f.panel.handleInput("\x1b[200~overflow beyond available room\x1b[201~");
  assert.equal(f.drafts.get("/root/first")?.text, "kept");
  send.reject(Error("no")); await flush();
  assert.equal(f.drafts.get("/root/first")?.text, `${original}\n\nkept`);
  assert.ok(Buffer.byteLength(f.drafts.get("/root/first")!.text) <= limits.mailboxBytesPerThread);
  f.panel.close();
});

test("custom submission keys remain editor-owned and plain newline remains multiline", async () => {
  const keys = getKeybindings(); const f = fixture(); await flush();
  try {
    keys.setUserBindings({ "tui.input.submit": "ctrl+s", "tui.input.newLine": "ctrl+j" });
    f.panel.handleInput("\r"); f.type("first"); f.panel.handleInput("\n"); f.type("second");
    assert.match(f.render(), /Ctrl\+S send/); assert.match(f.render(), /Ctrl\+J newline/);
    f.panel.handleInput("\x13"); await flush();
    assert.equal(f.sent[0]?.text, "first\nsecond");
  } finally { keys.setUserBindings({}); f.panel.close(); }
});
