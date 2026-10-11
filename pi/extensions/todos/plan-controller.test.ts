import assert from "node:assert/strict";
import test from "node:test";
import { PlanController } from "./plan-controller.ts";

function fixture() {
	const events = new Map<string, Function>();
	const entries: unknown[] = [];
	const widgets: unknown[] = [];
	const notices: string[] = [];
	const api = { on(name: string, handler: Function) { events.set(name, handler); }, appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); } };
	const ctx: any = { mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "root", getBranch: () => entries }, ui: { setWidget(_key: string, value: unknown) { widgets.push(value); }, notify(text: string) { notices.push(text); } } };
	const controller = new PlanController(api as any);
	controller.start(ctx);
	return { controller, ctx, entries, events, widgets, notices, api };
}

test("a reused parent tool cannot journal a child plan into the parent session", () => {
	const f = fixture();
	f.controller.execute({ action: "create", title: "Root work" }, f.ctx);
	const paints = f.widgets.length;
	const child = { ...f.ctx, mode: "json", hasUI: false, sessionManager: { getSessionId: () => "child", getBranch: () => [] } };
	const result = f.controller.execute({ action: "create", title: "Child work" }, child);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /own session/);
	assert.equal(f.controller.read(child).steps.length, 0);
	assert.equal(f.entries.length, 1);
	f.events.get("agent_end")!({}, child);
	f.events.get("session_shutdown")!({}, child);
	assert.equal(f.widgets.length, paints);
	assert.equal(f.controller.read(f.ctx).steps[0].title, "Root work");
});

test("manual creation shares tool state and survives reload; cancelling has no mutation", async () => {
	const f = fixture();
	let selections = ["Add step", undefined];
	f.ctx.ui.select = async () => selections.shift();
	f.ctx.ui.input = async () => "Manual task";
	await f.controller.manage(f.ctx);
	assert.equal(f.controller.read(f.ctx).steps[0].title, "Manual task");
	assert.equal(f.entries.length, 1);
	f.controller.start(f.ctx);
	assert.equal(f.controller.execute({ action: "list" }, f.ctx).details.plan.steps[0].title, "Manual task");
	selections = ["Add step", undefined];
	f.ctx.ui.input = async () => undefined;
	await f.controller.manage(f.ctx);
	assert.equal(f.entries.length, 1);
});

test("a concurrent tool edit wins over a stale manual form", async () => {
	const f = fixture();
	f.controller.execute({ action: "create", title: "Original" }, f.ctx);
	let count = 0;
	f.ctx.ui.select = async (_title: string, options: string[]) => ++count === 1 ? options.find(option => option.includes("PLAN-1")) : count === 2 ? "Edit title" : undefined;
	f.ctx.ui.editor = async () => {
		f.controller.execute({ action: "update", id: "PLAN-1", title: "Agent edit" }, f.ctx);
		return "Stale manual edit";
	};
	await f.controller.manage(f.ctx);
	assert.equal(f.controller.read(f.ctx).steps[0].title, "Agent edit");
	assert.match(f.notices.join(" "), /changed while you were editing/);
	assert.equal(f.entries.length, 2);
});

test("session tree replay replaces abandoned branch and prompt includes manual plan", () => {
	const f = fixture();
	f.controller.execute({ action: "create", title: "Abandoned branch" }, f.ctx);
	f.entries.length = 0; // The selected branch excludes the abandoned mutation.
	f.events.get("session_tree")!({}, f.ctx);
	assert.equal(f.controller.read(f.ctx).steps.length, 0);
	f.controller.execute({ action: "create", title: "New plan" }, f.ctx);
	const result = f.events.get("before_agent_start")!({ systemPrompt: "Base" }, f.ctx);
	assert.match(result.systemPrompt, /New plan/);
	assert.match(result.systemPrompt, /^Base/);
});

test("manual reorder, blocked status and cancelled delete use the same plan operations", async () => {
	const f = fixture();
	f.controller.execute({ action: "create", title: "First" }, f.ctx);
	f.controller.execute({ action: "create", title: "Second" }, f.ctx);
	const choices = ["PLAN-2", "Move up", "PLAN-2", "Change status", "blocked", "PLAN-2", "Delete step"];
	f.ctx.ui.select = async (_title: string, options: string[]) => {
		const choice = choices.shift();
		return options.find(option => option === choice || (choice?.startsWith("PLAN-") && option.includes(choice)));
	};
	f.ctx.ui.editor = async () => "Waiting for a test fixture";
	f.ctx.ui.confirm = async () => false;
	await f.controller.manage(f.ctx);
	const plan = f.controller.read(f.ctx);
	assert.deepEqual(plan.steps.map(step => step.id), ["PLAN-2", "PLAN-1"]);
	assert.equal(plan.steps[0].status, "blocked");
	assert.equal(plan.steps[0].note, "Waiting for a test fixture");
	assert.equal(f.entries.length, 4);
});

test("switching sessions during a dialog leaves plans unchanged", async () => {
	const f = fixture();
	let first = true;
	f.ctx.ui.select = async () => first ? (first = false, "Add step") : undefined;
	f.ctx.ui.input = async () => {
		f.ctx.sessionManager.getSessionId = () => "other-session";
		return "Wrong session";
	};
	await f.controller.manage(f.ctx);
	assert.equal(f.entries.length, 0);
	f.ctx.sessionManager.getSessionId = () => "root";
	assert.equal(f.controller.read(f.ctx).steps.length, 0);
});

test("tree navigation in the same session cancels an open form", async () => {
	const f = fixture();
	let first = true;
	f.ctx.ui.select = async () => first ? (first = false, "Add step") : undefined;
	f.ctx.ui.input = async () => {
		f.events.get("session_tree")!({}, f.ctx);
		return "Belongs to abandoned branch";
	};
	await f.controller.manage(f.ctx);
	assert.equal(f.controller.read(f.ctx).steps.length, 0);
	assert.equal(f.entries.length, 0);
});

test("failed manual persistence does not publish unsaved changes", async () => {
	const f = fixture();
	let first = true;
	f.ctx.ui.select = async () => first ? (first = false, "Add step") : undefined;
	f.ctx.ui.input = async () => "Unsaved";
	f.api.appendEntry = () => { throw new Error("Journal unavailable"); };
	await f.controller.manage(f.ctx);
	assert.equal(f.controller.read(f.ctx).steps.length, 0);
	assert.match(f.notices.join(" "), /Journal unavailable/);
});

test("completion stays inspectable after folding and shutdown removes the widget", () => {
	const f = fixture();
	f.events.get("agent_start")!({}, f.ctx);
	f.controller.execute({ action: "create", title: "Work" }, f.ctx);
	f.controller.execute({ action: "update", id: "PLAN-1", status: "completed" }, f.ctx);
	const host = { terminal: { rows: 30 }, requestRender() {} };
	let factory: unknown, component: any;
	const render = () => {
		if (factory !== f.widgets.at(-1)) { factory = f.widgets.at(-1); component = (factory as Function)(host, { fg: (_color: string, text: string) => text }); }
		return component.render(80);
	};
	assert.match(render()[0], /1\/1 completed/);
	f.events.get("agent_end")!({}, f.ctx);
	assert.equal(render().length, 1);
	f.events.get("agent_start")!({}, f.ctx);
	assert.equal(render().length, 0);
	assert.equal(f.controller.read(f.ctx).steps[0].status, "completed");
	f.events.get("session_shutdown")!({}, f.ctx);
	assert.equal(f.widgets.at(-1), undefined);
});

test("headless plans replay tool results and never require terminal UI", () => {
	const f = fixture();
	const ctx = { ...f.ctx, mode: "json", hasUI: false, ui: undefined };
	const result = f.controller.execute({ action: "create", title: "Headless work" }, ctx);
	f.entries.push({ type: "message", message: { role: "toolResult", toolName: "todo", details: result.details } });
	f.controller.start(ctx);
	assert.equal(f.controller.read(ctx).steps[0].title, "Headless work");
});

test("an independently loaded child extension journals its own headless plan", () => {
	const parent = fixture();
	const child = fixture();
	child.ctx.sessionManager.getSessionId = () => "child";
	child.ctx.mode = "json";
	child.ctx.hasUI = false;
	child.controller.start(child.ctx);
	assert.equal(child.controller.execute({ action: "create", title: "Child work" }, child.ctx).isError, undefined);
	child.controller.start(child.ctx);
	assert.equal(child.controller.read(child.ctx).steps[0].title, "Child work");
	assert.equal(child.entries.length, 1);
	assert.equal(parent.entries.length, 0);
});

test("nested codemode mutations survive reload and compaction without standalone todo results", () => {
	const f = fixture();
	f.controller.execute({ action: "create", title: "First", status: "in_progress" }, f.ctx);
	const older = f.controller.execute({ action: "create", title: "Second" }, f.ctx);
	f.entries.push({ type: "message", message: { role: "toolResult", toolName: "todo", details: older.details } });
	for (const id of ["PLAN-1", "PLAN-2"]) {
		assert.equal(f.controller.execute({ action: "update", id, status: "completed" }, f.ctx).isError, undefined);
	}
	f.entries.push({ type: "message", message: { role: "toolResult", toolName: "codemode", details: {} } });
	// A late result for an older revision must not roll back journaled progress.
	f.entries.push({ type: "message", message: { role: "toolResult", toolName: "todo", details: older.details } });
	f.controller.start(f.ctx);
	assert.deepEqual(f.controller.read(f.ctx).steps.map(step => step.status), ["completed", "completed"]);
	f.events.get("session_compact")!({}, f.ctx);
	assert.deepEqual(f.controller.read(f.ctx).steps.map(step => step.status), ["completed", "completed"]);
	assert.equal(f.entries.filter((entry: any) => entry.type === "custom").length, 4);
});

test("only successful mutations journal; failed writes leave memory and UI unchanged", () => {
	const f = fixture();
	f.controller.execute({ action: "create", title: "Saved" }, f.ctx);
	for (const change of [{ action: "list" }, { action: "list-all" }, { action: "get", id: "PLAN-1" }, { action: "update", id: "missing" }, { action: "update", id: "PLAN-1", title: "Stale", expectedRevision: 0 }]) f.controller.execute(change, f.ctx);
	assert.equal(f.entries.length, 1);
	const before = f.controller.read(f.ctx);
	const paints = f.widgets.length;
	f.api.appendEntry = () => { throw new Error("Journal unavailable"); };
	const result = f.controller.execute({ action: "update", id: "PLAN-1", status: "completed" }, f.ctx);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Journal unavailable/);
	assert.deepEqual(f.controller.read(f.ctx), before);
	assert.equal(f.widgets.length, paints);
});
