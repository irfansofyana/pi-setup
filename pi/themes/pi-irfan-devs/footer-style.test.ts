import assert from "node:assert/strict";
import test from "node:test";
import { colorToHex, styleText, stripTerminalSequences, type TextStyle, type TerminalColorMode } from "@earendil-works/pi-tui";
import type { ThemeStyle } from "@earendil-works/pi-coding-agent";
import { footerStyle, cavemanLevel } from "./footer-style.ts";

const theme = (name = "pi-irfan-devs") => ({
	name,
	fg: (color: string, text: string) => `[${color}]${text}`,
	style: (text: string, options: ThemeStyle) => {
		// Pi interprets strings as theme tokens, not raw CSS/hex colors.
		if (typeof options.fg === "string") throw new Error(`Unknown theme color: ${options.fg}`);
		return `[${options.fg ? colorToHex(options.fg) : "default"}]${text}`;
	},
});

test("footer separators and healthy statuses render concrete colors in both terminal modes", () => {
	for (const mode of ["truecolor", "256color"] satisfies TerminalColorMode[]) {
		const palette = {
			...theme(),
			style(text: string, options: ThemeStyle) {
				// Match the host's token/concrete-color boundary, then use real Pi color rendering.
				if (typeof options.fg === "string") throw new Error(`Unknown theme color: ${options.fg}`);
				return styleText(text, options as TextStyle, mode);
			},
		};
		const ink = footerStyle(palette);
		const line = ink.separator("• ") + ink.healthy("MCP 3/3") + ink.separator(" · ") + ink.healthy("mem ok");
		assert.equal(stripTerminalSequences(line), "• MCP 3/3 · mem ok");
		assert.match(line, mode === "truecolor" ? /\x1b\[38;2;89;102;95m/ : /\x1b\[38;5;\d+m/);
		if (mode === "truecolor") assert.match(line, /\x1b\[38;2;143;189;156m/);
	}
});

test("cost and model outrank routine labels without changing global theme", () => {
	const palette = theme();
	const ink = footerStyle(palette);
	assert.equal(ink.cost("$6.984"), "[text]$6.984");
	assert.equal(ink.model("gpt-6-astra"), "[muted]gpt-6-astra");
	assert.equal(ink.label("mem"), "[dim]mem");
	assert.equal(ink.mode("FULL"), "[muted]FULL");
	assert.equal(palette.fg("success", "ok"), "[success]ok");
});

test("healthy services and separators use footer-local quiet colors", () => {
	const ink = footerStyle(theme());
	assert.equal(ink.healthy("ok"), "[#8fbd9c]ok");
	assert.equal(ink.separator(" · "), "[#59665f] · ");
	assert.equal(ink.active("working"), "[accent]working");
});

test("context preserves existing warning thresholds and unknown usage", () => {
	const ink = footerStyle(theme());
	for (const value of [undefined, null, 0, 27.4, 70]) assert.equal(ink.context("ctx", value), "[muted]ctx");
	for (const value of [70.1, 90]) assert.equal(ink.context("ctx", value), "[warning]ctx");
	assert.equal(ink.context("ctx", 90.1), "[error]ctx");
});

test("other palettes keep their original semantic colors", () => {
	for (const name of ["dark", "irfan-gruvbox", "other-blue-theme"]) {
		const ink = footerStyle(theme(name));
		assert.equal(ink.cost("cost"), "[dim]cost");
		assert.equal(ink.model("model"), "[dim]model");
		assert.equal(ink.label("mem"), "[accent]mem");
		assert.equal(ink.healthy("ok"), "[success]ok");
		assert.equal(ink.mode("FULL"), "[warning]FULL");
		assert.equal(ink.active("working"), "[warning]working");
		assert.equal(ink.separator(" · "), "[dim] · ");
		assert.equal(ink.context("ctx", 20), "[dim]ctx");
	}
});

test("Caveman status recognizes real rock-prefixed payload without duplicating label", () => {
	for (const text of ["🪨 caveman FULL", "🪨️ caveman FULL", "caveman FULL", "caveman level: FULL"]) {
		assert.equal(cavemanLevel(text), "FULL");
	}
	assert.equal(cavemanLevel("caveman LITE"), "LITE");
	assert.equal(cavemanLevel("other caveman FULL"), undefined);
	assert.equal(cavemanLevel(""), undefined);
});
