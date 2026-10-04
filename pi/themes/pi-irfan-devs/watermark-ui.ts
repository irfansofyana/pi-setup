import { existsSync } from "node:fs";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, Editor, matchesKey, mixColors, rgbColor, type Color, type Component, type TUI } from "@earendil-works/pi-tui";
import { createWatermark, welcomeStage, type WatermarkStage } from "./watermark.ts";
import { watermarkMetadataOnly, watermarkSessionEligible } from "./watermark-session.ts";

const THEME = "pi-irfan-devs";

// One bounded probe per terminal. A timeout must not accumulate native queries
// carrying old scenes via onLateReply; appearance events use a safe fallback.
const terminalBackgrounds = new WeakMap<object, Promise<Color | undefined>>();
function terminalBackground(tui: TUI): Promise<Color | undefined> {
	let pending = terminalBackgrounds.get(tui.terminal);
	if (!pending) {
		try {
			pending = tui.queryTerminalColors({ timeoutMs: 100 }).then(colors => {
				const bg = colors.background;
				return bg ? rgbColor(bg.r, bg.g, bg.b) : undefined;
			}).catch(() => undefined);
		} catch { pending = Promise.resolve(undefined); }
		terminalBackgrounds.set(tui.terminal, pending);
	}
	return pending;
}

// The forwarding closure lives outside presentation scope. Clearing this cell
// severs scene/context references even if a promise/event keeps the forwarder.
function detachableSink<T>(callback: (value: T) => void) {
	const cell: { callback?: (value: T) => void } = { callback };
	return {
		listener(value: T) { cell.callback?.(value); },
		clear() { cell.callback = undefined; },
	};
}

type EditorView = Component & { focused?: boolean; isShowingAutocomplete?(): boolean };
const WIDGET_KEY = "pi-irfan-devs-welcome";

/** Public, layout-owned welcome widget. Startup text never determines visibility. */
export function createWatermarkPresentation(ctx: ExtensionContext, reason: string) {
	const file = ctx.sessionManager.getSessionFile();
	const persisted = file ? existsSync(file) : false;
	let retired = watermarkSessionEligible({
		reason, persisted, parentSession: ctx.sessionManager.getHeader()?.parentSession,
		entries: ctx.sessionManager.getEntries(),
	}) ? undefined : `session is not fresh/empty (reason=${reason}, persisted=${persisted}); use /new`;
	let disposed = false;
	let installed = false;
	let tui: TUI | undefined;
	let theme: Theme | undefined;
	let editor: EditorView | undefined;
	let footerView: Component | undefined;
	let editorRows = 5;
	let footerRows = 3;
	let renderWidth: number | undefined;
	let drawnStage: WatermarkStage | undefined;
	let scene: ReturnType<typeof createWatermark> | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeColors: (() => void) | undefined;
	let detachColors: (() => void) | undefined;
	let background: Color | undefined;
	let paletteKey: string | undefined;
	const palette = new Map<number, readonly [string, string]>();
	let lastLeaf: string | null | undefined;
	let checkedEntries = false;
	let mountId = 0;

	// Pi exposes dock containers publicly, but not per-widget allocation priority.
	// Measure only standard cached Text/Spacer leaves. Opaque custom widgets
	// yield decoration rather than risking clipping meaningful sibling content.
	function dockRows(width: number): number | undefined {
		if (!tui || tui.children.length !== 7) return undefined;
		const above = tui.children[3];
		if (!(above instanceof Container) || !above.children.includes(panel)) return undefined;
		const seen = new Set<object>();
		function measure(node: Component): number | undefined {
			if (node === panel) return 0;
			if (node === editor) return editorRows;
			if (node === footerView) return footerRows;
			if (seen.has(node) || seen.size >= 128) return undefined;
			seen.add(node);
			if (node instanceof Text || node instanceof Editor || node.constructor === Spacer) return node.render(width).length;
			if (node.constructor !== Container) return undefined;
			let rows = 0;
			for (const child of (node as Container).children) {
				const count = measure(child);
				if (count === undefined) return undefined;
				rows += count;
			}
			return rows;
		}
		// Leading native above-widget separator is budgeted by welcomeStage.
		const leading = above.children[0];
		if (leading?.constructor !== Spacer || leading.render(width).length !== 1) return undefined;
		let rows = 0;
		for (const index of [1, 2, 3, 4, 5, 6]) {
			const node = tui.children[index];
			if (!(node instanceof Container)) return undefined;
			for (const child of node.children) {
				if (index === 3 && child === leading) continue;
				const count = measure(child);
				if (count === undefined) return undefined;
				rows += count;
			}
		}
		return rows;
	}

	function stage(width = renderWidth ?? tui?.terminal.columns ?? 0) {
		const extra = dockRows(width);
		return tui && extra !== undefined ? welcomeStage(width, tui.terminal.rows, extra) : undefined;
	}

	function hiddenReason(): string | undefined {
		if (disposed) return "session replaced or shut down";
		if (retired) return retired;
		if (!installed) return "welcome widget is not mounted; run /reload";
		if (!tui || !theme) return "renderer not ready";
		if (theme.name !== THEME) return `theme is ${theme.name}; select ${THEME}`;
		if (tui.mode !== "fullscreen") return "regular mode; switch to fullscreen";
		try {
			const leaf = ctx.sessionManager.getLeafId();
			if (!checkedEntries || leaf !== lastLeaf) {
				checkedEntries = true;
				lastLeaf = leaf;
				if (!watermarkMetadataOnly(ctx.sessionManager.getEntries())) {
					retired = "session contains conversation/activity; use /new";
					return retired;
				}
			}
			if (!ctx.isIdle()) return "agent is busy";
			if (ctx.hasPendingMessages()) return "messages are queued";
			if (ctx.ui.getEditorText().length > 0) return "editor draft is not empty";
			const focus = tui.getFocusedComponent();
			const input = tui.children[4];
			if (!focus || (focus !== editor && !(focus instanceof Editor)) || !(input instanceof Container)
				|| !input.children.includes(focus)) return "editor is not focused (dialog/selector active)";
			if ((focus as EditorView).isShowingAutocomplete?.()) return "autocomplete is open";
			if (dockRows(renderWidth ?? tui.terminal.columns) === undefined) return "custom/unknown dock widget or layout; welcome yields to protect it";
			if (!stage()) return "terminal/input dock too small (needs 48 columns and room for widgets plus transcript)";
			return undefined;
		} catch { return "UI/session state unavailable"; }
	}

	function destroyScene() {
		mountId++;
		scene?.dispose();
		scene = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		detachColors?.();
		detachColors = undefined;
		unsubscribeColors?.();
		unsubscribeColors = undefined;
		drawnStage = undefined;
		background = undefined;
		palette.clear();
		paletteKey = undefined;
	}

	function paint(text: string, shade: number, opacity: number): string {
		if (!theme) return text;
		const bg = background ?? (theme.appearance === "light" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0));
		const alpha = Math.round(opacity * 255) / 255;
		const key = JSON.stringify([bg, theme.colors.accent, alpha]);
		if (key !== paletteKey) { paletteKey = key; palette.clear(); }
		const level = Math.max(0, Math.min(15, Math.round(shade * 15)));
		let style = palette.get(level);
		if (!style) {
			const color = mixColors(bg, theme.colors.accent, alpha * (0.28 + 0.72 * level / 15), "srgb");
			const styled = theme.style("\x01", { fg: color });
			const parts = styled.split("\x01");
			style = [parts[0] ?? "", parts[1] ?? ""];
			palette.set(level, style);
		}
		return style[0] + text + style[1];
	}

	function syncScene() {
		if (disposed || retired || !installed || !tui || tui.mode !== "fullscreen" || theme?.name !== THEME) {
			if (scene) destroyScene();
			return;
		}
		if (scene) { scene.isVisible(); if (retired) destroyScene(); return; }
		const activeTui = tui; // Pi's dynamically forwarded reference survives mode swaps.
		const id = ++mountId;
		scene = createWatermark({
			stage, visible: () => hiddenReason() === undefined,
			motion: () => process.env.PI_SIGNATURE_ANIMATION !== "0",
			paint, requestRender: () => { if (!disposed) activeTui.requestRender(); },
		});
		const currentScene = scene;
		unsubscribe = ctx.ui.onTerminalInput(data => {
			if (data.includes("\x1b[200~") || matchesKey(data, "ctrl+v")) {
				retired = "paste/image gesture observed; use /new";
				currentScene.cancel();
				activeTui.requestRender();
			}
			return undefined; // Never replace/consume keyboard input or host onChange.
		});
		let colorEpoch = 0;
		const backgroundSink = detachableSink<Color | undefined>(color => {
			if (disposed || id !== mountId || colorEpoch !== 0 || !color) return;
			background = color;
			currentScene.invalidate();
			activeTui.requestRender();
		});
		const schemeSink = detachableSink<"dark" | "light">(scheme => {
			if (disposed || id !== mountId) return;
			colorEpoch++;
			const channel = scheme === "light" ? 255 : 0;
			background = rgbColor(channel, channel, channel);
			currentScene.invalidate();
			activeTui.requestRender();
		});
		detachColors = () => { backgroundSink.clear(); schemeSink.clear(); };
		unsubscribeColors = activeTui.onTerminalColorSchemeChange(schemeSink.listener);
		void terminalBackground(activeTui).then(backgroundSink.listener);
	}

	const panel = {
		render(width: number): string[] {
			renderWidth = width;
			syncScene();
			drawnStage = hiddenReason() === undefined ? stage(width) : undefined;
			if (!drawnStage || !scene) return [];
			const prefix = " ".repeat(drawnStage.col);
			return ["", ...scene.component.render(drawnStage.width).map(line => prefix + line), ""];
		},
		handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
			if (!drawnStage || event.x < drawnStage.col || event.x >= drawnStage.col + drawnStage.width
				|| event.y < drawnStage.row || event.y >= drawnStage.row + drawnStage.height) return undefined;
			return scene?.component.handleMouse(event);
		},
		invalidate() { syncScene(); scene?.invalidate(); },
		// Native removal/reset disposes widget. Header remains lifecycle anchor
		// for mode/theme returns; only session disposal closes presentation.
		dispose() { installed = false; destroyScene(); },
	};

	return {
		install() {
			if (disposed || installed) return;
			installed = true;
			ctx.ui.setWidget(WIDGET_KEY, (activeTui, activeTheme) => {
				tui = activeTui;
				theme = activeTheme;
				syncScene();
				return panel;
			}, { placement: "aboveEditor" });
		},
		header(_node: Component, _rows: number, activeTui: TUI, activeTheme: Theme) {
			tui = activeTui; theme = activeTheme; syncScene();
		},
		footer(node: Component, rows: number) {
			const changed = footerView !== node || footerRows !== rows;
			footerView = node; footerRows = rows;
			if (changed) { scene?.invalidate(); tui?.requestRender(); }
		},
		editor(node: EditorView, rows: number) {
			editor = node;
			if (editorRows !== rows) { editorRows = rows; scene?.invalidate(); tui?.requestRender(); }
		},
		replay() { syncScene(); return scene?.replay() ?? false; },
		status() {
			const hidden = hiddenReason();
			const size = hidden ? undefined : stage();
			const motion = process.env.PI_SIGNATURE_ANIMATION !== "0";
			return hidden ? `Welcome panel hidden: ${hidden}.`
				: `Welcome panel visible (${size!.width}×${size!.height}); ${motion ? "click or /pi-watermark to replay" : "static: PI_SIGNATURE_ANIMATION=0"}.`;
		},
		invalidate() { panel.invalidate(); },
		retire(cause = "session used; start /new") { retired = cause; destroyScene(); },
		dispose() {
			if (disposed) return;
			disposed = true;
			destroyScene();
			if (installed) {
				installed = false;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
		},
	};
}
