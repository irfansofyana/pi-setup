import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const piRoot = process.env.PI_ROOT;
if (!piRoot) {
	throw new Error("Set PI_ROOT to installed @earendil-works/pi-coding-agent root");
}

const [{ loadExtensions }, { KeybindingsManager }, { loadThemeFromPath }, { visibleWidth }] = await Promise.all([
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

const themePath = path.resolve(new URL("./theme.json", import.meta.url).pathname);
const theme = loadThemeFromPath(themePath);
assert.equal(theme.name, "irfan-sumi");
let editorFactory;
const notifications = [];
const context = {
	mode: "tui",
	ui: {
		theme,
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
assert(editor.render(80)[0].includes(thinkingColor), "frame should use Pi's live thinking-level border color");

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
assert.doesNotMatch(wide.join("\n"), /ASK|┌|┐|└|┘|│/);
assert.match(wide.at(-1), /ready/);
assert(wide.some((line) => line.includes("Ask, build, or investigate")));
assert(wide.some((line) => line.includes("@ files") && line.includes("/ commands")));
assert.equal(wide.length, 2, "24-row terminal should use Sumi editor chrome");
if (process.env.SHOW_SUMI === "1") console.log(wide.join("\n"));
editor.handleInput("x");
assert.equal(editor.getText(), "x", "custom editor should preserve normal input handling");
assert(!editor.render(80).some((line) => line.includes("@ files")), "hint should disappear after first input");
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
assert.match(renderedText(), statePattern("THINKING"));
await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
assert.match(renderedText(), statePattern("TOOLS"));
await emit("tool_execution_end", {
	type: "tool_execution_end",
	toolCallId: "tool-1",
	toolName: "read",
	result: {},
	isError: true,
});
assert.match(renderedText(), statePattern("ERROR"));
editor.handleInput("x");
assert.match(renderedText(), statePattern("THINKING"), "typing should clear a latched tool error");
await emit("agent_end", { type: "agent_end", messages: [] });
assert.match(renderedText(), statePattern("THINKING"), "agent_end should stay busy until automatic continuations settle");
await emit("agent_settled", { type: "agent_settled" });
assert.match(renderedText(), statePattern("READY"));

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
assert.notEqual(editorFactory, competingFactory, "last-loaded Irfan Sumi editor should remain Pi's normal winner");
assert.equal(notifications.length, 1, "an earlier custom editor should trigger one warning");
assert.equal(notifications[0].level, "warning");
assert.match(notifications[0].message, /Multiple custom editors detected/);
assert.match(notifications[0].message, new RegExp(`Theme ${theme.name} remains selected`));
const laterCompetingFactory = () => ({ marker: "later-competing-editor" });
editorFactory = laterCompetingFactory;
await emit("agent_start");
assert.equal(editorFactory, laterCompetingFactory, "Irfan Sumi must not reclaim after a later editor wins");
assert.equal(notifications.length, 2, "A → Sumi → B must warn for both distinct collisions");
assert.match(notifications[1].message, /Irfan Sumi editor is inactive/);
await emit("session_shutdown");

notifications.length = 0;
editorFactory = undefined;
await emit("session_start");
editorFactory(tui, editorTheme, new KeybindingsManager());
renderRequests = 0;
editorFactory = competingFactory;
await emit("agent_start");
await new Promise((resolve) => setTimeout(resolve, 180));
assert.equal(editorFactory, competingFactory, "Irfan Sumi must not forcefully reclaim Pi's editor slot");
assert.equal(notifications.length, 1, "a later custom editor should trigger one warning");
assert.match(notifications[0].message, /Irfan Sumi editor is inactive/);
assert.match(notifications[0].message, /last loaded editor wins/);
assert.equal(renderRequests, 0, "inactive Irfan Sumi editor must not animate or request TUI renders");
await emit("session_shutdown");

notifications.length = 0;
editorFactory = undefined;
await emit("session_start");
assert.equal(typeof editorFactory, "function", "Irfan Sumi editor should reactivate with its theme");
context.ui.theme = loadThemeFromPath(path.resolve(new URL("../irfan-pi.json", import.meta.url).pathname));
renderRequests = 0;
await emit("agent_start");
assert.equal(editorFactory, undefined, "switching away from Irfan Sumi should restore Pi's default editor");
await new Promise((resolve) => setTimeout(resolve, 180));
assert.equal(renderRequests, 0, "inactive theme must not animate or request TUI renders");
await emit("session_start");
assert.equal(editorFactory, undefined, "another theme session must keep Pi's default editor");
assert.deepEqual(notifications, [], "inactive theme must not emit editor collision warnings");
await emit("session_shutdown");

console.log("irfan-sumi smoke test passed");
