import assert from "node:assert/strict";
import test from "node:test";
import { emptyPlan, mutatePlan, restorePlan } from "./session-plan.ts";

test("session steps support ordered progress, blockers, completion and reopening", () => {
	let plan = mutatePlan(emptyPlan(), { action: "create", title: "Inspect code" });
	plan = mutatePlan(plan, { action: "create", title: "Write tests" });
	plan = mutatePlan(plan, { action: "update", id: "PLAN-1", status: "in_progress", note: "Reading parser" });
	assert.equal(plan.steps[0].note, "Reading parser");
	plan = mutatePlan(plan, { action: "update", id: "PLAN-2", status: "blocked", note: "Need fixture" });
	plan = mutatePlan(plan, { action: "reorder", order: ["PLAN-2", "PLAN-1"] });
	assert.deepEqual(plan.steps.map(step => step.id), ["PLAN-2", "PLAN-1"]);
	plan = mutatePlan(plan, { action: "update", id: "PLAN-1", status: "completed" });
	assert.equal(plan.steps[1].note, "");
	plan = mutatePlan(plan, { action: "update", id: "PLAN-1", status: "pending" });
	assert.equal(plan.steps[1].status, "pending");
});

test("rejects stale manual edits and invalid mutations without altering the plan", () => {
	const plan = mutatePlan(emptyPlan(), { action: "create", title: "Original" });
	for (const change of [
		{ action: "update", id: "PLAN-1", title: "Overwrite", expectedRevision: 0 },
		{ action: "update", id: "PLAN-1", status: "bogus" },
		{ action: "update", id: "PLAN-1", status: "blocked" },
		{ action: "create", title: "  " },
		{ action: "reorder", order: [] },
		{ action: "reorder", order: ["PLAN-1", "PLAN-1"] },
		{ action: "claim", id: "PLAN-1" },
	]) assert.throws(() => mutatePlan(plan, change));
	assert.equal(plan.steps[0].title, "Original");
	assert.equal(plan.revision, 1);
});

test("replay follows the supplied branch and both manual and tool snapshots", () => {
	const first = mutatePlan(emptyPlan(), { action: "create", title: "First branch" });
	const second = mutatePlan(first, { action: "update", id: "PLAN-1", title: "Manual edit" });
	const toolEntry = { type: "message", message: { role: "toolResult", toolName: "todo", details: { scope: "session", plan: first } } };
	const manualEntry = { type: "custom", customType: "pi-setup-todo-plan", data: second };
	assert.equal(restorePlan([toolEntry, manualEntry]).steps[0].title, "Manual edit");
	assert.equal(restorePlan([toolEntry]).steps[0].title, "First branch");
	assert.deepEqual(restorePlan([]).steps, []);
	assert.equal(restorePlan([manualEntry, { ...manualEntry, data: { version: 1, steps: null } }]).steps[0].title, "Manual edit");
});

test("deleted ids are not reused and callers cannot mutate a saved snapshot", () => {
	const original = mutatePlan(emptyPlan(), { action: "create", title: "First" });
	const removed = mutatePlan(original, { action: "delete", id: "PLAN-1" });
	const next = mutatePlan(removed, { action: "create", title: "Second" });
	assert.equal(next.steps[0].id, "PLAN-2");
	assert.equal(original.steps[0].title, "First");
});

test("late tool results cannot roll back a newer manual snapshot", () => {
	const first = mutatePlan(emptyPlan(), { action: "create", title: "Original" });
	const edited = mutatePlan(first, { action: "update", id: "PLAN-1", title: "Human correction" });
	assert.equal(restorePlan([
		{ type: "custom", customType: "pi-setup-todo-plan", data: edited },
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { scope: "session", plan: first } } },
	]).steps[0].title, "Human correction");
});
