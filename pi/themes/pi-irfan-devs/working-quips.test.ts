import assert from "node:assert/strict";
import test from "node:test";
import { isGenericWorking, workingQuip, QUIP_INTERVAL_MS, WORKING_QUIPS } from "./working-quips.ts";

test("quips rotate slowly and wrap without timers", () => {
	assert.equal(WORKING_QUIPS.length, 24);
	assert.equal(new Set(WORKING_QUIPS).size, WORKING_QUIPS.length);
	for (const quip of WORKING_QUIPS) assert(quip.length <= 32, quip);
	assert.equal(workingQuip(0), WORKING_QUIPS[0]);
	assert.equal(workingQuip(-1), WORKING_QUIPS[0]);
	assert.equal(workingQuip(QUIP_INTERVAL_MS - 1), WORKING_QUIPS[0]);
	assert.equal(workingQuip(QUIP_INTERVAL_MS), WORKING_QUIPS[1]);
	assert.equal(workingQuip(QUIP_INTERVAL_MS * WORKING_QUIPS.length), WORKING_QUIPS[0]);
});

test("only generic work is replaced, never tool or recovery messages", () => {
	for (const dot of ["·", "∙", "•"]) assert(isGenericWorking("working", `${dot} Working`));
	assert(isGenericWorking("working", " • working "));
	for (const kind of ["retry", "compaction", "idle", "branch-summary"]) {
		assert(!isGenericWorking(kind, "• Working"));
	}
	for (const message of ["• 2 tools · read, edit", "• Retrying", "• Working on read", ""]) {
		assert(!isGenericWorking("working", message));
	}
});
