import assert from "node:assert/strict";
import test from "node:test";
// Production receives this public implementation from the editor factory.
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  setKeybindings, TuiMainScreen, type EditorTheme, type KeybindingsConfig, type Terminal,
} from "@earendil-works/pi-tui";
import { AgentNavigationEditor, type AgentNavigationEditorOptions } from "../src/ui/agent-navigation-editor.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const END = "\x1b[F";
const theme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text, selectedText: (text) => text,
    description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text,
  },
};
class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {}
  hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {}
  clearScreen() {} setTitle() {} setProgress() {}
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(bindings: KeybindingsConfig = {}, options: Partial<AgentNavigationEditorOptions> = {}) {
  const keys = new KeybindingsManager(bindings);
  setKeybindings(keys);
  let opens = 0;
  let collapses = 0;
  const editor = new AgentNavigationEditor(new TuiMainScreen(new FakeTerminal()), theme, keys, {
    openTree: () => { opens++; }, canOpen: () => true,
    collapseWidget: () => { collapses++; }, canCollapse: () => true,
    generation: () => 1, ...options,
  });
  editor.focused = true;
  editor.render(80);
  return { editor, keys, opens: () => opens, collapses: () => collapses };
}

test("Left opens at the beginning of the draft after stock dispatch, preserving text and cursor", async () => {
  for (const draft of ["", "keep this draft", "one\ntwo"]) {
    const { editor, opens } = setup();
    editor.setText(draft);
    editor.handleInput(UP);
    editor.handleInput(HOME);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    editor.handleInput(LEFT);
    assert.equal(opens(), 0);
    await settle();
    assert.equal(opens(), 1);
    assert.equal(editor.getText(), draft);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  }
});

test("Left moves normally inside single, multiline, and wrapped drafts; reaching start does not open", async () => {
  for (const draft of ["abc", "one\ntwo", "a long line that wraps onto several visual rows"]) {
    const { editor, opens } = setup();
    editor.setText(draft);
    editor.render(12);
    for (let i = 0; i < draft.length; i++) editor.handleInput(LEFT);
    await settle();
    assert.equal(opens(), 0);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    editor.handleInput(LEFT);
    await settle();
    assert.equal(opens(), 1);
  }
});

test("Down never opens: empty, end-of-draft, exhausted history, and ordinary history remain stock", async () => {
  const { editor, opens } = setup();
  editor.handleInput(DOWN);
  editor.setText("one\ntwo");
  editor.handleInput(DOWN);
  editor.setText("");
  editor.addToHistory("oldest");
  editor.addToHistory("newest");
  editor.handleInput(UP);
  assert.equal(editor.getText(), "newest");
  editor.handleInput(UP);
  assert.equal(editor.getText(), "oldest");
  editor.handleInput(DOWN);
  assert.equal(editor.getText(), "newest");
  editor.handleInput(DOWN);
  assert.equal(editor.getText(), "");
  editor.handleInput(DOWN);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 0);
});

test("only physical unmodified Left opens, and configured conflicts retain precedence", async () => {
  for (const bindings of [
    { "tui.editor.cursorLeft": "ctrl+b" }, { "tui.editor.historyNext": "left" },
    { "tui.editor.deleteCharForward": "left" }, { "tui.editor.jumpForward": "left" },
    { "app.clear": "left" }, { "tui.altScreen.lineDown": "left" },
  ] satisfies KeybindingsConfig[]) {
    const { editor, opens } = setup(bindings);
    editor.handleInput(LEFT);
    await settle();
    assert.equal(opens(), 0, JSON.stringify(bindings));
  }
  const { editor, opens } = setup();
  for (const input of ["\x02", "\x1b[1;5D", "\x1b[1;3D", "\x1b[1;2D"]) editor.handleInput(input);
  await settle();
  assert.equal(opens(), 0);
  editor.handleInput(LEFT);
  await settle();
  assert.equal(opens(), 1);
});

test("extension shortcuts and application actions dispatch once and prevent navigation", async () => {
  const { editor, opens } = setup();
  let shortcuts = 0;
  const shortcut = (data: string) => { shortcuts++; return data === LEFT; };
  editor.onExtensionShortcut = shortcut;
  editor.handleInput(LEFT);
  await settle();
  assert.equal(shortcuts, 1);
  assert.equal(editor.onExtensionShortcut, shortcut);
  assert.equal(opens(), 0);
  const second = setup({ "app.model.select": "left" });
  let actions = 0;
  second.editor.onAction("app.model.select", () => { actions++; });
  second.editor.handleInput(LEFT);
  await settle();
  assert.equal(actions, 1);
  assert.equal(second.opens(), 0);
});

test("jump cancellation and bracketed paste, including recursive suffixes, never open", async () => {
  const { editor, opens } = setup();
  editor.handleInput("\x1d");
  editor.handleInput(LEFT);
  await settle();
  assert.equal(opens(), 0);
  editor.handleInput("\x1b[200~");
  editor.handleInput(LEFT);
  editor.handleInput("\x1b[201~" + LEFT);
  await settle();
  assert.equal(opens(), 0);
  editor.setText("");
  editor.handleInput("\x1b[200~\x1b[201~\x1d");
  editor.handleInput(LEFT);
  await settle();
  assert.equal(opens(), 0);
  editor.handleInput(LEFT);
  await settle();
  assert.equal(opens(), 1);
});

test("active autocomplete owns input", async () => {
  const { editor, opens } = setup();
  editor.setAutocompleteProvider({
    async getSuggestions() { return { items: [{ value: "one", label: "one" }, { value: "two", label: "two" }], prefix: "" }; },
    applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
  });
  editor.handleInput("\t");
  await settle();
  assert.equal(editor.isShowingAutocomplete(), true);
  editor.handleInput(LEFT);
  await settle();
  assert.equal(opens(), 0);
});

test("repeated Left coalesces until the entire browser interaction finishes", async () => {
  let opens = 0;
  let close!: () => void;
  const open = new Promise<void>((resolve) => { close = resolve; });
  const { editor } = setup({}, { openTree: () => { opens++; return open; } });
  for (let i = 0; i < 3; i++) editor.handleInput(LEFT);
  await settle();
  assert.equal(opens, 1);
  editor.handleInput(LEFT);
  await settle();
  assert.equal(opens, 1);
  close();
  await settle();
});

test("queued transitions revalidate generation, focus, ownership, draft, cursor, disposal, and input", async () => {
  for (const change of ["generation", "focus", "ownership", "draft", "cursor", "dispose", "input"]) {
    let generation = 1;
    let allowed = true;
    const { editor, opens } = setup({}, { generation: () => generation, canOpen: () => allowed });
    editor.setText("draft");
    editor.handleInput(HOME);
    editor.handleInput(LEFT);
    if (change === "generation") generation++;
    if (change === "focus") editor.focused = false;
    if (change === "ownership") allowed = false;
    if (change === "draft") editor.setText("different");
    if (change === "cursor") editor.handleInput(END);
    if (change === "dispose") editor.dispose();
    if (change === "input") editor.handleInput(HOME);
    await settle();
    assert.equal(opens(), 0, change);
  }
});

test("navigation failures report errors and release ownership", async () => {
  let errors = 0;
  let opens = 0;
  const { editor } = setup({}, {
    openTree: async () => { opens++; throw new Error("failed to mount"); },
    onError: () => { errors++; },
  });
  editor.handleInput(LEFT);
  await settle();
  assert.equal(errors, 1);
  editor.handleInput(LEFT);
  await settle();
  assert.equal(opens, 2);
});

test("startup history hydration and replacement history preserve intentional repeated prompts", () => {
  for (const startup of [true, false]) {
    const { editor } = setup({}, startup ? {} : { initialHistory: ["oldest", "newest"] });
    if (startup) { editor.addToHistory("oldest"); editor.addToHistory("newest"); }
    editor.addToHistory("oldest");
    editor.handleInput(UP);
    assert.equal(editor.getText(), "oldest");
    editor.handleInput(UP);
    assert.equal(editor.getText(), "newest");
  }
});

test("openTree runs in the validated microtask", async () => {
  let generation = 1;
  let openedGeneration: number | undefined;
  const { editor } = setup({}, {
    generation: () => generation, openTree: () => { openedGeneration = generation; },
  });
  editor.handleInput(LEFT);
  queueMicrotask(() => { generation = 2; });
  await settle();
  assert.equal(openedGeneration, 1);
});

test("global keybinding conflicts disable navigation", async () => {
  const { editor, opens } = setup();
  setKeybindings(new KeybindingsManager({ "tui.editor.deleteCharForward": "left" }));
  editor.handleInput(LEFT);
  await settle();
  assert.equal(opens(), 0);
});

test("Right collapses at the end of the draft after stock dispatch without changing it", async () => {
  for (const draft of ["", "unfinished", "one\ntwo", "one\n", "🦀 café", "a".repeat(150)]) {
    const { editor, collapses, opens } = setup();
    editor.setText(draft);
    const cursor = editor.getCursor();
    editor.handleInput(RIGHT);
    editor.handleInput(RIGHT);
    assert.equal(collapses(), 0);
    await settle();
    assert.equal(collapses(), 1, draft);
    assert.equal(opens(), 0);
    assert.equal(editor.getText(), draft);
    assert.deepEqual(editor.getCursor(), cursor);
  }
});

test("Right moves normally and never collapses just by reaching the end", async () => {
  const { editor, collapses } = setup();
  editor.setText("one\ntwo");
  editor.handleInput(LEFT);
  editor.handleInput(RIGHT);
  await settle();
  assert.equal(collapses(), 0);
  editor.handleInput(UP);
  editor.handleInput(END);
  editor.handleInput(RIGHT);
  await settle();
  assert.equal(collapses(), 0, "end of an earlier line is not end of the draft");
});

test("Right respects shortcuts, remappings, focus, paste, jumps and autocomplete", async () => {
  const cases: Array<[KeybindingsConfig, (editor: AgentNavigationEditor) => void]> = [
    [{ "tui.editor.cursorRight": "ctrl+f" }, () => {}],
    [{ "tui.editor.deleteCharForward": "right" }, () => {}],
    [{}, (editor) => { editor.focused = false; }],
    [{}, (editor) => { editor.onExtensionShortcut = (data) => data === RIGHT; }],
    [{}, (editor) => { editor.handleInput("\x1b[200~paste"); }],
    [{ "tui.editor.jumpForward": "ctrl+]" }, (editor) => { editor.handleInput("\x1d"); }],
    [{}, (editor) => { editor.isShowingAutocomplete = () => true; }],
  ];
  for (const [index, [bindings, prepare]] of cases.entries()) {
    const { editor, collapses } = setup(bindings);
    prepare(editor);
    editor.handleInput(RIGHT);
    await settle();
    assert.equal(collapses(), 0, `case ${index}`);
  }
  const { editor, collapses } = setup();
  setKeybindings(new KeybindingsManager({ "tui.editor.deleteCharForward": "right" }));
  editor.handleInput(RIGHT);
  await settle();
  assert.equal(collapses(), 0);
});

test("queued collapse is cancelled by new input, disposal, root replacement or changed eligibility", async () => {
  for (const cancel of ["input", "dispose", "root", "mode", "focus"] as const) {
    let generation = 1;
    let allowed = true;
    const { editor, collapses } = setup({}, {
      generation: () => generation, canCollapse: () => allowed,
    });
    editor.handleInput(RIGHT);
    if (cancel === "input") editor.handleInput("x");
    if (cancel === "dispose") editor.dispose();
    if (cancel === "root") generation++;
    if (cancel === "mode") allowed = false;
    if (cancel === "focus") editor.focused = false;
    await settle();
    assert.equal(collapses(), 0, cancel);
  }
});

test("collapse failures report errors and release ownership", async () => {
  let errors = 0;
  let attempts = 0;
  const { editor } = setup({}, {
    collapseWidget: async () => { attempts++; throw new Error("failed collapse"); },
    onError: () => { errors++; },
  });
  editor.handleInput(RIGHT);
  await settle();
  editor.handleInput(RIGHT);
  await settle();
  assert.equal(attempts, 2);
  assert.equal(errors, 2);
});

test("host callbacks survive stock dispatch, replacement, and errors", () => {
  const { editor } = setup();
  const replacement = () => {};
  editor.onChange = () => { editor.onChange = replacement; };
  editor.handleInput("x");
  assert.equal(editor.onChange, replacement);
  const failingShortcut = () => { throw new Error("shortcut failure"); };
  editor.onExtensionShortcut = failingShortcut;
  assert.throws(() => editor.handleInput(LEFT), /shortcut failure/);
  assert.equal(editor.onExtensionShortcut, failingShortcut);
  assert.equal(editor.onChange, replacement);
});

