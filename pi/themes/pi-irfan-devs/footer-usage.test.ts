import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { footerUsage, separateFooterStatus } from "./footer-usage.ts";
import { COST_ENTRY } from "../../extensions/subagents/upstream/src/orch/cost-ledger.ts";

const metadata = { id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00Z" };
const main: SessionEntry = {
	...metadata, type: "message",
	message: {
		role: "assistant", api: "openai-completions", provider: "test", model: "test",
		content: [], stopReason: "stop", timestamp: 1,
		usage: {
			input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160,
			cost: { input: 0.25, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		},
	},
};
const child = (threadId: string, totalUsd: unknown): SessionEntry => ({
	...metadata, type: "custom", customType: COST_ENTRY, data: { threadId, totalUsd },
});

test("main-only sessions preserve stats; child-only sessions show cost", () => {
	assert.deepEqual(footerUsage([main]), { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: 0.5 });
	assert.deepEqual(footerUsage([child("worker", 0.25)]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.25 });
});

test("combined dollars include each child's high-water cost once, not child tokens", () => {
	const entries = [main, child("worker", 0.125), child("worker", 0.25), child("worker", 0.25), child("worker", 0.125), child("nested-worker", 0.125)];
	assert.deepEqual(footerUsage(entries), { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: 0.875 });
	assert.equal(footerUsage(entries).cost, 0.875, "repeated renders/restores do not recount costs");
});

test("settlement updates rollup; fresh sessions do not retain old totals", () => {
	const entries = [main, child("worker", 0.125)];
	assert.equal(footerUsage(entries).cost, 0.625);
	entries.push(child("worker", 0.25));
	assert.equal(footerUsage(entries).cost, 0.75);
	assert.equal(footerUsage([]).cost, 0);
});

test("malformed cost records and unrelated extension data cannot corrupt total", () => {
	const entries = [main, ...[NaN, Infinity, -1, "0.5", null].map(value => child("bad", value)), child("", 100)];
	entries.push({ ...metadata, type: "custom", customType: "unrelated", data: { threadId: "other", totalUsd: 100 } });
	assert.equal(footerUsage(entries).cost, 0.5);
});

test("only duplicate subagent status is hidden; other consumers' keys survive", () => {
	assert.equal(separateFooterStatus("subagent_cost"), false);
	for (const key of ["headroom", "hindsight", "goal", "other_cost"]) assert.equal(separateFooterStatus(key), true);
});
