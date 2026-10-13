import registerSignature from "./signature.ts";
import { isGenericWorking, workingQuip } from "./working-quips.ts";
import { createFooterProgress, type FooterProgressText } from "./footer-progress.ts";
import { registerCompactCodemode } from "./codemode-ui.ts";
import { markRootEditor, withRootEditorInput } from "./root-editor.ts";
import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MIN_CUSTOM_WIDTH = 12;
const PLACEHOLDER = "Ask, build, or investigate…";
const IRFAN_DEVS_THEME = "pi-irfan-devs";

function supportsTheme(name: string | undefined): boolean {
	return name === IRFAN_DEVS_THEME;
}
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

type Style = (text: string) => string;
type EditorState = "ready" | "bash";

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

export function fitLine(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
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

// Native Pi owns activity lifecycle; the footer presents it, with an editor fallback.
// Tool failures belong to their result cards, not the input's mode or rails.
function renderMinimalEditor(
	width: number,
	content: string[],
	scrollUp: string | undefined,
	scrollDown: string | undefined,
	state: EditorState,
	theme: Theme,
	railStyle: Style,
	focused: boolean,
	separated: boolean,
): string[] {
	const prompt = content.map((line, index) => fitLine(
		` ${index === 0 ? theme.fg(focused ? "accent" : "muted", "›") : " "} ${truncateToWidth(line, Math.max(0, width - 3), "")}`,
		width,
	));
	const scroll = [scrollUp ? `↑${scrollUp}` : "", scrollDown ? `↓${scrollDown}` : ""].filter(Boolean).join(" ");
	const mode = state === "bash" ? theme.fg("warning", "bash") : "";
	const info = [scroll ? theme.fg("dim", scroll) : "", mode].filter(Boolean).join(theme.fg("dim", " · "));
	const bottom = info ? fitLine(`   ${info}`, width) : railStyle("─".repeat(width));
	return [...(separated ? [railStyle("─".repeat(width))] : []), ...prompt, bottom];
}

export default function irfanDevsUi(pi: ExtensionAPI) {
	const progress = createFooterProgress();
	const observeEditor = registerSignature(pi, progress);
	registerCompactCodemode(pi);
	let irfanDevsEditorFactory:
		| ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor)
		| undefined;
	let initialConflictWarned = false;
	let lostOwnershipWarned = false;
	pi.on("agent_start", (_event, ctx) => {
		if (!irfanDevsEditorFactory) return;
		const currentFactory = ctx.ui.getEditorComponent();
		if (!supportsTheme(ctx.ui.theme.name)) {
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
			return;
		}
	});

	pi.on("session_shutdown", () => {
		irfanDevsEditorFactory = undefined;
		initialConflictWarned = false;
		lostOwnershipWarned = false;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const currentFactory = ctx.ui.getEditorComponent();
		if (!supportsTheme(ctx.ui.theme.name)) {
			initialConflictWarned = false;
			lostOwnershipWarned = false;
			if (irfanDevsEditorFactory && currentFactory === irfanDevsEditorFactory) {
				ctx.ui.setEditorComponent(undefined);
			}
			irfanDevsEditorFactory = undefined;
			return;
		}
		initialConflictWarned = false;
		lostOwnershipWarned = false;
		const previousFactory = currentFactory === irfanDevsEditorFactory ? undefined : currentFactory;

		class IrfanDevsEditor extends CustomEditor {
			private mouseLayout: { stockWidth: number; offsetX: number; firstRow: number; rows: number } | undefined;
			private mouseDisabled = false;

			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 2, embedWorkingStatus: true });
				progress.setReader(width => supportsTheme(ctx.ui.theme.name) && ctx.ui.getEditorComponent() === irfanDevsEditorFactory
					? this.readProgress(width) : undefined);
			}

			private bottomStatus: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
			private workStartedAt = 0;

			override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
				if (indicator !== this.bottomStatus) this.workStartedAt = Date.now();
				this.bottomStatus = indicator;
				// Do not pass it to the top border: the footer (or fallback) owns presentation.
			}

			private readProgress(width: number): FooterProgressText | undefined {
				const indicator = this.bottomStatus;
				if (!indicator || indicator.kind === "idle" || width <= 0) return undefined;
				const native = indicator.renderInBorder(Math.max(width, 128));
				const spinner = indicator.renderSpinnerInBorder(width);
				if (supportsTheme(ctx.ui.theme.name) && isGenericWorking(indicator.kind, stripAnsi(native))) {
					const quip = workingQuip(Date.now() - this.workStartedAt);
					const label = `${spinner} ${ctx.ui.theme.fg("muted", quip)}`;
					return { text: label, spinner, isQuip: true };
				}
				return { text: native, spinner, isQuip: false };
			}

			handleInput(data: string): void {
				withRootEditorInput(this, data, () => super.handleInput(data));
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
				if (!supportsTheme(ctx.ui.theme.name) || !progress.isInFooter()) {
					const activity = this.readProgress(width);
					if (activity) lines.push(fitLine(activity.isQuip && visibleWidth(activity.text) > width
						? activity.spinner : activity.text, width));
				}
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

				const innerWidth = width - 3;
				if (innerWidth < 1) return this.renderStockSafe(width);

				const stock = super.render(innerWidth);
				if (stock.length < 3) return this.renderStockSafe(width);

				const empty = this.getText().length === 0;
				const bashMode = this.getText().trimStart().startsWith("!");
				const state: EditorState = bashMode ? "bash" : "ready";
				const theme = ctx.ui.theme;
				const railStyle: Style = (text) => theme.fg(
					state === "bash" ? "warning" : "borderMuted", text,
				);
				const scrollUp = extractScrollCount(stock[0]!, "↑");
				const scrollDown = extractScrollCount(stock[stock.length - 1]!, "↓");
				const content = stock.slice(1, -1);
				if (empty && content[0]) content[0] = addPlaceholder(content[0], theme);

				const separated = this.tui.terminal.rows >= 18;
				this.mouseDisabled = false;
				this.mouseLayout = { stockWidth: innerWidth, offsetX: 3, firstRow: separated ? 1 : 0, rows: content.length };
				return renderMinimalEditor(
					width, content, scrollUp, scrollDown, state, theme,
					railStyle, this.focused, separated,
				);
			}
		}

		irfanDevsEditorFactory = (tui, theme, keybindings) => markRootEditor(new IrfanDevsEditor(tui, theme, keybindings), keybindings);
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
