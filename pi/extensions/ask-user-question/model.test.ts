import assert from "node:assert/strict";
import test from "node:test";
import { Questionnaire, cancelled, validateQuestions, QuestionParams } from "./model.ts";

export const params = () => ({ questions: [{ question: "Which storage?", header: "Storage", options: [
	{ label: "Files (Recommended)", description: "Easy to inspect." },
	{ label: "Database", description: "Flexible queries." },
] }] });

test("input contract keeps grouped questions, hard limits, and optional previews", () => {
	const questions = validateQuestions(params());
	assert.equal(questions[0].multiSelect, false);
	assert.equal(QuestionParams.properties.questions.minItems, 1);
	assert.equal(QuestionParams.properties.questions.maxItems, 4);
	assert.equal(QuestionParams.properties.questions.items.properties.header.maxLength, 16);
	assert.equal(QuestionParams.properties.questions.items.properties.options.maxItems, 4);
	const input: any = params();
	input.questions[0].options[0].preview = "```ts\nconst x = 1;\n```";
	assert.match(validateQuestions(input)[0].options[0].preview!, /const x/);
});

test("validates counts, text, lengths, type, duplicates, and reserved labels before UI", () => {
	for (const value of [null, [], {}, { questions: [] }, { questions: Array(5).fill(params().questions[0]) }]) assert.throws(() => validateQuestions(value));
	const changes: Array<(p: any) => void> = [
		(p) => { p.questions[0].options = [p.questions[0].options[0]]; },
		(p) => { p.questions[0].options = Array(5).fill(p.questions[0].options[0]); },
		(p) => { p.questions[0].question = " "; },
		(p) => { p.questions[0].header = "x".repeat(17); },
		(p) => { p.questions[0].options[0].label = "x".repeat(61); },
		(p) => { p.questions[0].options[0].description = ""; },
		(p) => { p.questions[0].multiSelect = "false"; },
		(p) => { p.questions[0].options[1].label = p.questions[0].options[0].label; },
		(p) => { p.questions.push(p.questions[0]); },
		(p) => { p.questions[0].options[0].preview = "x".repeat(8001); },
		(p) => { p.questions[0].options[0].preview = 1; },
		(p) => { p.questions[0].options[0].label = "bad\nlabel"; },
		(p) => { p.questions[0].options[0].preview = "\u001b]52;c;payload\u0007"; },
	];
	for (const change of changes) { const input = params(); change(input); assert.throws(() => validateQuestions(input)); }
	for (const label of ["Other", "other.", "Type something.", "Next"]) {
		const input = params(); input.questions[0].options[0].label = label;
		assert.throws(() => validateQuestions(input), /Do not author/);
	}
});

test("multi-select previews are rejected, not silently discarded", () => {
	const input: any = params();
	input.questions[0].multiSelect = true;
	input.questions[0].options[0].preview = "Example";
	assert.throws(() => validateQuestions(input), /single-select/);
});

test("no preselection; review requires explicit answer and final submission", () => {
	const state = new Questionnaire(validateQuestions(params()));
	assert.equal(state.answered(0), false);
	assert.throws(() => state.result(), /incomplete/);
	state.advance();
	assert.match(state.error, /Choose/);
	state.choose(1);
	assert.equal(state.review, false);
	state.advance();
	assert.equal(state.review, true);
	assert.deepEqual(state.result(), { status: "answered", cancelled: false, answers: [{
		questionIndex: 0, question: "Which storage?", header: "Storage", kind: "option", answer: "Database", selected: ["Database"], customText: null,
	}] });
});

test("single-select custom answer replaces selection; option choice replaces custom text", () => {
	const state = new Questionnaire(validateQuestions(params()));
	state.choose(0);
	state.setCustom("  Another engine  ");
	assert.deepEqual(state.result().answers[0].selected, []);
	assert.equal(state.result().answers[0].answer, "Another engine");
	assert.equal(state.result().answers[0].kind, "custom");
	state.choose(1);
	assert.equal(state.result().answers[0].customText, null);
});

test("multi-select toggles in canonical order and permits additional custom details", () => {
	const input: any = params(); input.questions[0].multiSelect = true;
	const state = new Questionnaire(validateQuestions(input));
	state.choose(1); state.choose(0);
	state.setCustom("Plus a cache");
	assert.deepEqual(state.result().answers[0].selected, ["Files (Recommended)", "Database"]);
	assert.equal(state.result().answers[0].customText, "Plus a cache");
	state.choose(0);
	assert.deepEqual(state.result().answers[0].selected, ["Database"]);
});

test("navigation preserves drafts, finds missing answers, and caps custom text", () => {
	const input = params(); input.questions.push({ ...input.questions[0], question: "Which cache?", header: "Cache" });
	const state = new Questionnaire(validateQuestions(input));
	state.navigate(1); state.choose(1); state.advance();
	assert.equal(state.current, 0);
	assert.match(state.error, /every question/);
	state.setCustom("x".repeat(4001)); state.advance();
	assert.match(state.error, /4000/);
	state.setCustom("custom"); state.advance(); state.advance();
	assert.equal(state.review, true);
	state.navigate(-1);
	assert.equal(state.current, 1);
	assert.equal(state.review, false);
	assert.equal(state.drafts[0].customText, "custom");
});

test("cancellation and abort never leak partial drafts as answers", () => {
	assert.deepEqual(cancelled(), { status: "cancelled", cancelled: true, answers: [] });
	assert.deepEqual(cancelled(true), { status: "aborted", cancelled: true, answers: [] });
});
