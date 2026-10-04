import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { QuestionParams, Questionnaire, cancelled, validateQuestions, type Question, type QuestionnaireResult } from "./model.ts";
import { QuestionComponent } from "./ui.ts";

export const DEMO_QUESTIONS: Question[] = [{
	header: "Layout",
	question: "Which layout should the demo use?",
	options: [
		{ label: "Compact (Recommended)", description: "Short option list with a focused preview.", preview: "┌─ Options ─┐\n│ Compact   │\n│ Spacious  │\n└───────────┘" },
		{ label: "Spacious", description: "More room between choices and details.", preview: "┌─ Options ───────────┐\n│ Compact            │\n│                    │\n│ Spacious           │\n└────────────────────┘" },
	],
}, {
	header: "Features",
	question: "Which features should the demo include?",
	multiSelect: true,
	options: [
		{ label: "Search", description: "Find tasks quickly." },
		{ label: "Tags", description: "Group related work." },
		{ label: "Notes", description: "Keep context beside each task." },
	],
}];

/** RPC clients get supported native dialogs, never custom terminal components. */
export async function askViaRpc(questions: Question[], ctx: ExtensionContext, signal?: AbortSignal): Promise<QuestionnaireResult> {
	const state = new Questionnaire(questions);
	for (let index = 0; index < questions.length; index++) {
		state.current = index;
		const question = state.question;
		while (true) {
			if (signal?.aborted) return cancelled(true);
			const rows = question.options.map((option, optionIndex) => `${optionIndex + 1}. ${state.draft.selected.has(optionIndex) ? "[x] " : ""}${option.label} — ${option.description}`);
			const customRow = "Type something.";
			const doneRow = "Done selecting";
			rows.push(customRow);
			if (question.multiSelect) rows.push(doneRow);
			const previews = question.options.filter((option) => option.preview).map((option) => `${option.label} preview:\n${option.preview}`).join("\n\n");
			const title = `[${question.header}] ${question.question}${question.multiSelect ? "\nSelect options repeatedly, then Done selecting." : ""}${previews ? `\n\n${previews}` : ""}`;
			const selection = await ctx.ui.select(title, rows, { signal });
			if (signal?.aborted) return cancelled(true);
			if (selection === undefined) return cancelled();
			if (selection === customRow) {
				const value = await ctx.ui.input(question.question, "Your answer (maximum 4000 characters)", { signal });
				if (signal?.aborted) return cancelled(true);
				if (value === undefined) return cancelled();
				const clean = displayText(value);
				if (!clean.trim() || value.length > 4000) { ctx.ui.notify("Enter a non-empty answer up to 4000 characters.", "warning"); continue; }
				state.setCustom(clean);
				if (!question.multiSelect) break;
			} else if (selection === doneRow && question.multiSelect) {
				if (state.answered(index)) break;
				ctx.ui.notify("Select at least one option or type an answer.", "warning");
			} else {
				const option = rows.indexOf(selection);
				if (option < 0 || option >= question.options.length) throw new Error("RPC client returned an unknown option.");
				state.choose(option);
				if (!question.multiSelect) break;
			}
		}
	}
	const result = state.result();
	const summary = result.answers.map((answer) => `${answer.header}: ${answer.answer}`).join("\n");
	const confirm = await ctx.ui.select(`Review answers\n${displayText(summary)}`,  ["Submit answers", "Cancel questionnaire"], { signal });
	if (signal?.aborted) return cancelled(true);
	if (confirm === undefined || confirm === "Cancel questionnaire") return cancelled();
	if (confirm !== "Submit answers") throw new Error("RPC client returned an unknown review action.");
	return result;
}

export async function presentQuestions(questions: Question[], ctx: ExtensionContext, signal?: AbortSignal): Promise<QuestionnaireResult> {
	if (signal?.aborted) return cancelled(true);
	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error("ask_user_question requires interactive Pi or an RPC client supporting extension UI dialogs. Ask in chat instead; no answer was collected.");
	}
	if (ctx.mode === "rpc") return askViaRpc(questions, ctx, signal);
	const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, keys, done) => new QuestionComponent(tui, theme, keys, questions, done, signal));
	return signal?.aborted ? cancelled(true) : result ?? cancelled();
}

const displayText = (value: string) => stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

export default function askUserQuestionExtension(pi: ExtensionAPI) {
	let busy = false;
	let active: AbortController | undefined;
	async function ask(questions: Question[], ctx: ExtensionContext, signal?: AbortSignal): Promise<QuestionnaireResult> {
		if (busy) throw new Error("Another questionnaire is already open. Group questions into one call or wait for it to finish.");
		busy = true;
		active = new AbortController();
		const signals = [signal, ctx.signal, active.signal].filter((value): value is AbortSignal => value !== undefined);
		const combined = AbortSignal.any(signals);
		try { return await presentQuestions(questions, ctx, combined); }
		finally { busy = false; active = undefined; }
	}

	pi.on("session_shutdown", async () => { active?.abort(); });
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask user",
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		description: "Ask 1–4 structured questions when user preferences or requirements block progress. Each question needs a header (<=16 characters) and 2–4 distinct options with concise labels and descriptions. Users always have an automatic Type something. answer and can cancel; do not author Other, Type something., or Next options. Set multiSelect for multiple valid choices. Optional plain-text/code previews are single-select only. Put a recommended option first and suffix its label with (Recommended). Users review answers before submission. Never request secrets. Cancellation/abort returns no answers: do not treat it as approval or guess an answer. Requires interactive Pi or RPC UI dialogs.",
		parameters: QuestionParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const questions = validateQuestions(params);
			const result = await ask(questions, ctx, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			return new Text(theme.fg("toolTitle", theme.bold("Ask user ")) + theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Waiting for your answers…"), 0, 0);
			const details = result.details as Record<string, unknown> | undefined;
			if (!details || typeof details !== "object") {
				const block = result.content.find((part) => part.type === "text");
				return new Text(theme.fg("error", displayText(block?.type === "text" ? block.text : "Questionnaire result unavailable")), 0, 0);
			}
			// Resumed sessions can contain the older { answers, cancelled } envelope.
			const legacy = details.status === undefined && typeof details.cancelled === "boolean";
			const status = details.cancelled === true ? "cancelled" : legacy ? "answered" : details.status;
			if (status === "cancelled" || status === "aborted") return new Text(theme.fg("warning", `Questionnaire ${details.status === "aborted" ? "aborted" : status}; no answers submitted.`), 0, 0);
			if (status !== "answered" || !Array.isArray(details.answers)) return new Text("Questionnaire result unavailable", 0, 0);
			const lines = details.answers.map((entry, index) => {
				if (!entry || typeof entry !== "object") return `Question ${index + 1}: (not answered)`;
				const answer = entry as Record<string, unknown>;
				const label = typeof answer.header === "string" ? answer.header : typeof answer.question === "string" ? answer.question : `Question ${index + 1}`;
				const raw = typeof answer.answer === "string" ? answer.answer : Array.isArray(answer.answer)
					? answer.answer.filter((value): value is string => typeof value === "string").join("; ")
					: Array.isArray(answer.selected) ? answer.selected.filter((value): value is string => typeof value === "string").join("; ") : "";
				const value = raw || "(not answered)";
				return `${label}: ${expanded ? value : value.slice(0, 120) + (value.length > 120 ? "…" : "")}`;
			});
			if (!lines.length) return new Text(theme.fg("muted", "No answers recorded."), 0, 0);
			return new Text(theme.fg("success", legacy ? "✓ Answers recorded\n" : "✓ Answers submitted\n") + displayText(lines.join("\n")), 0, 0);
		},
	});
	pi.registerCommand("ask-demo", {
		description: "Try local question UI: previews, multi-select, custom answers, and review (no model call)",
		handler: async (_args, ctx) => {
			try {
				const result = await ask(DEMO_QUESTIONS, ctx);
				ctx.ui.notify(result.status === "answered" ? "Demo complete. No model prompt or state file was created." : `Demo ${result.status}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
