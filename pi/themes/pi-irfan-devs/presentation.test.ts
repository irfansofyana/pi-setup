import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const palette = JSON.parse(read("./theme.json"));
const color = (role: string): string => palette.vars[palette.colors[role]] ?? palette.colors[role];
function luminance(hex: string): number {
	const channels = hex.slice(1).match(/../g)!.map(value => {
		const channel = parseInt(value, 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(fg: string, bg: string): number {
	const light = luminance(fg);
	const dark = luminance(bg);
	return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

test("original green-led identity, distinct search/selection, quiet surfaces", () => {
	assert.equal(palette.name, "pi-irfan-devs");
	assert.equal(color("accent"), "#78df9b");
	assert.equal(palette.vars.terminal, "#111613");
	assert.notEqual(color("selectedBg"), color("searchMatchBg"));
	assert.notEqual(color("selectedBg"), color("userMessageBg"));
	assert.equal(color("mdHeading"), color("text"));
	assert.notEqual(color("syntaxString"), palette.vars.gold);
	for (const role of ["text", "toolOutput", "userMessageText", "searchMatchText", "success", "error"]) {
		assert.match(color(role), /^#[0-9a-f]{6}$/i);
	}
});

test("body/search/error colors contrast on package-owned surfaces", () => {
	for (const bg of ["toolPendingBg", "toolSuccessBg", "toolErrorBg", "userMessageBg", "selectedBg"]) {
		assert(contrast(color("text"), color(bg)) >= 4.5, bg);
	}
	assert(contrast(color("searchMatchText"), color("searchMatchBg")) >= 4.5);
	assert(contrast(color("error"), color("toolErrorBg")) >= 4.5);
	// Terminal-default canvas contrast still needs visual review on actual terminals.
});

test("composer uses native activity, subtle rails and preserves native input ownership", () => {
	const editor = read("./index.ts");
	assert.match(editor, /embedWorkingStatus: true/);
	assert.match(editor, /override setWorkingStatusIndicator/);
	assert.match(editor, /!progress\.isInFooter\(\)/);
	assert.match(editor, /progress\.setReader/);
	assert.match(editor, /ctx\.ui\.getEditorComponent\(\) === irfanDevsEditorFactory/);
	assert.doesNotMatch(editor, /super\.setWorkingStatusIndicator/);
	assert.doesNotMatch(editor, /setInterval|SPINNER_FRAMES|renderFramedEditor|THINKING|READY/);
	assert.match(editor, /withRootEditorInput\(this, data, \(\) => super\.handleInput\(data\)\)/);
	assert.match(editor, /markRootEditor\(new IrfanDevsEditor/);
	assert.doesNotMatch(editor, /hadError|"tool error"|state === "error"/);
	assert.doesNotMatch(editor, /HINT_MIN_WIDTH|@ files · \/ commands|formatBinding/);
});

test("session summary belongs to measured footer, not task widgets", () => {
	const signature = read("./signature.ts");
	const welcome = read("./watermark-ui.ts");
	assert.doesNotMatch(signature, /STATUS_WIDGET_KEY|placement: "aboveEditor"|presentation\.sessionStatus/);
	assert.match(signature, /\? \[footerSessionLine\(theme,/);
	assert.match(signature, /progress\.read\(width\)/);
	assert.match(signature, /if \(devs\) lines\.push\(statuses \?\? ""\)/);
	assert.match(signature, /const releaseProgress = progress\.mountFooter\(/);
	assert.match(signature, /releaseProgress\(\)/);
	assert.match(signature, /presentation\.footer\(component, rendered\.length\)/);
	assert.match(welcome, /status\(\)/);
	assert.doesNotMatch(welcome, /statusView|statusRows|sessionStatus\(/);
	assert.match(signature, /registerCommand\("pi-ui"/);
	assert.doesNotMatch(signature, /\/pi-ui details/);
	assert.doesNotMatch(signature, /setTheme\(|writeFile|setSettings/);
});
