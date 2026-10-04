import { createWatermarkRenderer, WATERMARK_REPLAY_MS } from "./watermark-renderer.ts";

export const WATERMARK_FRAME_MS = 50;
export const WATERMARK_FADE_MS = 400;
export const WATERMARK_IDLE_OPACITY = 0.18;

export interface WatermarkStage {
	row: number;
	col: number;
	width: number;
	height: number;
}

/** Size a layout-owned panel; preserve space for transcript and input dock. */
export function welcomeStage(columns: number, rows: number, fixedRows: number): WatermarkStage | undefined {
	if (![columns, rows, fixedRows].every(Number.isFinite)) return undefined;
	columns = Math.floor(columns);
	rows = Math.floor(rows);
	if (columns < 48 || rows < 28 || fixedRows < 0) return undefined;
	// Two panel margins, native widget separator, and eight transcript rows. Pi owns allocation
	// and clipping alongside other widgets; never inspect their render trees.
	const height = Math.min(16, Math.floor(rows * 0.4), rows - Math.ceil(fixedRows) - 11);
	if (height < 12) return undefined;
	return {
		row: 1,
		col: Math.floor((columns - Math.min(60, columns - 8)) / 2),
		width: Math.min(60, columns - 8),
		height,
	};
}

interface Clock {
	now(): number;
	set(callback: () => void, delay: number): unknown;
	clear(handle: unknown): void;
}

interface MouseEvent {
	type: string;
	button: string;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

interface WatermarkOptions {
	stage(): WatermarkStage | undefined;
	visible(): boolean;
	motion(): boolean;
	paint(text: string, shade: number, opacity: number): string;
	requestRender(): void;
	clock?: Clock;
}

function smooth(value: number): number {
	const t = Math.max(0, Math.min(1, value));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Pure rendering/lifecycle seam: no Pi imports, idle polling, or input ownership. */
export function createWatermark(options: WatermarkOptions) {
	const renderer = createWatermarkRenderer();
	const clock: Clock = options.clock ?? {
		now: () => performance.now(),
		set: (callback, delay) => setTimeout(callback, delay),
		clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	let started: number | undefined;
	let timer: unknown;
	let disposed = false;
	let revision = 0;
	let cachedKey: string | undefined;
	let cachedLines: string[] = [];

	function cancel() {
		if (timer !== undefined) clock.clear(timer);
		timer = undefined;
		started = undefined;
		cachedKey = undefined;
	}

	function isVisible(): boolean {
		const visible = !disposed && options.visible() && options.stage() !== undefined;
		if ((!visible || !options.motion()) && (started !== undefined || timer !== undefined)) cancel();
		return visible;
	}

	function tick() {
		timer = undefined;
		if (!isVisible() || started === undefined) return;
		if (clock.now() - started >= WATERMARK_REPLAY_MS + WATERMARK_FADE_MS) {
			cancel();
		} else {
			timer = clock.set(tick, WATERMARK_FRAME_MS);
		}
		options.requestRender();
	}

	function replay(): boolean {
		if (!isVisible() || !options.motion()) return false;
		cancel();
		started = clock.now();
		timer = clock.set(tick, WATERMARK_FRAME_MS);
		options.requestRender();
		return true;
	}

	const component = {
		render(width: number): string[] {
			if (!isVisible()) return [];
			const stage = options.stage();
			if (!stage) return [];
			const elapsed = started === undefined ? null : Math.max(0, clock.now() - started);
			const poseTime = elapsed === null ? null : Math.min(WATERMARK_REPLAY_MS, elapsed);
			const opacity = elapsed === null ? WATERMARK_IDLE_OPACITY
				: elapsed > WATERMARK_REPLAY_MS
					? 1 + (WATERMARK_IDLE_OPACITY - 1) * smooth((elapsed - WATERMARK_REPLAY_MS) / WATERMARK_FADE_MS)
					: WATERMARK_IDLE_OPACITY + (1 - WATERMARK_IDLE_OPACITY) * smooth(elapsed / WATERMARK_FADE_MS);
			const key = `${Math.min(width, stage.width)}:${stage.height}:${poseTime}:${opacity}:${revision}`;
			if (key !== cachedKey) {
				cachedLines = renderer.render(Math.min(width, stage.width), stage.height, poseTime,
					(text, shade) => options.paint(text, shade, opacity));
				cachedKey = key;
			}
			return cachedLines;
		},
		handleMouse(event: MouseEvent) {
			if (!isVisible() || !options.motion() || event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
			// Consume an ordinary press so a click does not start text selection.
			// Do not capture drag/wheel gestures or transfer keyboard focus.
			if (event.type === "press" || event.type === "release") return { handled: true, focus: false, render: false };
			if (event.type === "click" && replay()) return { handled: true, focus: false, render: true };
			return undefined;
		},
		invalidate() {
			revision++;
			cachedKey = undefined;
			isVisible();
		},
	};

	return {
		component,
		isVisible,
		replay,
		cancel,
		invalidate: component.invalidate,
		dispose() {
			disposed = true;
			cancel();
		},
	};
}
