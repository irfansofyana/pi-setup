import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { COST_ENTRY, CostLedger, type CostRecord } from "../src/orch/cost-ledger.ts";
import type { ThreadView } from "../src/types.ts";

const thread = (
  costUsd: number,
  state: ThreadView["state"] = "completed",
  costId = "agent-1",
): ThreadView => ({
  path: "/root/worker",
  parent: "/root",
  owner: "/root",
  type: "worker",
  state,
  task: "work",
  status: state,
  createdAt: 1,
  updatedAt: 1,
  costId,
  costUsd,
});
const entry = (data: unknown): SessionEntry => ({
  type: "custom",
  id: String(Math.random()),
  parentId: null,
  timestamp: new Date().toISOString(),
  customType: COST_ENTRY,
  data,
});

test("start/run/stop/resume/stop rolls up only new dollars, across every inactive state", () => {
  const ledger = new CostLedger();
  const records: CostRecord[] = [];
  const append = (record: CostRecord) => records.push(record);
  assert.equal(ledger.settle(thread(0.5, "running"), append), 0);
  assert.equal(ledger.settle(thread(0.5, "paused"), append), 0.5);
  assert.equal(ledger.settle(thread(0.5, "paused"), append), 0);
  assert.equal(ledger.settle(thread(0.8, "starting"), append), 0);
  assert.equal(ledger.settle(thread(0.8, "running"), append), 0);
  assert.ok(Math.abs(ledger.settle(thread(0.8, "stopped"), append) - 0.3) < 1e-10);
  assert.equal(ledger.totalUsd, 0.8);
  ledger.settle(thread(1, "failed"), append);
  ledger.settle(thread(1.25, "completed"), append);
  assert.equal(ledger.totalUsd, 1.25);
  assert.deepEqual(
    records.map((r) => r.totalUsd),
    [0.5, 0.8, 1, 1.25],
  );
});

test("reload, duplicate entries, rewind, and removed agents cannot recount old dollars", () => {
  const ledger = new CostLedger();
  ledger.restore([
    entry({ threadId: "agent-1", totalUsd: 0.5 }),
    entry({ threadId: "agent-1", totalUsd: 0.8 }),
    entry({ threadId: "agent-1", totalUsd: 0.8 }),
    entry({ threadId: "removed-agent", totalUsd: 0.2 }),
  ]);
  assert.equal(ledger.totalUsd, 1);
  assert.equal(
    ledger.settle(thread(0.8), () => assert.fail("already accounted")),
    0,
  );
  assert.equal(
    ledger.settle(thread(0.5), () => assert.fail("rewound")),
    0,
  );
  ledger.settle(thread(1), () => {});
  assert.equal(ledger.totalUsd, 1.2);
  ledger.settle(thread(0.25, "completed", "replacement-agent"), () => {});
  assert.equal(ledger.totalUsd, 1.45, "path reuse has a distinct lifetime identity");
});

test("a parent's own cost and nested agents are each counted exactly once", () => {
  const ledger = new CostLedger();
  ledger.settle(thread(0.5), () => {});
  ledger.settle({ ...thread(0.2, "completed", "child"), path: "/root/worker/child" }, () => {});
  ledger.settle(thread(0.5), () => assert.fail("duplicate"));
  ledger.settle({ ...thread(4, "completed", "root"), path: "/root" }, () =>
    assert.fail("root excluded"),
  );
  assert.equal(ledger.totalUsd, 0.7);
});

test("invalid costs are ignored and failed persistence can be retried", () => {
  const ledger = new CostLedger();
  ledger.restore([
    entry(null),
    entry({ threadId: "agent-1", totalUsd: NaN }),
    entry({ threadId: "agent-1", totalUsd: -2 }),
    entry({ totalUsd: 9 }),
  ]);
  for (const cost of [NaN, Infinity, -1]) {
    assert.equal(
      ledger.settle(thread(cost), () => assert.fail("invalid")),
      0,
    );
  }
  assert.throws(
    () =>
      ledger.settle(thread(0.5), () => {
        throw Error("disk");
      }),
    /disk/,
  );
  assert.equal(ledger.totalUsd, 0);
  assert.equal(
    ledger.settle(thread(0.5), () => {}),
    0.5,
  );
});

