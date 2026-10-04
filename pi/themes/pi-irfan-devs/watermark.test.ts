import assert from "node:assert/strict";
import test from "node:test";
import { createWatermark, welcomeStage, WATERMARK_FADE_MS, WATERMARK_IDLE_OPACITY } from "./watermark.ts";
import { WATERMARK_REPLAY_MS } from "./watermark-renderer.ts";

function fixture() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, () => void>();
	let visible = true;
	let motion = true;
	let renders = 0;
	let stage = welcomeStage(80, 40, 8);
	const opacity: number[] = [];
	const watermark = createWatermark({
		stage: () => stage,
		visible: () => visible,
		motion: () => motion,
		paint: (text, _shade, alpha) => { opacity.push(alpha); return text; },
		requestRender: () => { renders++; },
		clock: {
			now: () => now,
			set: (callback) => { const id = ++nextId; timers.set(id, callback); return id; },
			clear: (id) => { timers.delete(id as number); },
		},
	});
	return {
		watermark, timers, opacity,
		setVisible: (value: boolean) => { visible = value; },
		setMotion: (value: boolean) => { motion = value; },
		setStage: (value: typeof stage) => { stage = value; },
		renders: () => renders,
		advance(time: number) {
			now = time;
			const snapshot = [...timers.entries()];
			for (const [id, callback] of snapshot) { timers.delete(id); callback(); }
		},
	};
}

const click = { type: "click", button: "left", shift: false, alt: false, ctrl: false };

test("welcome panel budgets transcript/dock rows without inspecting screen content", () => {
	for (let columns = 1; columns <= 240; columns++) {
		for (const rows of [8, 14, 24, 28, 40, 80]) {
			const stage = welcomeStage(columns, rows, 10);
			if (!stage) continue;
			assert(stage.col >= 4);
			assert(stage.col + stage.width <= columns - 4);
			assert.equal(stage.row, 1);
			assert(stage.height + 3 + 10 + 8 <= rows);
			assert(stage.width <= 60 && stage.height <= 16 && stage.height >= 12);
		}
	}
	for (const value of [NaN, Infinity, -Infinity]) {
		assert.equal(welcomeStage(value, 40, 8), undefined);
		assert.equal(welcomeStage(80, value, 8), undefined);
		assert.equal(welcomeStage(80, 40, value), undefined);
	}
	assert.equal(welcomeStage(42, 14, 8), undefined);
	assert.equal(welcomeStage(80, 40, -1), undefined);
	assert.equal(welcomeStage(80, 28, 20), undefined);
	assert.deepEqual(welcomeStage(80, 40, 8), { row: 1, col: 10, width: 60, height: 16 });
});

test("idle renders faint cached glyph with no timer or render requests", () => {
	const f = fixture();
	const lines = f.watermark.component.render(60);
	assert(lines.some(line => /[\u2801-\u28ff]/u.test(line)));
	assert(f.opacity.every(value => value === WATERMARK_IDLE_OPACITY));
	const paints = f.opacity.length;
	assert.deepEqual(f.watermark.component.render(60), lines);
	assert.equal(f.opacity.length, paints, "unchanged idle frame should remain cached");
	assert.equal(f.timers.size, 0);
	assert.equal(f.renders(), 0);
	f.watermark.dispose();
});

test("click brightens/morphs and returns to exact idle without persistent timer", () => {
	const f = fixture();
	const idle = f.watermark.component.render(60);
	assert.deepEqual(f.watermark.component.handleMouse(click), { handled: true, focus: false, render: true });
	assert.equal(f.timers.size, 1);
	f.advance(400);
	f.opacity.length = 0;
	const bright = f.watermark.component.render(60);
	assert(f.opacity.length > 0 && f.opacity.every(value => value === 1));
	assert.notDeepEqual(bright, idle);
	f.advance(WATERMARK_REPLAY_MS + WATERMARK_FADE_MS / 2);
	f.opacity.length = 0;
	f.watermark.component.render(60);
	assert(f.opacity.every(value => value > WATERMARK_IDLE_OPACITY && value < 1));
	f.advance(WATERMARK_REPLAY_MS + WATERMARK_FADE_MS);
	assert.equal(f.timers.size, 0);
	assert.deepEqual(f.watermark.component.render(60), idle);
	f.advance(100_000);
	assert.equal(f.timers.size, 0);
	f.watermark.dispose();
});

test("repeated click resets one timer, not multiple animation loops", () => {
	const f = fixture();
	for (let i = 0; i < 10; i++) {
		assert.equal(f.watermark.replay(), true);
		assert.equal(f.timers.size, 1);
		f.advance(i * 100);
	}
	f.watermark.dispose();
	assert.equal(f.timers.size, 0);
});

test("typing/hiding cancels immediately; clear restores static without replay", () => {
	const f = fixture();
	const idle = f.watermark.component.render(60);
	f.watermark.replay();
	f.setVisible(false);
	assert.equal(f.watermark.isVisible(), false);
	assert.equal(f.timers.size, 0);
	assert.deepEqual(f.watermark.component.render(60), []);
	f.setVisible(true);
	assert.deepEqual(f.watermark.component.render(60), idle);
	assert.equal(f.timers.size, 0);
	f.watermark.dispose();
});

test("motion-off leaves static art and refuses clicks without timers", () => {
	const f = fixture();
	f.watermark.replay();
	f.setMotion(false);
	assert.equal(f.watermark.isVisible(), true);
	assert.equal(f.timers.size, 0);
	assert(f.watermark.component.render(60).length > 0);
	assert.equal(f.watermark.component.handleMouse(click), undefined);
	assert.equal(f.watermark.replay(), false);
	f.watermark.dispose();
});

test("resize, theme invalidation, delayed frame, and disposal fail closed", () => {
	const f = fixture();
	f.watermark.replay();
	f.setStage(undefined);
	f.watermark.component.invalidate();
	assert.equal(f.timers.size, 0);
	assert.deepEqual(f.watermark.component.render(60), []);
	f.setStage(welcomeStage(80, 40, 8));
	f.watermark.replay();
	f.advance(999_999);
	assert.equal(f.timers.size, 0, "late frame should settle, not catch up with a burst");
	f.watermark.replay();
	f.watermark.dispose();
	f.watermark.component.invalidate();
	assert.equal(f.watermark.replay(), false);
	assert.equal(f.watermark.isVisible(), false);
	assert.deepEqual(f.watermark.component.render(60), []);
	assert.equal(f.timers.size, 0);
});

test("wheel, drag, modified, and non-left gestures keep native ownership", () => {
	const f = fixture();
	for (const event of [
		{ ...click, type: "wheel" }, { ...click, type: "drag" },
		{ ...click, shift: true }, { ...click, ctrl: true }, { ...click, alt: true },
		{ ...click, button: "right" }, { ...click, button: "middle" },
	]) assert.equal(f.watermark.component.handleMouse(event), undefined);
	assert.deepEqual(f.watermark.component.handleMouse({ ...click, type: "press" }), { handled: true, focus: false, render: false });
	assert.equal(f.timers.size, 0);
	f.watermark.dispose();
});
