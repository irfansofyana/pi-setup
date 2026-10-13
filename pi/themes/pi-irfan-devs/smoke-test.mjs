import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const piRoot = process.env.PI_ROOT;
if (!piRoot) {
	throw new Error("Set PI_ROOT to installed @earendil-works/pi-coding-agent root");
}

const [{ loadExtensions }, { KeybindingsManager }, { loadThemeFromPath }, { visibleWidth, stripTerminalSequences }] = await Promise.all([
	import(path.join(piRoot, "dist/core/extensions/loader.js")),
	import(path.join(piRoot, "dist/core/keybindings.js")),
	import(path.join(piRoot, "dist/modes/interactive/theme/theme.js")),
	import(path.join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")),
]);

const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const loaded = await loadExtensions([extensionPath], process.cwd());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
const handlers = (event) => extension.handlers.get(event) ?? [];
const emit = async (event, value = { type: event }) => {
	for (const handler of handlers(event)) await handler(value, context);
};

const themePath = fileURLToPath(new URL("./theme.json", import.meta.url));
const theme = loadThemeFromPath(themePath);
assert.equal(theme.name, "pi-irfan-devs");
let editorFactory;
let footerFactory;
const notifications = [];
let signatureHeaders = 0;
let workingMessage;
const context = {
	mode: "tui",
	cwd: process.cwd(),
	getContextUsage: () => undefined,
	sessionManager: { getSessionFile: () => undefined, getHeader: () => undefined, getEntries: () => [], getLeafId: () => null },
	ui: {
		theme,
		setHeader() { signatureHeaders++; },
		setFooter(factory) { footerFactory = factory; },
		setWidget() {},
		setWorkingMessage(value) { workingMessage = value; },
		setWorkingIndicator() {},
		setTitle() {},
		setEditorComponent(factory) {
			editorFactory = factory;
		},
		getEditorComponent() {
			return editorFactory;
		},
		notify(message, level) {
			notifications.push({ message, level });
		},
	},
};

await emit("session_start");
assert.equal(typeof editorFactory, "function");
assert.equal(signatureHeaders, 1, "canonical entrypoint must register integrated Signature exactly once");

let renderRequests = 0;
const tui = {
	terminal: { rows: 24 },
	requestRender() {
		renderRequests += 1;
	},
};
const editorTheme = {
	borderColor: (text) => text,
	selectList: {},
};
const editor = editorFactory(tui, editorTheme, new KeybindingsManager());
editor.focused = true;
const thinkingColor = "\x1b[38;2;79;111;216m";
editor.borderColor = (text) => `${thinkingColor}${text}\x1b[39m`;
assert(!editor.render(80)[0].includes(thinkingColor), "quiet rails do not glow with thinking-level color");
assert.equal(editor.embedWorkingStatus, true, "native loader is embedded once below input");
const statusStub = (kind, message) => ({
  kind,
  renderInBorder: () => `• ${message}`,
  renderSpinnerInBorder: () => "•",
});
editor.setWorkingStatusIndicator(statusStub("working", "Working"));
let progressLines = editor.render(80);
assert.match(progressLines.at(-1), /Consulting rubber duck/);
assert.equal(progressLines.filter(line => line.includes("Consulting rubber duck")).length, 1);
assert(!progressLines.slice(0, -1).some(line => line.includes("Working")));
assert.equal(editor.render(12).at(-1).trim(), "•", "narrow panes drop the whole quip");
for (const [kind, message] of [["working", "2 tools · read, edit"], ["retry", "Retrying in 2s"], ["compaction", "Auto-compacting..."]]) {
  editor.setWorkingStatusIndicator(statusStub(kind, message));
  assert(editor.render(80).at(-1).includes(message), "factual native status is preserved");
}
editor.setWorkingStatusIndicator(statusStub("idle", "ready"));
assert(!editor.render(80).some(line => line.includes("ready")));
editor.setWorkingStatusIndicator(undefined);

// Real integrated factories share one native status; no extra editor row.
const footerData = {
  getGitBranch: () => "main", getExtensionStatuses: () => new Map(),
  onBranchChange: () => () => {},
};
const integratedFooter = footerFactory(tui, theme, footerData);
const idleRows = editor.render(120).length;
editor.setWorkingStatusIndicator(statusStub("working", "Working"));
assert.equal(editor.render(120).length, idleRows, "footer owns progress without an extra composer row");
assert(!editor.render(120).some(line => line.includes("rubber duck")));
assert.equal(integratedFooter.render(120).length, 2, "two footer rows even without service statuses");
assert.match(integratedFooter.render(120)[0], /main.*no-model.*Consulting rubber duck/);
assert.match(stripTerminalSequences(integratedFooter.render(120)[0]), /Consulting rubber duck…\s*$/);
editor.setWorkingStatusIndicator(statusStub("retry", "Retrying in 2s"));
assert.match(integratedFooter.render(120)[0], /Retrying in 2s/);
assert(!editor.render(120).some(line => line.includes("Retrying")));
const replacementFooter = footerFactory(tui, theme, footerData);
integratedFooter.dispose();
assert.equal(editor.render(120).length, idleRows, "old footer disposal cannot steal progress from replacement");
assert.match(replacementFooter.render(120)[0], /Retrying/);
replacementFooter.dispose();
assert.match(editor.render(120).at(-1), /Retrying/, "missing/replaced footer restores native-status fallback");
editor.setWorkingStatusIndicator(undefined);

for (const rows of [4, 8, 10, 11, 17, 18, 24, 60]) {
	tui.terminal.rows = rows;
	for (let width = 1; width <= 240; width++) {
		const lines = editor.render(width);
		assert(lines.length >= 1, `width ${width}, height ${rows} rendered no lines`);
		for (const [index, line] of lines.entries()) {
			assert(
				visibleWidth(line) <= width,
				`width ${width}, height ${rows}, line ${index}: ${visibleWidth(line)} cells`,
			);
		}
		if (width <= 6) {
			assert(lines.some((line) => line.includes("\x1b_pi:c\x07")), `width ${width} lost the IME cursor marker`);
		}
	}
}
tui.terminal.rows = 24;

const wide = editor.render(80).map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
assert.doesNotMatch(wide.join("\n"), /ASK|┌|┐|└|┘/);
assert.doesNotMatch(wide.join("\n"), /ready/);
assert(wide.some((line) => line.includes("Ask, build, or investigate")));
assert(!wide.some((line) => /@ files|\/ commands|newline/.test(line)), "composer omits shortcut hint");
assert.equal(wide.length, 3, "quiet composer uses top rail, input, and bottom rail");
assert(!wide.some((line) => /[╭╮╰╯│]/.test(line)), "no bright framed box");
if (process.env.SHOW_IRFAN_DEVS === "1") console.log(wide.join("\n"));
// Hit-test the displayed text, not stock border geometry. Include host padding override.
for (const rows of [24, 12]) {
  for (const padding of [1, 2, 3]) {
    tui.terminal.rows = rows;
    editor.setPaddingX(padding);
    editor.setText("abcde");
    const lines = editor.render(80);
    const framed = rows >= 18;
    const event = { type: "click", button: "left", x: 3 + padding + 2, y: framed ? 1 : 0,
      screenX: 0, screenY: 0, width: 80, height: lines.length, shift: false, alt: false, ctrl: false };
    assert.equal(editor.handleMouse(event)?.focus, true);
    editor.handleInput("X");
    assert.equal(editor.getText(), "abXcde", `mouse click misplaced cursor for rows ${rows}, padding ${padding}`);
    assert.equal(editor.handleMouse({ ...event, type: "drag" }), undefined, "drag selection stays renderer-owned");
  }
}
tui.terminal.rows = 24;
editor.setPaddingX(2);
editor.setText("");
editor.handleInput("x");
assert.equal(editor.getText(), "x", "custom editor should preserve normal input handling");
assert(!editor.render(80).some((line) => line.includes("@ files")), "shortcut hint stays absent while typing");
editor.setText("");

tui.terminal.rows = 8;
assert.equal(editor.render(80).length, 2, "short terminal should collapse to one editor row");
tui.terminal.rows = 24;

const renderedText = () =>
	editor
		.render(80)
		.map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
		.join("\n");
const statePattern = (state) => new RegExp(state.toLowerCase());

editor.setText("keep @ files literal");
assert.match(renderedText(), /keep @ files literal/, "user text that resembles the hint must remain prompt content");
editor.setText("first\n\nthird");
const multiline = renderedText().split("\n");
const firstLine = multiline.findIndex((line) => line.includes("first"));
const thirdLine = multiline.findIndex((line) => line.includes("third"));
assert(firstLine >= 0 && thirdLine - firstLine >= 2, "interior blank prompt lines must remain visible");

editor.setText(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"));
assert.match(renderedText(), /↑\s*\d+/, "long prompts should expose hidden content above the viewport");
for (let index = 0; index < 50; index++) editor.handleInput("\x1b[A");
assert.match(renderedText(), /↓\s*\d+/, "moving upward should expose hidden content below the viewport");
editor.setText("");

await emit("agent_start");
assert.deepEqual(notifications, [], "sole custom editor should not trigger a collision warning");
assert.equal(workingMessage, "Working");
assert.doesNotMatch(renderedText(), /thinking|ready/);
await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
assert.equal(workingMessage, "1 tool · read");
const inputBeforeFailure = renderedText();
await emit("tool_execution_end", {
	type: "tool_execution_end",
	toolCallId: "tool-1",
	toolName: "read",
	result: {},
	isError: true,
});
assert.equal(renderedText(), inputBeforeFailure, "tool failure must not recolor or label the composer");
assert.doesNotMatch(renderedText(), /tool error/);
await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "tool-2", toolName: "read", result: {}, isError: false });
assert.equal(renderedText(), inputBeforeFailure, "successful follow-up needs no editor error reset");
editor.handleInput("x");
assert.doesNotMatch(renderedText(), /tool error/, "typing keeps the composer free of tool error state");
await emit("agent_end", { type: "agent_end", messages: [] });
assert.doesNotMatch(renderedText(), /@ files/, "shortcut hint stays absent after agent_end");
assert.equal(workingMessage, "Working");
await emit("agent_settled", { type: "agent_settled" });
assert.doesNotMatch(renderedText(), /ready/);

editor.setText("!pwd");
assert.match(renderedText(), statePattern("BASH"));
editor.setText("A long prompt with emoji 🧭 and wide text 界 ".repeat(100));
for (let width = 1; width <= 240; width++) {
	for (const line of editor.render(width)) {
		assert(visibleWidth(line) <= width, `long Unicode prompt exceeded width ${width}`);
	}
}

await emit("session_shutdown");

const competingFactory = () => ({ marker: "competing-editor" });
editorFactory = competingFactory;
notifications.length = 0;
await emit("session_start");
assert.notEqual(editorFactory, competingFactory, "last-loaded Irfan Devs editor should remain Pi's normal winner");
assert.equal(notifications.length, 1, "an earlier custom editor should trigger one warning");
assert.equal(notifications[0].level, "warning");
assert.match(notifications[0].message, /Multiple custom editors detected/);
assert.match(notifications[0].message, new RegExp(`Theme ${theme.name} remains selected`));
const laterCompetingFactory = () => ({ marker: "later-competing-editor" });
editorFactory = laterCompetingFactory;
await emit("agent_start");
assert.equal(editorFactory, laterCompetingFactory, "Irfan Devs must not reclaim after a later editor wins");
assert.equal(notifications.length, 2, "A → Irfan Devs → B must warn for both distinct collisions");
assert.match(notifications[1].message, /Irfan Devs editor is inactive/);
await emit("session_shutdown");

notifications.length = 0;
editorFactory = undefined;
await emit("session_start");
editorFactory(tui, editorTheme, new KeybindingsManager());
renderRequests = 0;
editorFactory = competingFactory;
await emit("agent_start");
await new Promise((resolve) => setTimeout(resolve, 180));
assert.equal(editorFactory, competingFactory, "Irfan Devs must not forcefully reclaim Pi's editor slot");
assert.equal(notifications.length, 1, "a later custom editor should trigger one warning");
assert.match(notifications[0].message, /Irfan Devs editor is inactive/);
assert.match(notifications[0].message, /last loaded editor wins/);
assert.equal(renderRequests, 0, "inactive Irfan Devs editor must not animate or request TUI renders");
await emit("session_shutdown");

notifications.length = 0;
editorFactory = undefined;
await emit("session_start");
assert.equal(typeof editorFactory, "function", "Irfan Devs editor should reactivate with its theme");
context.ui.theme = loadThemeFromPath(path.resolve(new URL("../irfan-pi.json", import.meta.url).pathname));
renderRequests = 0;
await emit("agent_start");
assert.equal(editorFactory, undefined, "switching away from Irfan Devs should restore Pi's default editor");
await new Promise((resolve) => setTimeout(resolve, 180));
assert.equal(renderRequests, 0, "inactive theme must not animate or request TUI renders");
await emit("session_start");
assert.equal(editorFactory, undefined, "another theme session must keep Pi's default editor");
assert.deepEqual(notifications, [], "inactive theme must not emit editor collision warnings");
await emit("session_shutdown");

// Exercise real Signature factories too: widths, themed panel backgrounds and cleanup.
{
  const signaturePath = fileURLToPath(new URL("./signature.ts", import.meta.url));
  const signatures = await loadExtensions([signaturePath], process.cwd());
  assert.deepEqual(signatures.errors, []);
  let headerFactory;
  let footerFactory;
  let indicator;
  let message;
  const widgets = new Map();
  const signatureContext = {
    mode: "tui",
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => undefined, getHeader: () => undefined, getEntries: () => [], getLeafId: () => null },
    getContextUsage: () => undefined,
    ui: {
      theme,
      setHeader: (factory) => { headerFactory = factory; },
      setFooter: (factory) => { footerFactory = factory; },
      setWidget(key, value) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
      setWorkingMessage(value) { message = value; },
      setWorkingIndicator: (value) => { indicator = value; },
      setTitle() {},
    },
  };
  // Match deterministic footer behavior even when caller disables its personal footer.
  const footerOverride = process.env.PI_SIGNATURE_COMPACT_FOOTER;
  const animationOverride = process.env.PI_SIGNATURE_ANIMATION;
  delete process.env.PI_SIGNATURE_COMPACT_FOOTER;
  delete process.env.PI_SIGNATURE_ANIMATION;
  try {
    for (const handler of signatures.extensions[0].handlers.get("session_start") ?? []) {
      await handler({ type: "session_start" }, signatureContext);
    }
    assert.equal(typeof headerFactory, "function");
    assert.equal(typeof footerFactory, "function");
    assert.equal(message, "Working");
    assert(indicator.frames.every((frame) => !frame.includes("working")), "native message is not duplicated in frames");
    const header = headerFactory(tui, theme);
    let unsubscribed = false;
    const footer = footerFactory(tui, theme, {
      getGitBranch: () => "feature/theme",
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => new Map([["mcp", "MCP 4/4 servers"]]),
      onBranchChange: () => () => { unsubscribed = true; },
    });
    assert(!widgets.has("pi-irfan-devs-session-status"), "no summary above task widgets");
    assert.match(footer.render(80)[0], /no-model.*ctx \?/);
    assert.equal(footer.render(80).length, 2);
    assert.match(footer.render(120)[0], /feature\/theme.*no-model/);
    assert.doesNotMatch(footer.render(80).join("\n"), /\/pi-ui details/);
    for (let width = 0; width <= 240; width++) {
      for (const line of [...header.render(width), ...footer.render(width)]) {
        assert(visibleWidth(line) <= width, `Signature exceeded width ${width}`);
      }
    }
    assert.match(stripTerminalSequences(header.render(80).join("\n")), /^π · /);
    assert.doesNotMatch(stripTerminalSequences(header.render(80).join("\n")), /pi-irfan-devs/);
    if (process.env.SHOW_IRFAN_DEVS === "1") console.log(header.render(80).join("\n"));
    assert(footer.render(80).every((line) => !line.includes("\x1b[48;")), "footer uses terminal-default background");
    header.invalidate();
    header.dispose();
    // Minimal Pi header has no timer; other palettes retain their own orbit.
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const callbacks = new Map();
    let selectedTheme = theme;
    const liveTheme = new Proxy(theme, {
      get(_target, key) {
        const value = Reflect.get(selectedTheme, key, selectedTheme);
        return typeof value === "function" ? value.bind(selectedTheme) : value;
      },
    });
    globalThis.setInterval = (tick, interval) => {
      const handle = {};
      callbacks.set(handle, { tick, interval });
      return handle;
    };
    globalThis.clearInterval = (handle) => { callbacks.delete(handle); };
    const fakeTui = { ...tui, terminal: { rows: 24 }, previousLines: [] };
    const liveHeader = headerFactory(fakeTui, liveTheme);
    try {
      assert.equal(callbacks.size, 0, "Pi header must not have an idle animation timer");
      for (const rows of [8, 24, 80]) {
        fakeTui.terminal.rows = rows;
        for (const width of [0, 12, 39, 40, 80, 240]) {
          const lines = liveHeader.render(width);
          assert.equal(lines.length, 1, "header remains minimal at every size");
          assert(!lines.some(line => /████|✦/.test(line)));
          assert(lines.every(line => visibleWidth(line) <= width));
        }
      }
      selectedTheme = loadThemeFromPath(fileURLToPath(new URL("../irfan-pi.json", import.meta.url)));
      liveHeader.invalidate();
      assert.equal(callbacks.size, 1);
      assert.equal([...callbacks.values()][0].interval, 140);
      assert(liveHeader.render(80).length > 1, "other palette keeps orbit header");
      const before = renderRequests;
      fakeTui.previousLines = Array(81).fill("");
      [...callbacks.values()][0].tick();
      assert.equal(renderRequests, before, "offscreen orbit must not render");
      delete fakeTui.previousLines;
      [...callbacks.values()][0].tick();
      assert.equal(renderRequests, before, "missing legacy cache must fail closed");
      selectedTheme = theme;
      liveHeader.invalidate();
      assert.equal(callbacks.size, 0, "switching back to Pi cancels orbit timer");
      process.env.PI_SIGNATURE_ANIMATION = "0";
      liveHeader.invalidate();
      assert.equal(callbacks.size, 0);
      delete process.env.PI_SIGNATURE_ANIMATION;
      liveHeader.dispose();
      selectedTheme = loadThemeFromPath(fileURLToPath(new URL("../irfan-pi.json", import.meta.url)));
      liveHeader.invalidate();
      assert.equal(callbacks.size, 0, "disposed header cannot restart");
    } finally {
      liveHeader.dispose();
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
    footer.dispose();
    assert(unsubscribed, "footer releases branch subscription");
    assert(!widgets.has("pi-irfan-devs-session-status"), "footer disposal removes owned summary");
  } finally {
    if (footerOverride === undefined) delete process.env.PI_SIGNATURE_COMPACT_FOOTER;
    else process.env.PI_SIGNATURE_COMPACT_FOOTER = footerOverride;
    if (animationOverride === undefined) delete process.env.PI_SIGNATURE_ANIMATION;
    else process.env.PI_SIGNATURE_ANIMATION = animationOverride;
  }
}

await import("./watermark-smoke.mjs");
console.log("pi-irfan-devs smoke test passed");
