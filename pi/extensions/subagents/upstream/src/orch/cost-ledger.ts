import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../types.ts";

export const COST_ENTRY = "pi-subagent:cost:v1";
export interface CostRecord {
  threadId: string;
  totalUsd: number;
}

/** Whole-session accounting, like Pi's footer (not branch-local context). */
export class CostLedger {
  private totals = new Map<string, number>();

  restore(entries: readonly SessionEntry[]): void {
    this.totals.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== COST_ENTRY) continue;
      const data = entry.data as Partial<CostRecord> | undefined;
      if (
        !data ||
        typeof data.threadId !== "string" ||
        !data.threadId ||
        typeof data.totalUsd !== "number" ||
        !Number.isFinite(data.totalUsd) ||
        data.totalUsd < 0
      )
        continue;
      // High-water marks make duplicate records and branch rewinds harmless.
      this.totals.set(data.threadId, Math.max(this.totals.get(data.threadId) ?? 0, data.totalUsd));
    }
  }

  get totalUsd(): number {
    return [...this.totals.values()].reduce((sum, cost) => sum + cost, 0);
  }

  /** Only inactive agents' authoritative own usage may enter the rollup. */
  settle(thread: ThreadView, append: (record: CostRecord) => void): number {
    if (
      thread.path === "/root" ||
      thread.state === "starting" ||
      thread.state === "running" ||
      !thread.costId ||
      thread.costUsd === undefined ||
      !Number.isFinite(thread.costUsd) ||
      thread.costUsd <= (this.totals.get(thread.costId) ?? 0)
    )
      return 0;
    const previous = this.totals.get(thread.costId) ?? 0;
    const record = { threadId: thread.costId, totalUsd: thread.costUsd };
    // Never advance the cursor on a failed persistence write.
    append(record);
    this.totals.set(record.threadId, record.totalUsd);
    return record.totalUsd - previous;
  }
}

