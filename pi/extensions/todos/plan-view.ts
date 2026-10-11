import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PlanStep, SessionPlan } from "./session-plan.ts";

const glyphs = { pending: "○", in_progress: "◐", blocked: "!", completed: "✓" };
/** Keep user/model text on one terminal row; discard terminal control sequences. */
export function singleLine(text: string): string {
	return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}
export function stepLabel(step: PlanStep): string {
	return `${glyphs[step.status]} ${step.id} · ${singleLine(step.title)} · ${step.status.replace("_", " ")}`;
}
export function planLines(plan: SessionPlan, options: { width: number; active: boolean; collapsed?: boolean; hiddenCompleted?: Set<string>; maxRows?: number }): string[] {
	const visible = plan.steps.filter(step => step.status !== "completed" || !options.hiddenCompleted?.has(step.id));
	const limit = Math.max(0, Math.min(6, Math.floor(options.maxRows ?? 4)));
	if (!visible.length || options.width < 1 || !limit) return [];
	const completed = plan.steps.filter(step => step.status === "completed").length;
	const blocked = plan.steps.filter(step => step.status === "blocked").length;
	const current = plan.steps.some(step => step.status === "in_progress");
	const heading = `Todos · ${completed}/${plan.steps.length} completed${blocked ? ` · ${blocked} blocked` : ""}${current && !options.active ? " · agent idle" : ""}`;
	const fit = (line: string) => truncateToWidth(singleLine(line), options.width);
	if (options.collapsed || completed === plan.steps.length || limit === 1) return [fit(heading)];
	const rank = { blocked: 0, in_progress: 1, pending: 2, completed: 3 };
	const sorted = visible.filter(step => step.status !== "completed").sort((a, b) => rank[a.status] - rank[b.status]);
	const rows = [heading];
	let shown = 0;
	for (const step of sorted) {
		if (rows.length >= limit) break;
		rows.push(`${glyphs[step.status]} ${singleLine(step.title)}${step.status === "blocked" ? ` · ${singleLine(step.note)}` : ""}`);
		shown++;
		if (shown === 1 && step.status === "in_progress" && step.note && singleLine(step.note).trim().toLowerCase() !== singleLine(step.title).trim().toLowerCase() && rows.length < limit) rows.push(`  Progress: ${singleLine(step.note)}`);
	}
	return rows.map(fit);
}

/** Read-only details, with all scrolling confined to this focused overlay. */
export class PlanDetail {
	private step: PlanStep;
	private height: () => number;
	private close: () => void;
	private offset = 0;
	private page = 1;
	private total = 0;
	constructor(step: PlanStep, height: () => number, close: () => void) {
		this.step = step;
		this.height = height;
		this.close = close;
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { this.close(); return; }
		if (matchesKey(data, Key.up)) this.offset--;
		if (matchesKey(data, Key.down)) this.offset++;
		if (matchesKey(data, Key.pageUp)) this.offset -= this.page;
		if (matchesKey(data, Key.pageDown)) this.offset += this.page;
		if (matchesKey(data, Key.home)) this.offset = 0;
		if (matchesKey(data, Key.end)) this.offset = this.total;
		this.offset = Math.max(0, Math.min(this.offset, this.total - this.page));
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const height = Math.max(3, Math.floor(this.height() * 0.8));
		this.page = height - 2;
		const text = `${this.step.note ? `Progress: ${this.step.note}\n\n` : ""}${this.step.body || "No description yet."}`;
		const lines = text.split("\n").flatMap(line => wrapTextWithAnsi(singleLine(line), width));
		this.total = lines.length;
		this.offset = Math.max(0, Math.min(this.offset, this.total - this.page));
		return [stepLabel(this.step), ...lines.slice(this.offset, this.offset + this.page), "↑↓ scroll · PgUp/PgDn page · Esc back"].map(line => truncateToWidth(line, width));
	}
	invalidate(): void {}
}
