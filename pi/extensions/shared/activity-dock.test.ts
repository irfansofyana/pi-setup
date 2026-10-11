import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createActivityDock, type ActivitySection } from "./activity-dock.ts";

const host = (rows = 30) => ({ terminal: { rows }, requestRender() {} });
function section(id: "todos" | "subagents", lines = 4): ActivitySection {
	return { id, state: () => ({ rows: lines }), render: (_width, rows) => Array.from({ length: rows }, (_, i) => `${id} ${i}`) };
}

test("one combined dock orders sections consistently within six rows in either load order", () => {
	for (const order of [["todos", "subagents"], ["subagents", "todos"]] as const) {
		const tui = host();
		const components = order.map(id => createActivityDock(tui, section(id)));
		const lines = components.flatMap(component => component.render(80));
		assert.equal(lines.length, 6);
		assert.match(lines[0], /todos/);
		assert.match(lines[3], /subagents/);
		components.forEach(component => component.dispose());
	}
});

test("either extension works alone, and removing one leaves the other mounted", () => {
	const tui = host();
	const todos = createActivityDock(tui, section("todos"));
	assert.equal(todos.render(80).length, 4);
	const agents = createActivityDock(tui, section("subagents"));
	todos.dispose();
	assert.equal(agents.render(80).length, 4);
	agents.dispose();
	assert.deepEqual(agents.render(80), []);
});

test("navigation gets extra space while preserving the other section's summary", () => {
	const tui = host();
	const todos = createActivityDock(tui, section("todos"));
	const agents = createActivityDock(tui, { ...section("subagents", 10), state: () => ({ rows: 10, focused: true }) });
	const lines = todos.render(80);
	assert.equal(lines.length, 10);
	assert.match(lines[0], /todos/);
	assert.equal(lines.filter(line => line.startsWith("todos")).length, 1);
	todos.dispose(); agents.dispose();
});

test("clicks route to section-local rows and stale disposed sections cannot receive clicks", () => {
	const tui = host();
	let clicked = -1;
	const todos = createActivityDock(tui, section("todos", 2));
	const agents = createActivityDock(tui, { ...section("subagents", 2), handleMouse: event => { clicked = event.y; return { handled: true }; } });
	todos.render(80);
	todos.handleMouse({ type: "click", button: "left", x: 0, y: 3 } as any);
	assert.equal(clicked, 1);
	agents.dispose(); clicked = -1;
	todos.handleMouse({ type: "click", button: "left", x: 0, y: 3 } as any);
	assert.equal(clicked, -1);
	todos.dispose();
});

test("replacement cleanup cannot remove a newer registration; terminals stay isolated", () => {
	const tui = host();
	const old = createActivityDock(tui, section("todos"));
	const next = createActivityDock(tui, section("todos", 2));
	const other = createActivityDock(host(), section("subagents"));
	old.dispose();
	assert.equal(next.render(80).length, 2);
	assert.equal(other.render(80).length, 4);
	next.dispose(); other.dispose();
});

test("a former paint owner cannot dispatch stale click coordinates after another section mounts", () => {
	const tui = host();
	let clicked = false;
	const agents = createActivityDock(tui, { ...section("subagents"), handleMouse: () => { clicked = true; return { handled: true }; } });
	agents.render(80);
	const todos = createActivityDock(tui, section("todos"));
	agents.handleMouse({ type: "click", button: "left", x: 0, y: 1 } as any);
	assert.equal(clicked, false);
	todos.dispose(); agents.dispose();
});

test("render failures remain local and short terminals keep bounded Unicode output", () => {
	const tui = host(14);
	const todos = createActivityDock(tui, { ...section("todos"), render() { throw new Error("bad theme"); } });
	const agents = createActivityDock(tui, { ...section("subagents"), render: (_width, rows) => Array.from({ length: rows }, () => "日本語 agent") });
	for (const width of [1, 12, 80]) {
		const lines = todos.render(width);
		assert.ok(lines.length <= 4);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
	}
	assert.match(todos.render(80).join("\n"), /\/todos plan/);
	assert.match(todos.render(80).join("\n"), /agent/);
	todos.dispose(); agents.dispose();
});
