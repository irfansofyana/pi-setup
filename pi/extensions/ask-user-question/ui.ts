import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { Questionnaire, cancelled, type Question, type QuestionnaireResult } from "./model.ts";

type Keybindings = { matches(data: string, id: string): boolean };
const safeDisplay = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** One component per questionnaire; injected TUI owns focus and rendering. */
export class QuestionComponent implements Focusable {
	readonly state: Questionnaire;
	readonly input = new Input();
	private tui: TUI;
	private theme: Theme;
	private keys: Keybindings;
	private done: (result: QuestionnaireResult) => void;
	private signal?: AbortSignal;
	private finished = false;
	private _focused = false;
	private previewOffset = 0;
	private contentOffset = 0;
	private focusedLine = 0;
	private ensureFocus = false;
	private previousWidth = 0;
	private previousRows = 0;
	private pasting = false;
	private pasteTail = "";
	private abort = () => this.finish(cancelled(true));

	constructor(tui: TUI, theme: Theme, keys: Keybindings, questions: Question[], done: (result: QuestionnaireResult) => void, signal?: AbortSignal) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.signal = signal;
		this.state = new Questionnaire(questions);
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.syncFocus(); }

	private syncFocus(): void {
		this.input.focused = this._focused && !this.state.review && this.state.draft.cursor === this.state.question.options.length;
	}

	private finish(result: QuestionnaireResult): void {
		if (this.finished) return;
		this.finished = true;
		this.dispose();
		this.done(result);
	}

	dispose(): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.input.focused = false;
	}

	private changed(questionChanged = false, followFocus = true): void {
		if (questionChanged) { this.input.setValue(this.state.draft.customText); this.contentOffset = 0; }
		this.ensureFocus = followFocus;
		this.syncFocus();
		this.tui.requestRender();
	}

	private customInput(data: string): void {
		this.input.handleInput(data);
		// Native Input accepts control sequences in bracketed paste; scrub before any render.
		const clean = safeDisplay(this.input.getValue());
		if (clean !== this.input.getValue()) this.input.setValue(clean);
		this.state.setCustom(clean);
		this.changed();
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (!this.state.review && this.state.draft.cursor === this.state.question.options.length
			&& (this.pasting || data.includes("\u001b[200~"))) {
			const markers = this.pasteTail + data;
			this.pasting = !markers.includes("\u001b[201~");
			this.pasteTail = this.pasting ? markers.slice(-5) : "";
			this.customInput(data);
			return;
		}
		if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(cancelled());
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.state.navigate(matchesKey(data, Key.shift("tab")) ? -1 : 1);
			this.previewOffset = 0;
			this.changed(true);
			return;
		}
		if (matchesKey(data, Key.ctrl("up")) || matchesKey(data, Key.ctrl("down"))) {
			this.contentOffset = Math.max(0, this.contentOffset + (matchesKey(data, Key.ctrl("up")) ? -5 : 5));
			this.changed(false, false);
			return;
		}
		if (this.state.review) {
			if (this.keys.matches(data, "tui.select.confirm")) this.finish(this.state.result());
			else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
				this.contentOffset = Math.max(0, this.contentOffset + (matchesKey(data, Key.pageUp) ? -5 : 5));
				this.changed(false, false);
			}
			return;
		}
		const count = this.state.question.options.length;
		if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) {
			const delta = this.keys.matches(data, "tui.select.up") ? -1 : 1;
			this.state.draft.cursor = (this.state.draft.cursor + delta + count + 1) % (count + 1);
			this.previewOffset = 0;
			this.changed();
			return;
		}
		if (this.keys.matches(data, "tui.select.confirm")) {
			if (this.state.draft.cursor === count) this.state.setCustom(this.input.getValue());
			else if (!this.state.question.multiSelect) { this.state.choose(this.state.draft.cursor); this.input.setValue(""); }
			this.state.advance();
			this.previewOffset = 0;
			this.changed(true);
			return;
		}
		// Text entry gets full width even when this question has previews.
		if (this.state.draft.cursor === count) {
			this.customInput(data);
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const delta = matchesKey(data, Key.pageUp) ? -5 : 5;
			if (this.state.question.options.some((option) => option.preview)) this.previewOffset = Math.max(0, this.previewOffset + delta);
			else this.contentOffset = Math.max(0, this.contentOffset + delta);
			this.changed(false, false);
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.state.choose(this.state.draft.cursor);
			this.input.setValue(this.state.draft.customText);
			this.changed();
			return;
		}
		for (let index = 0; index < count; index++) {
			if (matchesKey(data, String(index + 1) as "1" | "2" | "3" | "4")) {
				this.state.choose(index);
				this.input.setValue(this.state.draft.customText);
				this.previewOffset = 0;
				this.changed();
				return;
			}
		}
	}

	invalidate(): void { this.input.invalidate(); }

	private wrapped(text: string, width: number, maximum = Number.POSITIVE_INFINITY): string[] {
		const lines = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		if (lines.length <= maximum) return lines;
		return [...lines.slice(0, Math.max(0, maximum - 1)), truncateToWidth("…", width)];
	}

	private optionLines(width: number): string[] {
		const { question, draft } = this.state;
		const lines: string[] = [];
		for (const [index, option] of question.options.entries()) {
			const focused = index === draft.cursor;
			const selected = draft.selected.has(index);
			const mark = question.multiSelect ? (selected ? "[x]" : "[ ]") : (selected ? "●" : "○");
			const prefix = `${focused ? "›" : " "} ${index + 1}. ${mark} `;
			if (focused) this.focusedLine = lines.length;
			lines.push(...this.wrapped(this.theme.fg(focused ? "accent" : "text", prefix + option.label), width));
			lines.push(...this.wrapped(option.description, Math.max(1, width - 2)).map((line) => truncateToWidth("  " + this.theme.fg("muted", line), width)));
			lines.push("");
		}
		const custom = draft.cursor === question.options.length;
		if (custom) this.focusedLine = lines.length;
		lines.push(this.theme.fg(custom ? "accent" : "text", truncateToWidth(`${custom ? "›" : " "} Type something.${draft.customText.trim() ? " ✓" : ""}`, width)));
		return lines;
	}

	private previewLines(width: number): string[] {
		const option = this.state.question.options[this.state.draft.cursor];
		const all = this.wrapped(option?.preview || "No preview for this option.", width);
		const height = Math.max(3, Math.min(12, (this.tui.terminal.rows || 24) - 10));
		this.previewOffset = Math.min(this.previewOffset, Math.max(0, all.length - height));
		const lines = all.slice(this.previewOffset, this.previewOffset + height);
		if (all.length > height) lines.push(this.theme.fg("dim", truncateToWidth(`PgUp/PgDn · ${this.previewOffset + 1}–${Math.min(all.length, this.previewOffset + height)}/${all.length}`, width)));
		return [this.theme.fg("accent", "Preview"), ...lines];
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const rows = this.tui.terminal.rows || 24;
		const resized = this.previousWidth !== 0 && (width !== this.previousWidth || rows !== this.previousRows);
		this.previousWidth = width;
		this.previousRows = rows;
		const { state, theme } = this;
		const lines: string[] = [theme.fg("accent", truncateToWidth(state.review ? "Review answers" : `Question ${state.current + 1}/${state.questions.length}`, width))];
		const tabs = state.questions.map((question, index) => `${state.answered(index) ? "✓" : "○"} ${question.header}`);
		lines.push(truncateToWidth(tabs.join("  ·  "), width), "");
		if (state.review) {
			for (const answer of state.result().answers) {
				lines.push(...this.wrapped(theme.fg("accent", `${answer.header}: ${answer.question}`), width));
				lines.push(...this.wrapped(safeDisplay([...answer.selected, answer.customText].filter(Boolean).join("; ")), width), "");
			}
			lines.push(theme.fg("dim", truncateToWidth("Enter submit · Shift+Tab edit · PgUp/PgDn scroll · Esc cancel", width)));
		} else {
			lines.push(...this.wrapped(theme.bold(state.question.question), width), "");
			const optionStart = lines.length;
			const custom = state.draft.cursor === state.question.options.length;
			const hasPreview = state.question.options.some((option) => Boolean(option.preview));
			if (hasPreview && !custom && width >= 88) {
				const leftWidth = Math.min(42, Math.floor(width * 0.43));
				const rightWidth = width - leftWidth - 3;
				const left = this.optionLines(leftWidth);
				const right = this.previewLines(rightWidth);
				for (let index = 0; index < Math.max(left.length, right.length); index++) {
					const a = truncateToWidth(left[index] || "", leftWidth);
					lines.push(a + " ".repeat(Math.max(0, leftWidth - visibleWidth(a))) + theme.fg("dim", " │ ") + (right[index] || ""));
				}
			} else {
				lines.push(...this.optionLines(width));
				if (custom) lines.push(...this.input.render(width));
				else if (hasPreview) lines.push("", ...this.previewLines(width));
			}
			this.focusedLine += optionStart;
			if (custom) this.focusedLine += 1;
			if (state.error) lines.push(theme.fg("error", truncateToWidth(state.error, width)));
			const hint = custom ? "Type answer · Enter next · Tab switch · Esc cancel" : state.question.multiSelect
				? "↑↓ move · Space toggle · Enter next · Tab switch · Esc cancel"
				: "↑↓ or 1–4 choose · Enter next · Tab switch · Esc cancel";
			lines.push("", theme.fg("dim", truncateToWidth(hint + " · Ctrl↑↓ scroll", width)));
		}
		// Keep progress/footer visible and scroll long questions, descriptions, and review.
		const header = lines.slice(0, 3);
		const footerCount = state.error && !state.review ? 3 : 1;
		const footer = lines.slice(-footerCount);
		const body = lines.slice(3, -footerCount);
		const height = Math.max(3, (this.tui.terminal.rows || 24) - header.length - footer.length - 2);
		if ((this.ensureFocus || resized) && !state.review) {
			const focused = Math.max(0, this.focusedLine - header.length);
			if (focused < this.contentOffset) this.contentOffset = focused;
			else if (focused >= this.contentOffset + height) this.contentOffset = focused - height + 1;
		}
		this.ensureFocus = false;
		this.contentOffset = Math.min(this.contentOffset, Math.max(0, body.length - height));
		const viewport = body.slice(this.contentOffset, this.contentOffset + height);
		if (body.length > height) viewport.push(theme.fg("dim", truncateToWidth(`Scroll ${this.contentOffset + 1}–${Math.min(body.length, this.contentOffset + height)}/${body.length} · Ctrl↑↓`, width)));
		return [...header, ...viewport, ...footer].map((line) => truncateToWidth(line, width));
	}
}
