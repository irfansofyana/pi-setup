import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CostLedger } from "../../extensions/subagents/upstream/src/orch/cost-ledger.ts";

/** Whole-session main usage plus deduplicated settled child costs. */
export function footerUsage(entries: readonly SessionEntry[]) {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		usage.input += message.usage.input;
		usage.output += message.usage.output;
		usage.cacheRead += message.usage.cacheRead;
		usage.cacheWrite += message.usage.cacheWrite;
		usage.cost += message.usage.cost.total;
	}
	const children = new CostLedger();
	children.restore(entries);
	usage.cost += children.totalUsd;
	return usage;
}

/** Signature already includes child costs in its main cost value. */
export function separateFooterStatus(key: string): boolean {
	return key !== "subagent_cost";
}
