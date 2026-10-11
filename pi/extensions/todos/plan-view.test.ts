import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PlanDetail, planLines } from "./plan-view.ts";
import { emptyPlan, mutatePlan } from "./session-plan.ts";

test("compact panel prioritizes current work and bounds Unicode rows", () => {
	let plan = emptyPlan();
	for (let i = 0; i < 9; i++) plan = mutatePlan(plan, { action: "create", title: `Long 日本語 🌿 step ${i}` });
	plan = mutatePlan(plan, { action: "update", id: "PLAN-9", status: "in_progress", note: "Testing retries" });
	for (const width of [1, 12, 30, 80]) {
		const lines = planLines(plan, { width, active: true });
		assert.ok(lines.length <= 6);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
	}
	const lines = planLines(plan, { width: 80, active: true });
	assert.match(lines[1], /step 8/);
	assert.match(lines.join("\n"), /Progress: Testing retries/);
	assert.match(lines[0], /9/);
	assert.doesNotMatch(lines.join("\n"), /\/todos/);
});

test("shared row budget hides completed rows and repetitive notes without hiding blockers", () => {
	let plan = mutatePlan(emptyPlan(), { action: "create", title: "Finished" });
	plan = mutatePlan(plan, { action: "update", id: "PLAN-1", status: "completed" });
	plan = mutatePlan(plan, { action: "create", title: "Verify regressions", status: "in_progress", note: "Verify regressions" });
	plan = mutatePlan(plan, { action: "create", title: "Publish", status: "blocked", note: "Need approval" });
	const lines = planLines(plan, { width: 100, active: true, maxRows: 3 });
	assert.equal(lines.length, 3);
	assert.doesNotMatch(lines.join("\n"), /Finished|Progress:|\/todos/);
	assert.match(lines[1], /Publish.*Need approval/);
	assert.match(lines[2], /Verify regressions/);
});

test("detail navigation scrolls, clamps on resize and consumes only its own focused input", () => {
	let closed = false;
	let height = 12;
	const step = { id: "PLAN-1", title: "Unicode 日本語", status: "pending" as const, note: "", body: Array.from({ length: 40 }, (_, i) => `Line ${i} 日本語`).join("\n") };
	const detail = new PlanDetail(step, () => height, () => { closed = true; });
	assert.match(detail.render(30).join("\n"), /Line 0/);
	detail.handleInput("\u001b[B");
	assert.doesNotMatch(detail.render(30).join("\n"), /Line 0 /);
	for (let i = 0; i < 100; i++) detail.handleInput("\u001b[B");
	assert.match(detail.render(30).join("\n"), /Line 39/);
	height = 80;
	for (const width of [1, 10, 80]) {
		const lines = detail.render(width);
		assert.ok(lines.length <= height);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
	}
	detail.handleInput("\u001b");
	assert.equal(closed, true);
});

test("completion folds without deleting tasks and idle state is truthful", () => {
	let plan = mutatePlan(emptyPlan(), { action: "create", title: "Work" });
	plan = mutatePlan(plan, { action: "update", id: "PLAN-1", status: "in_progress" });
	assert.match(planLines(plan, { width: 80, active: false }).join("\n"), /agent idle/);
	plan = mutatePlan(plan, { action: "update", id: "PLAN-1", status: "completed" });
	assert.equal(planLines(plan, { width: 80, active: false }).length, 1);
	assert.deepEqual(planLines(plan, { width: 80, active: false, hiddenCompleted: new Set(["PLAN-1"]) }), []);
	assert.equal(plan.steps.length, 1);
});
