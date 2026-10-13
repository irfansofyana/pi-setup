import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { footerSessionLine, sessionStatusLine, statusChipsLine } from "./session-status.ts";

const theme = {
	name: "pi-irfan-devs",
	fg: (_token: string, value: string) => value,
	style: (value: string) => value,
} as Theme;
const status = { model: "gpt-6-astra", thinking: "high", contextPercent: 16.4, cost: 3.958 };

test("model, context and cost precede optional thinking detail", () => {
	const wide = sessionStatusLine(theme, status, 100);
	assert.match(wide, /gpt-6-astra · thinking high/);
	assert.match(wide, /ctx 16.4% · \$3.958/);
	const narrow = sessionStatusLine(theme, status, 40);
	assert.match(narrow, /gpt-6-astra/);
	assert.match(narrow, /ctx 16.4%/);
	assert.doesNotMatch(narrow, /thinking/);
	assert.match(sessionStatusLine(theme, { ...status, thinking: "off" }, 100), /thinking off/);
});

test("unknown context is not shown as zero; narrow panes retain context pressure", () => {
	for (const contextPercent of [null, undefined, NaN]) {
		assert.match(sessionStatusLine(theme, { ...status, contextPercent }, 80), /ctx \?/);
	}
	assert.equal(sessionStatusLine(theme, { ...status, contextPercent: 95 }, 12), "ctx 95.0%");
	assert.doesNotMatch(sessionStatusLine(theme, { ...status, thinking: undefined }, 80), /thinking/);
});

test("summary handles long Unicode models, ANSI, zero and pathological widths", () => {
	const colored = { ...theme, fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[39m` };
	for (let width = 0; width <= 180; width++) {
		for (const model of ["gpt-6-astra", "provider/model-with-a-very-long-name".repeat(8), "模型界🧭".repeat(20)]) {
			const line = sessionStatusLine(colored, { ...status, model }, width);
			assert(visibleWidth(line) <= width, `${width}: ${stripTerminalSequences(line)}`);
		}
	}
});

test("combined footer shares project and model row with right-aligned progress", () => {
	const progress = { text: "• Consulting rubber duck…", spinner: "•", isQuip: true };
	const wide = footerSessionLine(theme, status, "pi-setup (main)", progress, 120);
	assert.match(wide, /^pi-setup \(main\) · gpt-6-astra/);
	assert.match(wide, /ctx 16.4%/);
	assert(wide.endsWith(progress.text));
	assert.equal(visibleWidth(wide), 120);
	const narrow = footerSessionLine(theme, status, "pi-setup (main)", progress, 40);
	assert.match(narrow, /ctx 16.4%/);
	assert(narrow.endsWith("•"));
	assert.doesNotMatch(narrow, /rubber duck/);
	const idle = footerSessionLine(theme, status, "pi-setup (main)", undefined, 120);
	assert.match(idle, /pi-setup \(main\).*gpt-6-astra/);
	assert.doesNotMatch(idle, /ready|rubber duck/);
});

test("combined footer fits ANSI/Unicode and prioritizes factual recovery in tiny panes", () => {
	const colored = { ...theme, fg: (_token: string, value: string) => `\x1b[32m${value}\x1b[39m` };
	const retry = { text: "• Retrying (1/3) in 2s", spinner: "•", isQuip: false };
	assert.match(footerSessionLine(theme, status, "project", retry, 20), /Retrying/);
	for (let width = 0; width <= 180; width++) {
		for (const progress of [undefined, retry, { text: "• Recalculating π…", spinner: "•", isQuip: true }]) {
			const line = footerSessionLine(colored, { ...status, model: "模型🧭".repeat(20) }, "项目🧭 (very-long-branch)".repeat(10), progress, width);
			assert(visibleWidth(line) <= width, `${width}: ${stripTerminalSequences(line)}`);
		}
	}
});

test("chip overflow is counted, preserves first priority chip and fits", () => {
	const chips = ["mem offline", "2 agents running", "hr 70k ↓7%", "caveman FULL"];
	assert.equal(statusChipsLine(chips, theme, 24), "mem offline · +3");
	assert.equal(statusChipsLine([], theme, 80), undefined);
	assert.equal(statusChipsLine(chips, theme, 0), undefined);
	assert.equal(statusChipsLine(chips, theme, 100), chips.join(" · "));
	for (let width = 1; width <= 180; width++) {
		const line = statusChipsLine(chips, theme, width)!;
		assert(visibleWidth(line) <= width);
		assert(line.startsWith(width < 11 ? "mem offline".slice(0, Math.max(1, width - 1)) : "mem offline") || line.includes("…"));
	}
});
