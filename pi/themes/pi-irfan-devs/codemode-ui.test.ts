import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme, ToolRenderContext, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { compactCodemodeRenderers, registerCompactCodemode } from "./codemode-ui.ts";

const theme = { name: "pi-irfan-devs", fg: (_token: string, text: string) => text } as Theme;
const context = (overrides: Partial<ToolRenderContext> = {}): ToolRenderContext => ({
	args: {}, toolCallId: "call-1", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/project",
	executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: true,
	isError: false, durationMs: 13_800, outputPad: 1, ...overrides,
});
const text = (component: { render(width: number): string[] }, width = 100) => component.render(width).map(line => stripTerminalSequences(line).trimEnd()).join("\n");
const result = {
	content: [{ type: "text" as const, text: "Script completed\nWall time 13.8 seconds\nOutput:\n" },
		{ type: "text" as const, text: '{"large":"raw output"}\n'.repeat(50) }],
	details: { calls: [{ name: "read", status: "ok" }, { name: "todo", status: "ok" }] },
};

test("collapsed call/result omits raw code and output without changing data", () => {
	const renderer = compactCodemodeRenderers(undefined);
	const before = JSON.stringify(result);
	const call = renderer.renderCall!({ code: "text(await tools.read({path: '/project/file'}));" }, theme, context());
	assert.equal(text(call), "✓ codemode · completed · 13.8s");
	const output = renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, context());
	assert.equal(text(output), "2 calls · expand for details");
	assert.equal(JSON.stringify(result), before);
	assert.doesNotMatch(text(call) + text(output), /tools\.read|raw output/);
});

test("preparing, streaming and resumed completed calls have truthful states", () => {
	const renderer = compactCodemodeRenderers(undefined);
	assert.match(text(renderer.renderCall!({}, theme, context({ executionStarted: false, isPartial: true, durationMs: undefined }))), /preparing/);
	assert.match(text(renderer.renderCall!({}, theme, context({ isPartial: true, durationMs: undefined }))), /running/);
	assert.match(text(renderer.renderCall!({}, theme, context({ executionStarted: false, durationMs: undefined }))), /completed/);
	assert.match(text(renderer.renderResult!({ content: [], details: { calls: [{ name: "read", status: "running" }] } },
		{ expanded: false, isPartial: true }, theme, context({ isPartial: true }))), /1 running/);
});

test("caught nested failures and script failures stay visible, control sequences stripped", () => {
	const renderer = compactCodemodeRenderers(undefined);
	const failed = { ...result, details: { calls: [{ name: "read", status: "error", error: "file not found\x1b[2J" }] } };
	const output = renderer.renderResult!(failed, { expanded: false, isPartial: false }, theme, context());
	assert.match(text(output), /1 failed/);
	assert.match(text(output), /read: file not found/);
	assert.doesNotMatch(output.render(100).join(""), /\x1b\[2J/);
	const error = renderer.renderResult!({ content: [{ type: "text", text: "Script error: timed out" }], details: undefined },
		{ expanded: false, isPartial: false }, theme, context({ isError: true }));
	assert.match(text(error), /timed out/);
	assert.doesNotMatch(text(error), /Script error:/);
});

test("script failure is concise, warns about prior calls, and preserves expanded payload", () => {
	const payload = {
		content: [{ type: "text" as const, text: "Script error: Error: Missing doc anchors\n    at <anonymous> (codemode.js:7:32)\nTool calls made before the failure (they are not undone): read (ok)" }],
		details: { calls: [{ name: "read", status: "ok" }] },
	};
	const before = JSON.stringify(payload);
	let expandedResult: unknown;
	const renderer = compactCodemodeRenderers({
		renderResult(original) { expandedResult = original; return new Text(original.content.filter(part => part.type === "text").map(part => part.text).join("\n"), 0, 0); },
	});
	const ctx = context({ isError: true });
	const compact = text(renderer.renderResult!(payload, { expanded: false, isPartial: false }, theme, ctx));
	assert.match(compact, /^Missing doc anchors\n/);
	assert.match(compact, /1 prior call · changes not undone/);
	assert.match(compact, /expand for details/);
	assert.doesNotMatch(compact, /codemode\.js|<anonymous>|Script error: Error:/);
	const expanded = text(renderer.renderResult!(payload, { expanded: true, isPartial: false }, theme, ctx));
	assert.equal(expandedResult, payload);
	assert.match(expanded, /codemode\.js:7:32/);
	assert.equal(JSON.stringify(payload), before);
});

test("expansion and other palettes delegate with correct component cache, preserve shell", () => {
	let calls = 0;
	let results = 0;
	const base = {
		renderShell: "default" as const,
		renderCall(_args: unknown, _theme: Theme, ctx: ToolRenderContext) {
			assert.equal(ctx.lastComponent, undefined);
			calls++;
			return new Text("original code", 0, 0);
		},
		renderResult(original: unknown, _options: unknown, _theme: Theme, ctx: ToolRenderContext) {
			assert.equal(original, result);
			assert.equal(ctx.lastComponent, undefined);
			results++;
			return new Text("original output", 0, 0);
		},
	};
	const renderer = compactCodemodeRenderers(base);
	const cached = context({ lastComponent: new Text("our collapsed cache", 0, 0), expanded: true });
	assert.equal(renderer.renderShell, "default");
	assert.equal(text(renderer.renderCall!({}, theme, cached)), "original code");
	assert.equal(text(renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, cached)), "original output");
	const other = { ...theme, name: "irfan-gruvbox" };
	renderer.renderCall!({}, other, context());
	renderer.renderResult!(result, { expanded: false, isPartial: false }, other, context());
	assert.equal(calls, 2);
	assert.equal(results, 2);
});

test("unknown details and Unicode errors fit narrow rendered widths", () => {
	const renderer = compactCodemodeRenderers(undefined);
	for (const details of [undefined, null, { calls: "bad" }, { calls: [null, {}, { name: "界", status: "error", error: "界🧭".repeat(300) }] }]) {
		const component = renderer.renderResult!({ content: [], details }, { expanded: false, isPartial: false }, theme, context());
		for (let width = 2; width <= 100; width++) {
			assert(component.render(width).every(line => visibleWidth(line) <= width));
		}
	}
});

test("registration preserves unrelated/self-rendered tools and supports older SDKs", () => {
	let resolver: ToolRendererResolver | undefined;
	registerCompactCodemode({ registerToolRenderer(value: ToolRendererResolver) { resolver = value; } } as ExtensionAPI);
	const base = { renderShell: "self" as const };
	assert.equal(resolver!("codemode", () => base), base);
	assert.equal(resolver!("read", () => base), base);
	assert.equal(resolver!("read", () => undefined), undefined);
	assert.equal(resolver!("codemode", () => undefined), undefined, "unknown/resumed tools keep native fallback");
	registerCompactCodemode({} as ExtensionAPI);
});

test("expanded-running to collapsed-final forwards native cleanup with separate caches", () => {
	let timerRunning = false;
	let nativeCall: Text | undefined;
	let nativeResult: Text | undefined;
	const partials: boolean[] = [];
	const renderer = compactCodemodeRenderers({
		renderCall(_args, _theme, ctx) {
			assert.equal(ctx.lastComponent, nativeCall);
			if (ctx.isPartial) timerRunning = true;
			nativeCall ??= new Text("native call", 0, 0);
			return nativeCall;
		},
		renderResult(_result, options, _theme, ctx) {
			assert.equal(ctx.lastComponent, nativeResult);
			partials.push(options.isPartial);
			if (!options.isPartial) timerRunning = false;
			nativeResult ??= new Text("native result", 0, 0);
			return nativeResult;
		},
	});
	const sharedState = {};
	const expanded = context({ state: sharedState, expanded: true, isPartial: true, durationMs: undefined });
	renderer.renderCall!({}, theme, expanded);
	renderer.renderResult!(result, { expanded: true, isPartial: true }, theme, expanded);
	assert(timerRunning);
	const collapsed = { ...expanded, expanded: false, lastComponent: new Text("compact cache", 0, 0) };
	renderer.renderCall!({}, theme, collapsed);
	renderer.renderResult!(result, { expanded: false, isPartial: true }, theme, collapsed);
	const final = { ...collapsed, isPartial: false };
	renderer.renderCall!({}, theme, final);
	const component = renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, final);
	assert.equal(timerRunning, false, "native final-result cleanup must run while collapsed");
	assert.deepEqual(partials, [true, true, false]);
	assert.match(text(component), /2 calls/);
	assert.doesNotMatch(text(component), /native result/);
});

test("never-expanded compact rows do not start native timers", () => {
	let nativeCalls = 0;
	const renderer = compactCodemodeRenderers({
		renderCall() { nativeCalls++; return new Text("native", 0, 0); },
		renderResult() { nativeCalls++; return new Text("native", 0, 0); },
	});
	const ctx = context({ isPartial: true });
	renderer.renderCall!({}, theme, ctx);
	renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, { ...ctx, isPartial: false });
	assert.equal(nativeCalls, 0);
});
