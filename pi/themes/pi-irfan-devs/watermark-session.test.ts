import assert from "node:assert/strict";
import test from "node:test";
import { watermarkMetadataOnly, watermarkSessionEligible } from "./watermark-session.ts";

test("session policy allows known invisible metadata but no conversation/unknown entries", () => {
	const entries = ["model_change", "thinking_level_change", "custom", "usage", "session_info"].map(type => ({ type }));
	assert.equal(watermarkMetadataOnly(entries), true);
	for (const reason of ["startup", "reload", "new"]) {
		assert.equal(watermarkSessionEligible({ reason, persisted: false, entries }), true);
	}
	for (const reason of ["resume", "fork", "unknown"]) {
		assert.equal(watermarkSessionEligible({ reason, persisted: false, entries }), false);
	}
	assert.equal(watermarkSessionEligible({ reason: "startup", persisted: true, entries }), false);
	assert.equal(watermarkSessionEligible({ reason: "reload", persisted: true, entries }), false);
	assert.equal(watermarkSessionEligible({ reason: "new", persisted: true, entries }), true);
	assert.equal(watermarkSessionEligible({ reason: "new", persisted: false, entries, parentSession: "parent" }), false);
	for (const type of ["message", "custom_message", "compaction", "branch_summary", "context_edit", "future_entry"]) {
		assert.equal(watermarkMetadataOnly([...entries, { type }]), false);
		assert.equal(watermarkSessionEligible({ reason: "new", persisted: false, entries: [{ type }] }), false);
	}
});
