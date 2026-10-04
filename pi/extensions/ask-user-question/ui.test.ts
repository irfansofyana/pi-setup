import assert from "node:assert/strict";
import test from "node:test";
import { Key, matchesKey, visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { QuestionComponent } from "./ui.ts";
import { validateQuestions, type QuestionnaireResult } from "./model.ts";

function setup({ multi = false, preview = false, two = false, signal = undefined as AbortSignal | undefined } = {}) {
	const question = { header: "Layout", question: "Which layout 日本語?", multiSelect: multi, options: [
		{ label: "Compact", description: "Compact 日本語 interface.", ...(preview ? { preview: "COMPACT PREVIEW\nconst compact = true;" } : {}) },
		{ label: "Spacious", description: "More room.", ...(preview ? { preview: "SPACIOUS PREVIEW" } : {}) },
	] };
	const questions = validateQuestions({ questions: two ? [question, { ...question, header: "Second", question: "Which second layout?" }] : [question] });
	const results: QuestionnaireResult[] = [];
	let renders = 0;
	const tui = { terminal: { rows: 24 }, requestRender() { renders++; } } as any;
	const theme = { fg(_color: string, text: string) { return text; }, bold(text: string) { return text; } } as any;
	const keys = { matches(data: string, id: string) {
		const key = { "tui.select.up": Key.up, "tui.select.down": Key.down, "tui.select.confirm": Key.enter, "tui.select.cancel": Key.escape }[id];
		return key ? matchesKey(data, key) : false;
	} };
	const component = new QuestionComponent(tui, theme, keys, questions, (result) => results.push(result), signal);
	component.focused = true;
	return { component, results, tui, renders: () => renders };
}

const enter = "\r";
const up = "\u001b[A";
const down = "\u001b[B";
const escape = "\u001b";
const shiftTab = "\u001b[Z";

test("single-select requires final review confirmation; focus is not preselection", () => {
	const f = setup();
	assert.equal(f.component.state.answered(0), false);
	f.component.handleInput("2");
	assert.equal(f.component.state.answered(0), true);
	assert.equal(f.results.length, 0);
	f.component.handleInput(enter);
	assert.equal(f.component.state.review, true);
	assert.equal(f.results.length, 0);
	assert.match(f.component.render(80).join("\n"), /Review answers/);
	f.component.handleInput(enter);
	assert.equal(f.results.length, 1);
	assert.deepEqual(f.results[0].answers[0].selected, ["Spacious"]);
	f.component.handleInput(enter);
	assert.equal(f.results.length, 1);
});

test("multi-select Space/number toggles without moving to next question", () => {
	const f = setup({ multi: true });
	f.component.handleInput(enter);
	assert.match(f.component.state.error, /Choose/);
	f.component.handleInput(" ");
	f.component.handleInput(down);
	f.component.handleInput(" ");
	assert.deepEqual([...f.component.state.draft.selected], [0, 1]);
	f.component.handleInput(enter);
	f.component.handleInput(enter);
	assert.deepEqual(f.results[0].answers[0].selected, ["Compact", "Spacious"]);
});

test("custom entry keeps numeric shortcuts as text and fills pane width with cursor focus", () => {
	const f = setup({ preview: true });
	f.component.handleInput(up);
	assert.equal(f.component.input.focused, true);
	f.component.handleInput("123 日本語");
	assert.equal(f.component.state.draft.customText, "123 日本語");
	assert.equal(f.component.state.draft.selected.size, 0);
	const rendered = f.component.render(120).join("\n");
	assert.ok(rendered.includes(CURSOR_MARKER));
	assert.ok(!rendered.includes(" │ "), "custom editor must not be cramped into preview column");
	f.component.handleInput(enter);
	f.component.handleInput(enter);
	assert.equal(f.results[0].answers[0].answer, "123 日本語");
	assert.equal(f.component.input.focused, false);
});

test("Tab/Shift+Tab revisit questions and preserve custom drafts", () => {
	const f = setup({ two: true });
	f.component.handleInput(up);
	f.component.handleInput("custom first");
	f.component.handleInput("\t");
	assert.equal(f.component.state.current, 1);
	assert.equal(f.component.input.focused, false);
	f.component.handleInput("2");
	f.component.handleInput(shiftTab);
	assert.equal(f.component.state.current, 0);
	assert.equal(f.component.input.getValue(), "custom first");
	assert.equal(f.component.input.focused, true);
	f.component.handleInput(enter);
	f.component.handleInput(enter);
	assert.equal(f.component.state.review, true);
	f.component.handleInput(shiftTab);
	assert.equal(f.component.state.review, false);
	assert.equal(f.component.state.current, 1);
});

test("wide previews appear side by side; narrow previews stack; Unicode fits every width", () => {
	const f = setup({ preview: true });
	for (const width of [1, 10, 20, 40, 80, 88, 120]) {
		const lines = f.component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
		if (width >= 88) assert.ok(lines.some((line) => line.includes(" │ ")));
		if (width === 80) { assert.ok(!lines.some((line) => line.includes(" │ "))); assert.match(lines.join("\n"), /COMPACT PREVIEW/); }
	}
	f.component.handleInput(down);
	assert.match(f.component.render(120).join("\n"), /SPACIOUS PREVIEW/);
	f.component.invalidate();
	assert.ok(f.component.render(40).every((line) => visibleWidth(line) <= 40));
});

test("Escape and Ctrl+C cancel whole questionnaire and discard collected drafts", () => {
	for (const key of [escape, "\u0003"]) {
		const f = setup({ two: true });
		f.component.handleInput("1"); f.component.handleInput(enter);
		f.component.handleInput(key);
		assert.deepEqual(f.results, [{ status: "cancelled", cancelled: true, answers: [] }]);
		f.component.handleInput(enter);
		assert.equal(f.results.length, 1);
	}
});

test("Abort resolves once and disposal removes its listener", () => {
	const controller = new AbortController();
	const f = setup({ signal: controller.signal });
	controller.abort();
	f.component.handleInput(escape);
	assert.deepEqual(f.results, [{ status: "aborted", cancelled: true, answers: [] }]);
	const next = new AbortController();
	const disposed = setup({ signal: next.signal });
	disposed.component.dispose();
	next.abort();
	assert.deepEqual(disposed.results, []);
});

test("long questions/descriptions and review remain scrollable without losing footer", () => {
	const f = setup();
	f.component.state.questions[0].question = "Long question ".repeat(30);
	f.component.state.questions[0].options[0].description = "Full trade-off detail ".repeat(25) + "TAIL_DETAIL";
	let sawDetail = false;
	for (let step = 0; step < 35; step++) {
		const lines = f.component.render(40);
		assert.ok(lines.length <= 24, "component must fit terminal height");
		assert.match(lines.at(-1)!, /Enter next/);
		if (lines.join("\n").includes("TAIL_DETAIL")) sawDetail = true;
		f.component.handleInput("\u001b[1;5B"); // Ctrl+Down
	}
	assert.equal(sawDetail, true);
	f.component.handleInput(up);
	f.component.handleInput("Start " + "review details ".repeat(100) + "TAIL_REVIEW");
	f.component.handleInput(enter);
	let sawReview = false;
	for (let step = 0; step < 80; step++) {
		const lines = f.component.render(40);
		assert.match(lines.at(-1)!, /Enter submit/);
		if (lines.join("\n").includes("TAIL_REVIEW")) sawReview = true;
		f.component.handleInput("\u001b[6~"); // PageDown
	}
	assert.equal(sawReview, true);
});

test("theme ANSI sequences remain styling, not literal escape fragments", () => {
	const f = setup();
	(f.component as any).theme = {
		fg(_color: string, value: string) { return `\u001b[32m${value}\u001b[0m`; },
		bold(value: string) { return `\u001b[1m${value}\u001b[22m`; },
	};
	const lines = f.component.render(40);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.ok(lines.some((line) => line.includes("\u001b[1m")));
	assert.ok(!lines.some((line) => /(?<!\u001b)\[32m/.test(line)));
});

test("bracketed paste strips OSC/CSI controls before native Input renders", () => {
	const f = setup();
	f.component.handleInput(up);
	f.component.handleInput("\u001b[200~safe \u001b]52;c;Y2xpcGJvYXJk\u0007 \u001b[2J text\u001b[201~");
	assert.equal(f.component.input.getValue(), "safe   text");
	assert.equal(f.component.state.draft.customText, "safe   text");
	const screen = f.component.render(80).join("\n");
	assert.ok(!screen.includes("\u001b]52"));
	assert.ok(!screen.includes("\u001b[2J"));
	// Native undo may restore pre-sanitized data; every input event scrubs it again.
	f.component.handleInput("\u001a");
	assert.ok(!f.component.input.getValue().includes("\u001b"));
});

test("chunked pasted controls are text, not cancel or navigation keys", () => {
	const f = setup();
	f.component.handleInput(up);
	f.component.handleInput("\u001b[200~begin");
	f.component.handleInput("\u001b");
	f.component.handleInput("]52;c;payload\u0007end\u001b[201~");
	assert.equal(f.results.length, 0);
	assert.equal(f.component.input.getValue(), "beginend");
	assert.ok(!f.component.render(80).join("\n").includes("payload"));
});

test("focused custom cursor survives narrowing and terminal-height shrink", () => {
	const f = setup();
	f.component.state.questions[0].options[0].description = "Long description ".repeat(25);
	f.component.handleInput(up);
	f.component.handleInput("custom");
	assert.ok(f.component.render(120).join("\n").includes(CURSOR_MARKER));
	f.tui.terminal.rows = 12;
	f.component.invalidate();
	const lines = f.component.render(30);
	assert.ok(lines.length <= 12);
	assert.ok(lines.join("\n").includes(CURSOR_MARKER));
	assert.equal(f.component.input.focused, true);
});

test("already-aborted signal never leaves live questionnaire", () => {
	const f = setup({ signal: AbortSignal.abort() });
	assert.deepEqual(f.results, [{ status: "aborted", cancelled: true, answers: [] }]);
});
