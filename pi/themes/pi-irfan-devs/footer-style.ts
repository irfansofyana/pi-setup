import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";

const DEVS_THEME = "pi-irfan-devs";
// Footer-local colors: do not alter global success/accent or agent badges.
// Theme.style treats strings as token names; literal colors must be concrete Color objects.
const HEALTHY = parseColor("#8fbd9c");
const SEPARATOR = parseColor("#59665f");

export function footerStyle(theme: Pick<Theme, "name" | "fg" | "style">) {
	const devs = theme.name === DEVS_THEME;
	return {
		cost: (text: string) => theme.fg(devs ? "text" : "dim", text),
		model: (text: string) => theme.fg(devs ? "muted" : "dim", text),
		label: (text: string) => theme.fg(devs ? "dim" : "accent", text),
		healthy: (text: string) => devs ? theme.style(text, { fg: HEALTHY }) : theme.fg("success", text),
		mode: (text: string) => theme.fg(devs ? "muted" : "warning", text),
		active: (text: string) => theme.fg(devs ? "accent" : "warning", text),
		separator: (text: string) => devs ? theme.style(text, { fg: SEPARATOR }) : theme.fg("dim", text),
		context: (text: string, percent: number | null | undefined) => theme.fg(
			percent != null && percent > 90 ? "error"
				: percent != null && percent > 70 ? "warning" : devs ? "muted" : "dim", text,
		),
	};
}

/** Normalize our Caveman extension's plain status, including its optional rock icon. */
export function cavemanLevel(plain: string): string | undefined {
	return plain.match(/^(?:🪨\uFE0F?\s+)?caveman(?:\s+level:)?\s+(.+)$/i)?.[1]?.trim();
}
