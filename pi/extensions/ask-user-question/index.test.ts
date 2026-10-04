import assert from "node:assert/strict";
import test from "node:test";
import extension, { askViaRpc, presentQuestions, DEMO_QUESTIONS } from "./index.ts";
import { validateQuestions, cancelled } from "./model.ts";

function questions(multiSelect = false) {
	return validateQuestions({ questions: [{ header: "Storage", question: "Which storage?", multiSelect, options: [
		{ label: "Files", description: "Inspect directly." }, { label: "Database", description: "Run queries." },
	] }] });
}

function rpc(select: (title: string, rows: string[], opts?: any) => Promise<string | undefined>, input = async () => "custom") {
	return { mode: "rpc", hasUI: true, ui: { select, input, notify() {}, custom() { throw new Error("RPC must never use custom TUI"); } } } as any;
}

function registered() {
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	extension({ registerTool(tool: any) { tools.push(tool); }, registerCommand(name: string, command: any) { commands.set(name, command); }, on(name: string, handler: any) { events.set(name, handler); } } as any);
	return { tool: tools[0], tools, commands, events };
}

test("registers only local question tool and demo, using host schema and sequential execution", () => {
	const f = registered();
	assert.deepEqual(f.tools.map((tool) => tool.name), ["ask_user_question"]);
	assert.deepEqual([...f.commands.keys()], ["ask-demo"]);
	assert.equal(f.tool.executionMode, "sequential");
	assert.match(f.tool.description, /Never request secrets/);
	assert.match(f.tool.description, /do not treat it as approval/);
});

test("print/JSON/no-UI fail clearly without invented answers or stdout", async (t) => {
	t.mock.method(console, "log", () => { throw new Error("Unexpected stdout"); });
	for (const mode of ["print", "json", "rpc"]) {
		await assert.rejects(presentQuestions(questions(), { mode, hasUI: false } as any), /requires interactive Pi/);
	}
	assert.deepEqual(await presentQuestions(questions(), { mode: "print", hasUI: false } as any, AbortSignal.abort()), cancelled(true));
});

test("RPC single-select includes descriptions, asks review, and submits structured result", async (t) => {
	t.mock.method(console, "log", () => { throw new Error("RPC stdout must stay JSON-only"); });
	let calls = 0;
	const ctx = rpc(async (title, rows) => {
		if (calls++ === 0) { assert.match(title, /Which storage/); assert.match(rows[1], /Database — Run queries/); return rows[1]; }
		assert.match(title, /Review answers\nStorage: Database/);
		return "Submit answers";
	});
	const result = await askViaRpc(questions(), ctx);
	assert.equal(result.status, "answered");
	assert.equal(result.answers[0].answer, "Database");
	assert.equal(calls, 2);
});

test("RPC custom answers preserve text and option previews stay visible in fallback", async () => {
	const q = questions(); q[0].options[0].preview = "const files = true;";
	let calls = 0;
	const result = await askViaRpc(q, rpc(async (title) => {
		if (calls++ === 0) { assert.match(title, /const files = true/); return "Type something."; }
		return "Submit answers";
	}, async () => "Another option"));
	assert.equal(result.answers[0].answer, "Another option");
	assert.equal(result.answers[0].kind, "custom");
});

test("RPC multi-select toggles choices, retains custom detail, and blocks empty Done", async () => {
	let step = 0;
	let warned = 0;
	const ctx = rpc(async (_title, rows) => {
		const actions = ["Done selecting", rows[0], rows[1], "Type something.", "Done selecting", "Submit answers"];
		return actions[step++];
	}, async () => "And a cache");
	ctx.ui.notify = () => { warned++; };
	const result = await askViaRpc(questions(true), ctx);
	assert.deepEqual(result.answers[0].selected, ["Files", "Database"]);
	assert.equal(result.answers[0].customText, "And a cache");
	assert.equal(warned, 1);
});

test("RPC cancellation during question, custom input, or review discards all answers", async () => {
	assert.deepEqual(await askViaRpc(questions(), rpc(async () => undefined)), cancelled());
	assert.deepEqual(await askViaRpc(questions(), rpc(async () => "Type something.", async () => undefined as any)), cancelled());
	let calls = 0;
	assert.deepEqual(await askViaRpc(questions(), rpc(async (_title, rows) => calls++ ? "Cancel questionnaire" : rows[0])), cancelled());
});

test("RPC invalid answers cannot become options or approval; blanks/oversize custom reprompt", async () => {
	await assert.rejects(askViaRpc(questions(), rpc(async () => "not an option")), /unknown option/);
	let calls = 0;
	await assert.rejects(askViaRpc(questions(), rpc(async (_title, rows) => calls++ ? "not a review action" : rows[0])), /unknown review/);
	let inputs = 0;
	let selects = 0;
	let warnings = 0;
	const ctx = rpc(async () => selects++ < 3 ? "Type something." : "Submit answers", async () => [" ", "x".repeat(4001), "Valid"][inputs++]);
	ctx.ui.notify = () => warnings++;
	assert.equal((await askViaRpc(questions(), ctx)).answers[0].answer, "Valid");
	assert.equal(warnings, 2);
});

test("tool validates before opening UI, returns text/details, and reopens after failure", async () => {
	const f = registered();
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async () => cancelled() } } as any;
	await assert.rejects(f.tool.execute("id", { questions: [] }, undefined, undefined, ctx), /1–4/);
	await assert.rejects(f.tool.execute("id", { questions: questions() }, undefined, undefined, { mode: "print", hasUI: false }), /requires interactive/);
	const result = await f.tool.execute("id", { questions: questions() }, undefined, undefined, ctx);
	assert.deepEqual(JSON.parse(result.content[0].text), cancelled());
	assert.deepEqual(result.details, cancelled());
});

test("shutdown aborts RPC and busy guard prevents overlapping dialogs", async () => {
	const f = registered();
	let opened!: () => void;
	const ready = new Promise<void>((resolve) => { opened = resolve; });
	const ctx = rpc(async (_title, _rows, opts) => new Promise((resolve) => {
		opts.signal.addEventListener("abort", () => resolve(undefined), { once: true });
		opened();
	}));
	const pending = f.tool.execute("id", { questions: questions() }, undefined, undefined, ctx);
	await ready;
	await assert.rejects(f.tool.execute("other", { questions: questions() }, undefined, undefined, ctx), /already open/);
	await f.events.get("session_shutdown")();
	assert.deepEqual((await pending).details, cancelled(true));
	const next = await f.tool.execute("next", { questions: questions() }, undefined, undefined, { mode: "tui", hasUI: true, ui: { custom: async () => cancelled() } });
	assert.equal(next.details.status, "cancelled");
});

test("historical answer envelopes render choices, array answers, and unanswered entries", () => {
	const f = registered();
	const theme = { fg(_color: string, value: string) { return value; }, bold(value: string) { return value; } };
	const rendered = f.tool.renderResult({ details: { cancelled: false, answers: [
		{ questionIndex: 0, question: "Framework?", kind: "option", answer: "React" },
		{ questionIndex: 1, question: "Features?", kind: "multi", answer: ["Tests", "Docs"] },
		{ questionIndex: 2, question: "Optional?", answer: null },
	] } }, { expanded: true, isPartial: false }, theme).render(100).join("\n");
	assert.match(rendered, /Answers recorded/);
	assert.match(rendered, /Framework\?: React/);
	assert.match(rendered, /Features\?: Tests; Docs/);
	assert.match(rendered, /Optional\?: \(not answered\)/);
	assert.doesNotMatch(rendered, /Questionnaire undefined/);
	const cancelled = f.tool.renderResult({ details: { cancelled: true, answers: [{ answer: "Must not display" }] } }, { expanded: true, isPartial: false }, theme).render(100).join("\n");
	assert.match(cancelled, /cancelled/);
	assert.doesNotMatch(cancelled, /Must not display/);
	const error = f.tool.renderResult({ details: undefined, content: [{ type: "text", text: "requires interactive Pi" }] }, { expanded: true, isPartial: false }, theme).render(100).join("\n");
	assert.match(error, /requires interactive Pi/);
});

test("RPC custom text strips terminal controls before review and storage", async () => {
	let calls = 0;
	const result = await askViaRpc(questions(), rpc(async (title) => {
		if (calls++ === 0) return "Type something.";
		assert.match(title, /Safe answer/);
		assert.ok(!title.includes("\u001b"));
		return "Submit answers";
	}, async () => "Safe \u001b[2Janswer"));
	assert.equal(result.answers[0].answer, "Safe answer");
});

test("demo exercises previews and multi-select without sending a model prompt", async () => {
	const f = registered();
	let notice = "";
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async () => cancelled(), notify(value: string) { notice = value; } } } as any;
	await f.commands.get("ask-demo").handler("", ctx);
	assert.equal(notice, "Demo cancelled.");
	assert.ok(DEMO_QUESTIONS[0].options.some((option) => option.preview));
	assert.equal(DEMO_QUESTIONS[1].multiSelect, true);
});
