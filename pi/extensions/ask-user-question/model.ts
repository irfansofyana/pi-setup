import { Type } from "typebox";

export interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface Question {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

export interface Answer {
	questionIndex: number;
	question: string;
	header: string;
	kind: "option" | "custom" | "multi";
	answer: string;
	selected: string[];
	customText: string | null;
}

export interface QuestionnaireResult {
	status: "answered" | "cancelled" | "aborted";
	cancelled: boolean;
	answers: Answer[];
}

export const QuestionParams = Type.Object({
	questions: Type.Array(Type.Object({
		question: Type.String({ minLength: 1, maxLength: 500, description: "Clear, specific question." }),
		header: Type.String({ minLength: 1, maxLength: 16, description: "Short question tab label; maximum 16 characters." }),
		options: Type.Array(Type.Object({
			label: Type.String({ minLength: 1, maxLength: 60, description: "Concise choice, ideally 1–5 words." }),
			description: Type.String({ minLength: 1, maxLength: 500, description: "Meaning or trade-off of this option." }),
			preview: Type.Optional(Type.String({ maxLength: 8000, description: "Optional plain-text/code preview; single-select only." })),
		}, { additionalProperties: false }), { minItems: 2, maxItems: 4 }),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple choices instead of one.", default: false })),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 4 }),
}, { additionalProperties: false });

// Model-provided terminal text must not introduce escape/control sequences.
const unsafeControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
function text(value: unknown, name: string, maximum: number, multiline = false): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || unsafeControls.test(value)
		|| (!multiline && /[\n\r\t]/.test(value))) {
		throw new Error(`${name} must be non-empty text, at most ${maximum} characters, without terminal controls.`);
	}
	return value.trim();
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
	return value as Record<string, unknown>;
}

export function validateQuestions(params: unknown): Question[] {
	const root = object(params, "Parameters");
	if (!Array.isArray(root.questions) || root.questions.length < 1 || root.questions.length > 4) {
		throw new Error("Provide 1–4 questions.");
	}
	const questionTexts = new Set<string>();
	return root.questions.map((value, index) => {
		const raw = object(value, `Question ${index + 1}`);
		const question = text(raw.question, "question", 500, true);
		if (questionTexts.has(question.toLowerCase())) throw new Error("Question texts must be distinct.");
		questionTexts.add(question.toLowerCase());
		const header = text(raw.header, "header", 16);
		if (raw.multiSelect !== undefined && typeof raw.multiSelect !== "boolean") throw new Error("multiSelect must be boolean.");
		if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) throw new Error("Each question needs 2–4 options.");
		const labels = new Set<string>();
		const options = raw.options.map((value) => {
			const option = object(value, "Option");
			const label = text(option.label, "label", 60);
			const normalized = label.toLowerCase().replace(/\.$/, "");
			if (["other", "type something", "next"].includes(normalized)) throw new Error("Do not author Other, Type something., or Next options; custom answers and navigation are automatic.");
			if (labels.has(normalized)) throw new Error("Option labels must be distinct.");
			labels.add(normalized);
			const description = text(option.description, "description", 500, true);
			let preview: string | undefined;
			if (option.preview !== undefined) {
				if (raw.multiSelect) throw new Error("Previews are supported only for single-select questions.");
				if (typeof option.preview !== "string" || option.preview.length > 8000 || unsafeControls.test(option.preview)) throw new Error("preview must be text, at most 8000 characters, without terminal controls.");
				preview = option.preview;
			}
			return { label, description, ...(preview === undefined ? {} : { preview }) };
		});
		return { question, header, options, multiSelect: raw.multiSelect === true };
	});
}

export interface Draft {
	selected: Set<number>;
	customText: string;
	cursor: number;
}

/** Per-invocation state only: no default answer, persistence, or model calls. */
export class Questionnaire {
	readonly questions: Question[];
	readonly drafts: Draft[];
	current = 0;
	review = false;
	error = "";

	constructor(questions: Question[]) {
		this.questions = questions;
		this.drafts = questions.map(() => ({ selected: new Set<number>(), customText: "", cursor: 0 }));
	}

	get question(): Question { return this.questions[this.current]; }
	get draft(): Draft { return this.drafts[this.current]; }

	choose(index: number): void {
		if (index < 0 || index >= this.question.options.length) return;
		this.draft.cursor = index;
		if (this.question.multiSelect) {
			if (this.draft.selected.has(index)) this.draft.selected.delete(index);
			else this.draft.selected.add(index);
		} else {
			this.draft.selected = new Set([index]);
			this.draft.customText = "";
		}
		this.error = "";
	}

	setCustom(value: string): void {
		this.draft.customText = value;
		if (!this.question.multiSelect && value.trim()) this.draft.selected.clear();
		this.error = "";
	}

	answered(index: number): boolean {
		const draft = this.drafts[index];
		return (draft.selected.size > 0 || Boolean(draft.customText.trim())) && draft.customText.length <= 4000;
	}

	navigate(delta: number): void {
		if (this.review) {
			this.review = false;
			this.current = delta < 0 ? this.questions.length - 1 : 0;
		} else this.current = (this.current + delta + this.questions.length) % this.questions.length;
		this.error = "";
	}

	advance(): void {
		if (!this.answered(this.current)) {
			this.error = this.draft.customText.length > 4000 ? "Custom answer is limited to 4000 characters." : "Choose an option or type an answer first.";
			return;
		}
		if (this.current < this.questions.length - 1) this.current += 1;
		else {
			const missing = this.questions.findIndex((_question, index) => !this.answered(index));
			if (missing >= 0) { this.current = missing; this.error = "Answer every question before submitting."; }
			else this.review = true;
		}
	}

	result(): QuestionnaireResult {
		if (!this.questions.every((_question, index) => this.answered(index))) throw new Error("Cannot submit incomplete answers.");
		return {
			status: "answered",
			cancelled: false,
			answers: this.questions.map((question, index) => {
				const selected = [...this.drafts[index].selected].sort((a, b) => a - b).map((option) => question.options[option].label);
				const customText = this.drafts[index].customText.trim() || null;
				return {
					questionIndex: index,
					question: question.question,
					header: question.header,
					kind: selected.length ? (question.multiSelect ? "multi" : "option") : "custom",
					answer: [...selected, customText].filter(Boolean).join("; "),
					selected,
					customText,
				};
			}),
		};
	}
}

export const cancelled = (aborted = false): QuestionnaireResult => ({ status: aborted ? "aborted" : "cancelled", cancelled: true, answers: [] });
