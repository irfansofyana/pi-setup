import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MIN_CUSTOM_WIDTH = 12;
const WIDE_LABEL_WIDTH = 28;
const HINT_MIN_WIDTH = 34;
const DECK_LABEL = "ASK";
const PLACEHOLDER = "Ask, build, or investigate…";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANSI_RESET = "\x1b[0m";
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

type Style = (text: string) => string;
type DeckState = "ready" | "thinking" | "tools" | "error" | "bash";

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

export function fitLine(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function formatBinding(key: string): string {
	const parts = key.toLowerCase().split("+");
	const keyPart = parts.pop() ?? key;
	const modifiers = parts
		.map((part) => ({ shift: "⇧", ctrl: "⌃", alt: "⌥", meta: "⌘" })[part] ?? `${part}+`)
		.join("");
	const displayedKey =
		({ enter: "↵", return: "↵", space: "Space", tab: "Tab", escape: "Esc" })[keyPart] ??
		(keyPart.length === 1 ? keyPart.toUpperCase() : keyPart);
	return `${modifiers}${displayedKey}`;
}

export function buildLabeledBorder(
	width: number,
	left: string,
	right: string,
	base: Style,
	leftStyle: Style,
	rightStyle: Style,
	corners: readonly [string, string] = ["┌", "┐"],
): string {
	if (width <= 0) return "";
	if (width === 1) return base("─");
	if (width === 2) return base(`${corners[0]}${corners[1]}`);

	let leftLabel = left.trim();
	let rightLabel = right.trim();
	const available = width - 2;
	const minimumFill = 1;
	const chunkWidth = (label: string) => (label ? visibleWidth(label) + 3 : 0);

	if (chunkWidth(leftLabel) + chunkWidth(rightLabel) + minimumFill > available) leftLabel = "";
	if (chunkWidth(rightLabel) + minimumFill > available) {
		const budget = Math.max(0, available - minimumFill - 3);
		rightLabel = truncateToWidth(rightLabel, budget, "");
	}
	if (chunkWidth(leftLabel) + chunkWidth(rightLabel) + minimumFill > available) leftLabel = "";

	const fillWidth = Math.max(0, available - chunkWidth(leftLabel) - chunkWidth(rightLabel));
	const leftChunk = leftLabel ? leftStyle(`─ ${leftLabel} `) : "";
	const rightChunk = rightLabel ? rightStyle(` ${rightLabel} ─`) : "";
	const plain = `${base(corners[0])}${leftChunk}${base("─".repeat(fillWidth))}${rightChunk}${base(corners[1])}`;
	return fitLine(plain, width);
}

function extractScrollCount(line: string, direction: "↑" | "↓"): string | undefined {
	const match = stripAnsi(line).match(new RegExp(`${direction}\\s+(\\d+)\\s+more`));
	return match?.[1];
}

function addPlaceholder(line: string, theme: Theme): string {
	const cursor = "\x1b[7m \x1b[0m";
	if (!line.includes(cursor)) return line;
	return line.replace(cursor, `${cursor}${theme.fg("dim", ` ${PLACEHOLDER}`)}`);
}

function applyEditorBackground(text: string, width: number, theme: Theme): string {
	const fitted = fitLine(text, width);
	const background = theme.getBgAnsi("customMessageBg");
	const withPersistentBackground = fitted.replaceAll(ANSI_RESET, `${ANSI_RESET}${background}`);
	return `${background}${withPersistentBackground}\x1b[49m`;
}

function targetRestingRows(terminalRows: number): number {
	if (terminalRows >= 18) return 3;
	if (terminalRows >= 11) return 2;
	return 1;
}

function stateLabel(state: DeckState, spinnerFrame: string): string {
	if (state === "thinking") return `${spinnerFrame} THINKING`;
	if (state === "tools") return `${spinnerFrame} TOOLS`;
	return state.toUpperCase();
}

function stateStyle(theme: Theme, state: DeckState, focused: boolean): Style {
	if (state === "error") return (text) => theme.fg("error", text);
	if (state === "bash") return (text) => theme.fg("warning", text);
	return focused ? (text) => theme.fg("accent", text) : (text) => theme.fg("muted", text);
}

export default function commandDeck(pi: ExtensionAPI) {
	let isWorking = false;
	let hadError = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	const activeTools = new Set<string>();

	const requestRender = () => activeTui?.requestRender();
	const stopSpinner = () => {
		if (spinnerTimer) clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};
	const startSpinner = () => {
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
			requestRender();
		}, 120);
	};
	const resetState = () => {
		isWorking = false;
		hadError = false;
		activeTools.clear();
		stopSpinner();
	};

	pi.on("agent_start", () => {
		isWorking = true;
		hadError = false;
		activeTools.clear();
		startSpinner();
		requestRender();
	});

	pi.on("tool_execution_start", (event) => {
		activeTools.add(event.toolCallId);
		requestRender();
	});

	pi.on("tool_execution_end", (event) => {
		activeTools.delete(event.toolCallId);
		hadError ||= event.isError;
		requestRender();
	});

	pi.on("agent_end", () => {
		// An agent run may be followed by retry, compaction, or queued continuation.
		// Keep the working state until Pi reports that the full sequence has settled.
		activeTools.clear();
		requestRender();
	});

	pi.on("agent_settled", () => {
		isWorking = false;
		activeTools.clear();
		stopSpinner();
		requestRender();
	});

	pi.on("session_shutdown", () => {
		resetState();
		activeTui = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		resetState();

		class CommandDeckEditor extends CustomEditor {
			private readonly deckKeybindings: KeybindingsManager;

			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 2 });
				this.deckKeybindings = keybindings;
				activeTui = tui;
			}

				handleInput(data: string): void {
				const before = this.getText();
				super.handleInput(data);
				if (hadError && this.getText() !== before) {
					hadError = false;
					requestRender();
				}
			}

			private renderStockSafe(width: number): string[] {
				if (width <= 0) return [];
				if (width < 7) {
					// Pi's stock wrapper recursively re-wraps double-width graphemes at a
					// one-cell layout width. At pathological widths, prioritize a valid IME
					// cursor over borders or text that cannot fit meaningfully.
					const marker = this.focused ? CURSOR_MARKER : "";
					return [fitLine(`${marker}\x1b[7m \x1b[0m`, width)];
				}
				return super.render(width).map((line) => fitLine(line, width));
			}

			render(width: number): string[] {
				if (width < MIN_CUSTOM_WIDTH || this.isShowingAutocomplete()) return this.renderStockSafe(width);

				const margin = 1;
				const frameWidth = width - margin * 2;
				const innerWidth = frameWidth - 2;
				if (innerWidth < 1) return this.renderStockSafe(width);

				const stock = super.render(innerWidth);
				if (stock.length < 3) return this.renderStockSafe(width);

				const empty = this.getText().length === 0;
				const bashMode = this.getText().trimStart().startsWith("!");
				const state: DeckState = bashMode
					? "bash"
					: hadError
						? "error"
						: activeTools.size > 0
							? "tools"
							: isWorking
								? "thinking"
								: "ready";

				const theme = ctx.ui.theme;
				const baseStyle: Style =
					state === "error"
						? (text) => theme.fg("error", text)
						: state === "bash"
							? (text) => theme.fg("warning", text)
							: this.borderColor;
				const activeStyle = stateStyle(theme, state, this.focused);
				const scrollUp = extractScrollCount(stock[0]!, "↑");
				const scrollDown = extractScrollCount(stock[stock.length - 1]!, "↓");
				const leftLabel = scrollUp ? `↑ ${scrollUp}` : frameWidth >= WIDE_LABEL_WIDTH ? DECK_LABEL : "";
				const rightLabel = stateLabel(state, SPINNER_FRAMES[spinnerIndex]!);

				const content = stock.slice(1, -1);
				if (empty && content[0]) content[0] = addPlaceholder(content[0], theme);

				const minimumRows = targetRestingRows(this.tui.terminal.rows);
				while (content.length < minimumRows) content.push(" ".repeat(innerWidth));

				const hintAllowed = empty && !isWorking && frameWidth >= HINT_MIN_WIDTH && minimumRows >= 2;
				if (hintAllowed) {
					const newlineKey = this.deckKeybindings.getKeys("tui.input.newLine")[0] ?? "shift+enter";
					const hint = `@ files · / commands · ${formatBinding(String(newlineKey))} newline`;
					const padding = " ".repeat(Math.min(this.getPaddingX(), Math.max(0, innerWidth - 1)));
					content[Math.max(content.length - 1, 0)] = `${padding}${theme.fg("dim", hint)}`;
				}

				const indent = " ".repeat(margin);
				const top = buildLabeledBorder(
					frameWidth,
					leftLabel,
					rightLabel,
					baseStyle,
					activeStyle,
					activeStyle,
				);
				const body = content.map(
					(line) =>
						`${indent}${baseStyle("│")}${applyEditorBackground(line, innerWidth, theme)}${baseStyle("│")}${indent}`,
				);
				const bottom = buildLabeledBorder(
					frameWidth,
					scrollDown ? `↓ ${scrollDown}` : "",
					"",
					baseStyle,
					activeStyle,
					activeStyle,
					["└", "┘"],
				);

				return [`${indent}${top}${indent}`, ...body, `${indent}${bottom}${indent}`].map((line) =>
					fitLine(line, width),
				);
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new CommandDeckEditor(tui, theme, keybindings));
	});
}
