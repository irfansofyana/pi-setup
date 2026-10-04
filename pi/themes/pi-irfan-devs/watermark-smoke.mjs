import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PI_ROOT;
if (!root) throw new Error("Set PI_ROOT to installed @earendil-works/pi-coding-agent root");
const [{ loadExtensions }, { KeybindingsManager }, { loadThemeFromPath, setThemeInstance }, tuiApi,
  { createInteractiveTuiReference }, { createChatViewport }, { InteractiveMode }] = await Promise.all([
  import(path.join(root, "dist/core/extensions/loader.js")),
  import(path.join(root, "dist/core/keybindings.js")),
  import(path.join(root, "dist/modes/interactive/theme/theme.js")),
  import(path.join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")),
  import(path.join(root, "dist/modes/interactive/tui-renderer.js")),
  import(path.join(root, "dist/modes/interactive/chat-viewport.js")),
  import(path.join(root, "dist/modes/interactive/interactive-mode.js")),
]);
const { Container, Spacer, Text, TuiAltScreen, stripTerminalSequences } = tuiApi;
const loaded = await loadExtensions([fileURLToPath(new URL("./index.ts", import.meta.url))], process.cwd());
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const theme = loadThemeFromPath(fileURLToPath(new URL("./theme.json", import.meta.url)));
// Native ThemedText uses SDK global theme, just as initialized InteractiveMode does.
setThemeInstance(theme);
let selectedTheme = theme;
const liveTheme = new Proxy(theme, {
  get(_target, key) {
    const value = Reflect.get(selectedTheme, key, selectedTheme);
    return typeof value === "function" ? value.bind(selectedTheme) : value;
  },
});
let input;
let columns = 80;
let rows = 40;
const writes = [];
const terminal = {
  start(handler) { input = handler; }, stop() {}, drainInput: async () => {},
  write(data) { writes.push(data); },
  get columns() { return columns; }, get rows() { return rows; },
  kittyProtocolActive: false,
  moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
  clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
};
const firstRenderer = new TuiAltScreen(terminal, true, undefined, { mouse: true, copyOnSelect: false });
const driver = {
  renderer: firstRenderer,
  options: {},
  settingsManager: {
    getFullscreenCopyOnSelect: () => false,
    getFullscreenWheelScrollLines: () => 1,
  },
  extensionTerminalInputSubscriptions: new Set(),
  mountInteractiveTui: InteractiveMode.prototype.mountInteractiveTui,
  rebindExtensionTerminalInputListeners: InteractiveMode.prototype.rebindExtensionTerminalInputListeners,
};
const tui = createInteractiveTuiReference(() => driver.renderer);
driver.ui = tui;
driver.extensionWidgetsAbove = new Map();
driver.extensionWidgetsBelow = new Map();
driver.renderWidgets = InteractiveMode.prototype.renderWidgets;
driver.renderWidgetContainer = InteractiveMode.prototype.renderWidgetContainer;
const document = new Container();
const headerContainer = new Container();
const resources = new Container();
const chat = new Container();
document.addChild(headerContainer);
document.addChild(resources);
document.addChild(chat);
const pending = new Container();
const status = new Container();
const above = new Container();
const editorContainer = new Container();
const below = new Container();
const footerContainer = new Container();
driver.widgetContainerAbove = above;
driver.widgetContainerBelow = below;
const components = [document, pending, status, above, editorContainer, below, footerContainer];
for (const component of components) tui.addChild(component);
driver.fullscreenLayoutRoot = createChatViewport({
  document, pendingMessages: pending, status, widgetsAbove: above,
  editor: editorContainer, widgetsBelow: below, footer: footerContainer, scrollbar: "hidden",
}).root;
tui.setLayoutRoot(driver.fullscreenLayoutRoot);
let header;
let footer;
let editor;
let editorFactory;
let entries = [];
let parentSession;
let idle = true;
let pendingMessages = false;
let changed = 0;
const listeners = driver.extensionTerminalInputSubscriptions;
const notifications = [];
const footerData = {
  getGitBranch: () => undefined,
  getAvailableProviderCount: () => 1,
  getExtensionStatuses: () => new Map(),
  onBranchChange: () => () => {},
};
const context = {
  mode: "tui", cwd: process.cwd(),
  sessionManager: {
    getSessionFile: () => undefined,
    getHeader: () => ({ type: "session", parentSession }),
    getEntries: () => entries,
    getLeafId: () => String(entries.length),
  },
  isIdle: () => idle,
  hasPendingMessages: () => pendingMessages,
  getContextUsage: () => undefined,
  ui: {
    theme: liveTheme,
    setHeader(factory) {
      header?.dispose?.(); headerContainer.clear();
      header = factory?.(tui, liveTheme);
      if (header) headerContainer.addChild(header);
    },
    setFooter(factory) {
      footer?.dispose?.(); footerContainer.clear();
      footer = factory?.(tui, liveTheme, footerData);
      if (footer) footerContainer.addChild(footer);
    },
    setEditorComponent(factory) {
      editorFactory = factory;
      editorContainer.clear();
      if (!factory) return;
      editor = factory(tui, { borderColor: text => text, selectList: {} }, new KeybindingsManager());
      // Native InteractiveMode installs this after invoking the editor factory.
      editor.onChange = () => { changed++; };
      editor.onSubmit = () => {};
      editorContainer.addChild(editor);
      tui.setFocus(editor);
    },
    getEditorComponent: () => editorFactory,
    getEditorText: () => editor?.getText() ?? "",
    setEditorText: text => editor.setText(text),
    onTerminalInput(handler) {
      return InteractiveMode.prototype.addExtensionTerminalInputListener.call(driver, handler);
    },
    setWidget(key, content, options) {
      InteractiveMode.prototype.setExtensionWidget.call(driver, key, content, options);
    },
    setWorkingMessage() {}, setWorkingIndicator() {}, setTitle() {},
    notify(message, level) { notifications.push({ message, level }); },
  },
};
const emit = async (name, data = {}) => {
  for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name, ...data }, context);
};
const screen = () => (tui.mode === "fullscreen" ? tui.getScreenLines() : tui.render(columns)).map(stripTerminalSequences);
// Working spinners also use Braille: require a run, not any single dot glyph.
const hasDots = () => screen().some(line => /[\u2801-\u28ff]{4,}/u.test(line));
const render = () => tui.renderNow();
const fresh = async (reason = "new") => {
  selectedTheme = theme;
  setThemeInstance(theme); entries = []; parentSession = undefined; idle = true; pendingMessages = false;
  resources.clear(); chat.clear();
  InteractiveMode.prototype.clearExtensionWidgets.call(driver);
  columns = 80; rows = 40;
  await emit("session_start", { reason });
  render();
  assert.equal(header.render(80).length, 1);
  assert.equal(editor.focused, true);
  assert(hasDots(), "fresh empty native fullscreen should show dotted π");
};
const oldAnimation = process.env.PI_SIGNATURE_ANIMATION;
const oldFooter = process.env.PI_SIGNATURE_COMPACT_FOOTER;
delete process.env.PI_SIGNATURE_ANIMATION;
delete process.env.PI_SIGNATURE_COMPACT_FOOTER;
try {
  tui.start();
  await fresh();
  // Exercise actual /new handler and its real ThemedText startup notice.
  driver.chatContainer = chat;
  driver.clearStatusIndicator = () => status.clear();
  driver.handleFatalRuntimeError = async (_message, error) => { throw error; };
  driver.runtimeHost = { newSession: async () => { await fresh(); return { cancelled: false }; } };
  await InteractiveMode.prototype.handleClearCommand.call(driver);
  render();
  assert(hasDots(), "native /new status notice should leave unused area for watermark");
  chat.clear(); render();
  const unfocused = { focused: false, handleInput() {}, invalidate() {}, render: () => [] };
  tui.setFocus(unfocused); render();
  const base = screen();
  assert.equal(driver.renderer.hasOverlayEntries, false, "hidden watermark must remove overlay entry");
  tui.setFocus(editor); render();
  for (let row = 0; row < base.length; row++) {
    if (base[row].trim()) assert.equal(screen()[row].trim(), base[row].trim(), "mark must not overwrite native UI rows");
  }
  const initial = screen();
  assert.equal(listeners.size, 1);
  const dotRow = initial.findIndex(line => /[\u2801-\u28ff]/u.test(line));
  const dotCol = initial[dotRow].search(/[\u2801-\u28ff]/u);
  const writeStart = writes.length;
  input(`\x1b[<0;${dotCol + 1};${dotRow + 1}M`);
  input(`\x1b[<0;${dotCol + 1};${dotRow + 1}m`);
  assert.equal(editor.focused, true, "click must not transfer focus");
  await new Promise(resolve => setTimeout(resolve, 80));
  render();
  assert.notDeepEqual(screen(), initial, "click should change pose/brightness");
  assert(writes.slice(writeStart).every(write => !write.includes("\x1b[3J")), "animation must not clear scrollback");
  input("x"); render();
  assert.equal(editor.getText(), "x");
  assert(changed > 0, "host onChange callback must survive");
  assert(!hasDots(), "typing hides in same frame");
  await extension.commands.get("pi-watermark").handler("status", context);
  assert.match(notifications.at(-1).message, /editor draft is not empty/);
  context.ui.setEditorText(""); render();
  assert(hasDots(), "clear before submission returns static watermark");
  const replay = extension.commands.get("pi-watermark");
  assert(replay);
  await replay.handler("status", context);
  assert.match(notifications.at(-1).message, /Welcome panel visible/);
  await replay.handler("", context); render();
  assert.equal(editor.focused, true, "keyboard replay must preserve focus");

  context.ui.setWidget("foreign", () => new Text("foreign widget", 0, 0)); render();
  assert(hasDots(), "unrelated widget must coexist in separately reserved rows");
  assert(screen().some(line => line.includes("foreign widget")), "sibling widget must remain visible");
  context.ui.setWidget("foreign", undefined); render(); assert(hasDots());
  await fresh("startup");
  resources.addChild(new Text("[Extension issues]\nHost-provided extension packages must be declared in peerDependencies.", 0, 0)); render();
  assert(hasDots(), "startup warnings must not suppress layout-owned welcome panel");
  assert(screen().some(line => line.includes("Extension issues")), "startup warning must remain in transcript");
  assert.equal(driver.renderer.hasOverlayEntries, false, "welcome must never register native overlay");
  const ownWidget = driver.extensionWidgetsAbove.get("pi-irfan-devs-welcome");
  assert.equal(ownWidget.handleMouse({ type: "click", button: "left", x: 0, y: 0, shift: false, ctrl: false, alt: false }), undefined, "panel margins must not intercept clicks");
  await emit("session_start", { reason: "reload" }); render();
  assert(hasDots(), "reload of fresh metadata-only session with warnings must show panel");
  resources.clear(); render(); assert(hasDots());
  const modal = { focused: false, handleInput() {}, invalidate() {}, render: () => ["dialog"] };
  const handle = tui.showOverlay(modal, { width: 30 }); render();
  assert(!hasDots(), "capturing dialog hides mark");
  handle.hide(); render(); assert(hasDots());
  const overlayEditor = editorFactory(tui, { borderColor: text => text, selectList: {} }, new KeybindingsManager());
  const editorDialog = tui.showOverlay(overlayEditor, { width: 40 });
  render(); assert(!hasDots(), "focused Editor overlay must not masquerade as main editor");
  editorDialog.hide(); render(); assert(hasDots());
  pendingMessages = true; render(); assert(!hasDots());
  pendingMessages = false; render(); assert(hasDots());
  idle = false; render(); assert(!hasDots());
  idle = true; render(); assert(hasDots());
  columns = 42; rows = 14; render(); assert(!hasDots());
  await replay.handler("status", context);
  assert.match(notifications.at(-1).message, /too small/);
  columns = 80; rows = 40; render(); assert(hasDots());

  // Actual native guard/replacement method; do not rerun extension factories.
  const retained = [header, editor, footer];
  tui.setFocus(unfocused);
  input(" "); // native selector input: remove inactive entry before mode handler
  assert.equal(driver.renderer.hasOverlayEntries, false, "settings must not be blocked by hidden decoration");
  const switchMode = mode => {
    const changed = InteractiveMode.prototype.switchTuiMode.call(driver, mode, false, false);
    assert(changed, "native mode switch should accept inactive watermark");
    tui.start();
    driver.rebindExtensionTerminalInputListeners();
    render();
  };
  switchMode("regular");
  tui.setFocus(editor); render();
  assert.equal(tui.mode, "regular");
  await replay.handler("status", context);
  assert.match(notifications.at(-1).message, /regular mode/);
  assert(!hasDots(), "regular mode must remain undecorated");
  assert.equal(listeners.size, 0);
  switchMode("fullscreen");
  assert.equal(tui.mode, "fullscreen");
  assert(hasDots(), "same components must activate against replacement renderer");
  assert.deepEqual([header, editor, footer], retained, "mode changes must not rerun factories");
  assert.equal(listeners.size, 1, "input observer should rebind exactly once");

  selectedTheme = loadThemeFromPath(fileURLToPath(new URL("../irfan-pi.json", import.meta.url)));
  setThemeInstance(selectedTheme);
  tui.invalidate(); render();
  assert.equal(listeners.size, 0, "theme exit unsubscribes input observer");
  selectedTheme = theme; setThemeInstance(theme); tui.invalidate(); render();
  assert(hasDots(), "theme return remounts static watermark");
  assert.equal(listeners.size, 1, "theme return must not duplicate observers");
  input("\x16"); render();
  assert(!hasDots(), "image-paste gesture suppresses mark even without draft text");
  await fresh();
  input("\x1b[200~paste\x1b[201~"); render();
  assert(!hasDots());
  context.ui.setEditorText(""); render();
  assert(!hasDots(), "paste suppression is conservative until new session");
  await fresh();
  await emit("input", { source: "user", text: "hello" }); render();
  assert(!hasDots(), "submitted input retires watermark");
  assert.equal(listeners.size, 0);
  await fresh();
  await emit("agent_start"); render();
  assert(!hasDots(), "agent activity retires watermark");
  await emit("agent_settled"); render(); assert(!hasDots());
  await fresh();
  entries.push({ type: "custom_message", display: false, content: "activity" }); render();
  assert(!hasDots(), "hidden model-context activity still retires watermark");
  entries = []; render(); assert(!hasDots(), "history rewind cannot resurrect it");
  await emit("session_start", { reason: "resume" }); render(); assert(!hasDots());
  parentSession = "parent";
  await emit("session_start", { reason: "fork" }); render(); assert(!hasDots());
  parentSession = undefined;
  await fresh();
  process.env.PI_SIGNATURE_ANIMATION = "0";
  tui.invalidate(); render();
  assert(hasDots(), "motion-off retains static art");
  const staticScreen = screen();
  input(`\x1b[<0;${dotCol + 1};${dotRow + 1}M`);
  input(`\x1b[<0;${dotCol + 1};${dotRow + 1}m`);
  render();
  assert.deepEqual(screen(), staticScreen, "motion-off click does not animate");
  await emit("session_shutdown"); render();
  assert.equal(listeners.size, 0);
  assert(!hasDots(), "shutdown removes decoration");
  // Native multiline widgets: both registration orders and dock pressures.
  const ownKey = "pi-irfan-devs-welcome";
  for (const order of ["before", "after"]) {
    for (const terminalRows of [30, 40]) {
      await fresh();
      const lines = Array.from({ length: 10 }, (_, i) => `meaningful sibling ${i}`);
      if (order === "before") context.ui.setWidget(ownKey, undefined);
      context.ui.setWidget("pressure", lines);
      if (order === "before") await emit("session_start", { reason: "new" });
      rows = terminalRows; render();
      await new Promise(resolve => setImmediate(resolve)); render();
      for (const line of lines) assert(screen().some(row => row.includes(line)), `decoration must yield before clipping: ${order}, ${terminalRows}, ${line}`);
      if (hasDots()) {
        const firstSibling = screen().findIndex(line => line.includes(lines[0]));
        const welcomeRows = driver.extensionWidgetsAbove.get(ownKey).render(columns).length;
        const transcriptRows = firstSibling - 1 - (order === "after" ? welcomeRows : 0);
        assert(transcriptRows >= 8, "welcome must preserve eight transcript rows with native siblings");
      }
    }
  }
  await fresh();
  context.ui.setWidget("opaque", () => ({ render: () => ["opaque meaningful widget"], invalidate() {} }));
  render(); assert(!hasDots(), "opaque custom widget gets priority");
  assert(screen().some(line => line.includes("opaque meaningful widget")));
  await replay.handler("status", context);
  assert.match(notifications.at(-1).message, /welcome yields/);
  context.ui.setWidget("opaque", undefined); render(); assert(hasDots());

  // Native removal/replacement must not resurrect invisible scenes/listeners.
  context.ui.setWidget(ownKey, undefined); tui.invalidate(); render();
  assert(!hasDots()); assert.equal(listeners.size, 0);
  await replay.handler("status", context);
  assert.match(notifications.at(-1).message, /not mounted/);
  await replay.handler("replay", context); assert.equal(listeners.size, 0);
  await fresh();
  context.ui.setWidget(ownKey, ["replacement widget"]); tui.invalidate(); render();
  assert(!hasDots()); assert.equal(listeners.size, 0);
  assert(screen().some(line => line.includes("replacement widget")));
  await replay.handler("status", context);
  assert.match(notifications.at(-1).message, /not mounted/);

  // Nonresponding terminal: remounts must not accumulate query callbacks/buffers.
  for (let i = 0; i < 4; i++) {
    delete process.env.PI_SIGNATURE_ANIMATION;
    await fresh();
    await emit("session_shutdown");
  }
  await new Promise(resolve => setTimeout(resolve, 120));
  const queries = writes.filter(write => write.includes("\x1b]11;?"));
  assert.equal(queries.length, 1, "at most one native color probe per terminal");
  // Test-only inspection: production adapter never reads private query records.
  assert.equal(firstRenderer.pendingTerminalColorQueries.length, 1);
  assert.equal(firstRenderer.pendingTerminalColorQueries[0].deliver, undefined, "timeout must retain no late scene callback");
  console.log("watermark real-Pi mouse/focus/mode/new-session/no-reply smoke passed");
} finally {
  await emit("session_shutdown");
  header?.dispose?.(); footer?.dispose?.();
  tui.stop();
  if (oldAnimation === undefined) delete process.env.PI_SIGNATURE_ANIMATION; else process.env.PI_SIGNATURE_ANIMATION = oldAnimation;
  if (oldFooter === undefined) delete process.env.PI_SIGNATURE_COMPACT_FOOTER; else process.env.PI_SIGNATURE_COMPACT_FOOTER = oldFooter;
}
