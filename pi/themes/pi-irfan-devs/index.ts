import registerSignature from "./signature.ts";
import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MIN_CUSTOM_WIDTH = 12;
const HINT_MIN_WIDTH = 34;
const PLACEHOLDER = "Ask, build, or investigate…";
const IRFAN_DEVS_THEME = "pi-irfan-devs";

function supportsTheme(name: string | undefined): boolean {
	return name === IRFAN_DEVS_THEME;
}
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

type Style = (text: string) => string;
type EditorState = "ready" | "thinking" | "tools" | "error" | "bash";

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

function extractScrollCount(line: string, direction: "↑" | "↓"): string | undefined {
	const match = stripAnsi(line).match(new RegExp(`${direction}\\s+(\\d+)\\s+more`));
	return match?.[1];
}

function addPlaceholder(line: string, theme: Theme): string {
	const cursor = "\x1b[7m \x1b[0m";
	if (!line.includes(cursor)) return line;
	return line.replace(cursor, `${cursor}${theme.fg("dim", ` ${PLACEHOLDER}`)}`);
}

function targetRestingRows(terminalRows: number): number {
	if (terminalRows >= 18) return 3;
	if (terminalRows >= 11) return 2;
	return 1;
}

function stateLabel(state: EditorState, spinnerFrame: string): string {
	if (state === "thinking") return `${spinnerFrame} THINKING`;
	if (state === "tools") return `${spinnerFrame} TOOLS`;
	return state.toUpperCase();
}

function stateStyle(theme: Theme, state: EditorState, focused: boolean): Style {
	if (state === "error") return (text) => theme.fg("error", text);
	if (state === "bash") return (text) => theme.fg("warning", text);
	return focused ? (text) => theme.fg("accent", text) : (text) => theme.fg("muted", text);
}

function renderMinimalEditor(
	width: number,
	content: string[],
	hint: string | undefined,
	scrollUp: string | undefined,
	scrollDown: string | undefined,
	state: EditorState,
	spinnerFrame: string,
	theme: Theme,
	railStyle: Style,
	activeStyle: Style,
): string[] {
	const promptWidth = Math.max(0, width - 4);
	const prompt = content.map((line, index) => {
		const marker = index === 0 ? railStyle("›") : " ";
		return fitLine(` ${marker} ${truncateToWidth(line, promptWidth, "")}`, width);
	});
	const stateText = activeStyle(stateLabel(state, spinnerFrame).toLowerCase());
	const scrollText = [scrollUp ? `↑${scrollUp}` : "", scrollDown ? `↓${scrollDown}` : ""].filter(Boolean).join(" ");
	if (hint) {
		const left = `   ${scrollText ? `${scrollText} · ` : ""}${hint}`;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(stateText) - 1);
		return [...prompt, fitLine(`${left}${" ".repeat(gap)}${stateText} `, width)];
	}
	const statusPrefix = scrollText ? ` ${theme.fg("dim", scrollText)} ` : " ";
	const ruleWidth = Math.max(1, width - visibleWidth(statusPrefix) - visibleWidth(stateText) - 2);
	return [...prompt, fitLine(`${statusPrefix}${theme.fg("borderMuted", "─".repeat(ruleWidth))} ${stateText} `, width)];
}

// Rounded cell borders replace CSS radii; short terminals keep the compact rail.
function renderFramedEditor(lines: string[], width: number, railStyle: Style): string[] {
	const body = lines.slice(0, -1).map((line) =>
		`${railStyle("│")}${fitLine(line, width - 2)}${railStyle("│")}`,
	);
	return [
		railStyle(`╭${"─".repeat(width - 2)}╮`),
		...body,
		railStyle(`╰${"─".repeat(width - 2)}╯`),
		lines[lines.length - 1]!,
	];
}

export default function irfanDevsUi(pi: ExtensionAPI) {
	const observeEditor = registerSignature(pi);
	let isWorking = false;
	let hadError = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let irfanDevsEditorFactory:
		| ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor)
		| undefined;
	let initialConflictWarned = false;
	let lostOwnershipWarned = false;
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

	pi.on("agent_start", (_event, ctx) => {
		if (!irfanDevsEditorFactory) return;
		const currentFactory = ctx.ui.getEditorComponent();
		if (!supportsTheme(ctx.ui.theme.name)) {
			resetState();
			activeTui = undefined;
			if (currentFactory === irfanDevsEditorFactory) ctx.ui.setEditorComponent(undefined);
			irfanDevsEditorFactory = undefined;
			return;
		}
		if (currentFactory !== irfanDevsEditorFactory) {
			if (!lostOwnershipWarned) {
				ctx.ui.notify(
					`Irfan Devs editor is inactive because another extension replaced Pi's editor. Theme ${ctx.ui.theme.name} remains selected; Pi can show only one custom editor, so the last loaded editor wins.`,
					"warning",
				);
				lostOwnershipWarned = true;
			}
			resetState();
			activeTui = undefined;
			return;
		}
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
		irfanDevsEditorFactory = undefined;
		initialConflictWarned = false;
		lostOwnershipWarned = false;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const currentFactory = ctx.ui.getEditorComponent();
		if (!supportsTheme(ctx.ui.theme.name)) {
			resetState();
			activeTui = undefined;
			initialConflictWarned = false;
			lostOwnershipWarned = false;
			if (irfanDevsEditorFactory && currentFactory === irfanDevsEditorFactory) {
				ctx.ui.setEditorComponent(undefined);
			}
			irfanDevsEditorFactory = undefined;
			return;
		}
		resetState();
		initialConflictWarned = false;
		lostOwnershipWarned = false;
		const previousFactory = currentFactory === irfanDevsEditorFactory ? undefined : currentFactory;

		class IrfanDevsEditor extends CustomEditor {
			private readonly irfanDevsKeybindings: KeybindingsManager;
			private mouseLayout: { stockWidth: number; offsetX: number; firstRow: number; rows: number } | undefined;
			private mouseDisabled = false;

			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 2 });
				this.irfanDevsKeybindings = keybindings;
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

			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (this.mouseDisabled) return undefined;
				const layout = this.mouseLayout;
				if (!layout) return super.handleMouse(event);
				// Keep press/drag/release available for fullscreen text selection.
				if (event.type !== "click" || event.button !== "left") return undefined;
				if (event.y < layout.firstRow || event.y >= layout.firstRow + layout.rows) {
					return { handled: true, focus: true };
				}
				return super.handleMouse({
					...event,
					x: event.x - layout.offsetX,
					y: event.y - layout.firstRow + 1,
					width: layout.stockWidth,
				});
			}

			private renderStockSafe(width: number): string[] {
				this.mouseLayout = undefined;
				this.mouseDisabled = width < 7;
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
				const lines = this.renderTheme(width);
				observeEditor(this, lines.length);
				return lines;
			}

			private renderTheme(width: number): string[] {
				if (
					!supportsTheme(ctx.ui.theme.name) ||
					width < MIN_CUSTOM_WIDTH ||
					this.isShowingAutocomplete()
				) {
					return this.renderStockSafe(width);
				}

				const frameWidth = width - 2;
				const framed = ctx.ui.theme.name === IRFAN_DEVS_THEME && frameWidth >= HINT_MIN_WIDTH && this.tui.terminal.rows >= 18;
				const innerWidth = frameWidth - (framed ? 4 : 2);
				if (innerWidth < 1) return this.renderStockSafe(width);

				const stock = super.render(innerWidth);
				if (stock.length < 3) return this.renderStockSafe(width);

				const empty = this.getText().length === 0;
				const bashMode = this.getText().trimStart().startsWith("!");
				const state: EditorState = bashMode
					? "bash"
					: hadError
						? "error"
						: activeTools.size > 0
							? "tools"
							: isWorking
								? "thinking"
								: "ready";

				const theme = ctx.ui.theme;
				const railStyle: Style =
					state === "error"
						? (text) => theme.fg("error", text)
						: state === "bash"
							? (text) => theme.fg("warning", text)
							: this.borderColor;
				const activeStyle = stateStyle(theme, state, this.focused);
				const scrollUp = extractScrollCount(stock[0]!, "↑");
				const scrollDown = extractScrollCount(stock[stock.length - 1]!, "↓");
				const content = stock.slice(1, -1);
				if (empty && content[0]) content[0] = addPlaceholder(content[0], theme);

				const minimumRows = targetRestingRows(this.tui.terminal.rows);
				const hintAllowed = empty && !isWorking && frameWidth >= HINT_MIN_WIDTH && minimumRows >= 2;
				let hint: string | undefined;
				if (hintAllowed) {
					const newlineKey = this.irfanDevsKeybindings.getKeys("tui.input.newLine")[0] ?? "shift+enter";
					hint = `@ files · / commands · ${formatBinding(String(newlineKey))} newline`;
				}

				this.mouseDisabled = false;
				this.mouseLayout = { stockWidth: innerWidth, offsetX: framed ? 4 : 3, firstRow: framed ? 1 : 0, rows: content.length };
				const lines = renderMinimalEditor(
					framed ? width - 2 : width,
					content,
					hint ? theme.fg("dim", hint) : undefined,
					scrollUp,
					scrollDown,
					state,
					SPINNER_FRAMES[spinnerIndex]!,
					theme,
					railStyle,
					activeStyle,
				);
				return framed ? renderFramedEditor(lines, width, railStyle) : lines;
			}
		}

		irfanDevsEditorFactory = (tui, theme, keybindings) => new IrfanDevsEditor(tui, theme, keybindings);
		if (previousFactory && !initialConflictWarned) {
			ctx.ui.notify(
				`Multiple custom editors detected. Irfan Devs editor is loading after another editor; Pi can show only one, so the last loaded editor wins. Theme ${ctx.ui.theme.name} remains selected.`,
				"warning",
			);
			initialConflictWarned = true;
		}
		ctx.ui.setEditorComponent(irfanDevsEditorFactory);
	});
}
