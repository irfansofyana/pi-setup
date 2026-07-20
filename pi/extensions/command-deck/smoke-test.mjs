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

const themePath = process.env.PI_THEME ?? path.resolve(new URL("../../themes/irfan-pi.json", import.meta.url).pathname);
const theme = loadThemeFromPath(themePath);
let editorFactory;
const context = {
	mode: "tui",
	ui: {
		theme,
		setEditorComponent(factory) {
			editorFactory = factory;
		},
	},
};

await emit("session_start");
assert.equal(typeof editorFactory, "function");

const tui = {
	terminal: { rows: 24 },
	requestRender() {},
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
assert.match(wide[0], /ASK/);
assert.match(wide[0], /READY/);
assert(wide.some((line) => line.includes("Ask, build, or investigate")));
assert(wide.some((line) => line.includes("@ files") && line.includes("/ commands")));
assert.equal(wide.length, 5, "24-row terminal should render three editor rows plus borders");
if (process.env.SHOW_DECK === "1") console.log(wide.join("\n"));
editor.handleInput("x");
assert.equal(editor.getText(), "x", "custom editor should preserve normal input handling");
assert(!editor.render(80).some((line) => line.includes("@ files")), "hint should disappear after first input");
editor.setText("");

tui.terminal.rows = 8;
assert.equal(editor.render(80).length, 3, "short terminal should collapse to one editor row");
tui.terminal.rows = 24;

await emit("agent_start");
let top = editor.render(80)[0].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
assert.match(top, /THINKING/);
await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
top = editor.render(80)[0].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
assert.match(top, /TOOLS/);
await emit("tool_execution_end", {
	type: "tool_execution_end",
	toolCallId: "tool-1",
	toolName: "read",
	result: {},
	isError: true,
});
top = editor.render(80)[0].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
assert.match(top, /ERROR/);
editor.handleInput("x");
top = editor.render(80)[0].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
assert.match(top, /THINKING/, "typing should clear a latched tool error");
await emit("agent_end", { type: "agent_end", messages: [] });
top = editor.render(80)[0].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
assert.match(top, /THINKING/, "agent_end should stay busy until automatic continuations settle");
await emit("agent_settled", { type: "agent_settled" });
top = editor.render(80)[0].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
assert.match(top, /READY/);

editor.setText("!pwd");
top = editor.render(80)[0].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
assert.match(top, /BASH/);
editor.setText("A long prompt with emoji 🧭 and wide text 界 ".repeat(100));
for (let width = 1; width <= 240; width++) {
	for (const line of editor.render(width)) {
		assert(visibleWidth(line) <= width, `long Unicode prompt exceeded width ${width}`);
	}
}

await emit("session_shutdown");
console.log("command-deck smoke test passed");
