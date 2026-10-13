import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { footerStyle } from "./footer-style.ts";
import type { FooterProgressText } from "./footer-progress.ts";

export type SessionStatus = {
	model: string;
	thinking?: string;
	contextPercent: number | null | undefined;
	cost: number;
};

/** Essential fields get a budget before optional thinking detail. No token/cache wall. */
export function sessionStatusLine(theme: Theme, status: SessionStatus, width: number): string {
	if (width <= 0) return "";
	const ink = footerStyle(theme);
	const percent = status.contextPercent;
	const known = percent != null && Number.isFinite(percent) && percent >= 0;
	const context = ink.context(known ? `ctx ${percent.toFixed(1)}%` : "ctx ?", known ? percent : undefined);
	const cost = ink.cost(`$${status.cost.toFixed(3)}`);
	const separator = ink.separator(" · ");
	const model = status.model || "no-model";
	let tail = [context, cost];
	let budget = width - visibleWidth(tail.join(separator)) - visibleWidth(separator);
	if (budget < Math.min(12, visibleWidth(model))) {
		tail = [context];
		budget = width - visibleWidth(context) - visibleWidth(separator);
	}
	if (budget < 4) {
		// Even a minimal pane keeps pressure visible; full details remain in /pi-ui.
		return truncateToWidth(context, width, "");
	}
	const thinking = status.thinking !== undefined ? ink.separator(" · ") + ink.model(`thinking ${status.thinking}`) : "";
	const suffixWidth = visibleWidth(thinking);
	const withThinking = suffixWidth > 0 && budget - suffixWidth >= Math.min(12, visibleWidth(model));
	const modelText = ink.model(truncateToWidth(model, budget - (withThinking ? suffixWidth : 0), "…"));
	return truncateToWidth(modelText + (withThinking ? thinking : "") + separator + tail.join(separator), width, "");
}

/** One shared metadata row, with native progress pinned to the far right. */
export function footerSessionLine(
	theme: Theme, status: SessionStatus, project: string,
	progress: FooterProgressText | undefined, width: number,
): string {
	if (width <= 0) return "";
	let right = "";
	if (progress) {
		if (progress.isQuip) {
			// Keep room for model/context and a short project before adding flavor.
			right = width >= visibleWidth(progress.text) + 43 ? progress.text : progress.spinner;
		} else {
			// Factual recovery/tool status outranks metadata in very narrow panes.
			const budget = width < 24 ? width : Math.max(18, Math.floor(width / 2));
			right = truncateToWidth(progress.text, budget, "…");
		}
		right = truncateToWidth(right, width, "");
	}
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(0, width - (rightWidth ? rightWidth + 2 : 0));
	let left: string;
	if (leftWidth >= 40) {
		const path = truncateToWidth(project, Math.min(36, Math.floor(leftWidth / 3)), "…");
		left = path + footerStyle(theme).separator(" · ")
			+ sessionStatusLine(theme, status, leftWidth - visibleWidth(path) - 3);
	} else {
		left = sessionStatusLine(theme, status, leftWidth);
	}
	return rightWidth ? left + " ".repeat(Math.max(0, width - visibleWidth(left) - rightWidth)) + right : left;
}

/** Pack whole, already priority-sorted chips. A +N marker exposes omitted services. */
export function statusChipsLine(chips: readonly string[], theme: Theme, width: number): string | undefined {
	if (width <= 0 || chips.length === 0) return undefined;
	const separator = footerStyle(theme).separator(" · ");
	const joined = chips.join(separator);
	if (visibleWidth(joined) <= width) return joined;
	for (let count = chips.length - 1; count >= 1; count--) {
		const candidate = chips.slice(0, count).join(separator) + separator + theme.fg("dim", `+${chips.length - count}`);
		if (visibleWidth(candidate) <= width) return candidate;
	}
	const overflow = chips.length > 1 ? separator + theme.fg("dim", `+${chips.length - 1}`) : "";
	if (width - visibleWidth(overflow) < 2) return truncateToWidth(chips[0]!, width, "");
	return truncateToWidth(chips[0]!, width - visibleWidth(overflow), "…") + overflow;
}
