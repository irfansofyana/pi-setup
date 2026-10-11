import test from "node:test";
import assert from "node:assert/strict";
import { agentActivity, agentState, agentStats, agentTone, fleetOverview, orderedAgents } from "./fleet-view.ts";
import type { ThreadView } from "./upstream/src/types.ts";

function thread(path: string, state: ThreadView["state"] = "running"): ThreadView {
  return { path, parent: "/root", owner: "/root", type: "researcher", color: "accent", task: "Research official sources", status: "Tool: web_fetch", state, createdAt: 1, updatedAt: 1, costId: path, elapsedMs: 12000, inputTokens: 2000, outputTokens: 400 };
}

test("fleet shows all states, safe latest activity, metrics and identity-bound detail rows", () => {
  const workers = [thread("/root/done", "completed"), thread("/root/queued"), thread("/root/active"), thread("/root/paused", "paused")];
  const before = workers.map(worker => worker.path);
  const rows = fleetOverview(workers, 12, path => ({ runState: path.endsWith("queued") ? "queued" : "running", turns: 2, toolUses: 3 }), 12000);
  assert.equal(rows[0].text, "Subagents · 1 running · 1 queued · 1 paused · 1 done");
  assert.match(rows[1].text, /active.*running.*12.0s/);
  assert.doesNotMatch(rows[1].text, /turns|tokens|tools/);
  assert.equal(rows[1].selection?.path, "/root/active");
  assert.equal(rows[1].selection?.identity, "/root/active");
  assert.ok(rows.some(row => row.text.includes("Waiting for an execution slot")));
  assert.ok(rows.some(row => row.text.includes("Tool: web_fetch")));
  assert.deepEqual(workers.map(worker => worker.path), before);
  for (const row of rows) if (row.parts) assert.equal(row.parts.map(part => part.text).join(""), row.text);
});

test("bounded fleet keeps hidden/queued counts and keyboard help, excluding root", () => {
  const workers = [thread("/root"), ...Array.from({ length: 16 }, (_, i) => thread(`/root/task-${i}`))];
  for (let size = 1; size <= 12; size++) {
    const rows = fleetOverview(workers, size, () => ({ runState: "queued" }));
    assert.ok(rows.length <= size);
    assert.match(rows[0].text, /16 queued/);
    assert.doesNotMatch(rows[0].text, /0 running/);
    if (size > 1) assert.match(rows.at(-1)!.text, /more.*←\/↓ subagents/);
    assert.ok(rows.every(row => row.selection?.path !== "/root"));
  }
  assert.deepEqual(fleetOverview([], 12), []);
});

test("idle completion grace folds into a review summary without hiding attention", () => {
  const done = { ...thread("/root/done", "completed"), updatedAt: 1000 };
  const render = (now: number, workers = [done]) => fleetOverview(workers, 10, undefined, now, { collapseCompleted: true });
  assert.ok(render(5999).some(row => row.selection?.path === done.path));
  const folded = render(6000);
  assert.equal(folded.length, 1);
  assert.match(folded[0].text, /1 subagent completed/);
  assert.equal(folded[0].action, "review");
  const mixed = render(6000, [done, thread("/root/failed", "failed"), thread("/root/paused", "paused")]);
  assert.ok(mixed.some(row => row.selection?.path === "/root/failed"));
  assert.ok(mixed.some(row => row.selection?.path === "/root/paused"));
  assert.ok(!mixed.some(row => row.selection?.path === done.path));
  assert.match(mixed.at(-1)!.text, /1 completed/);
  done.state = "running";
  assert.ok(render(7000).some(row => row.selection?.path === done.path), "follow-up returns to the live dock");
});

test("short display names and unread badges never replace lifetime routing identity", () => {
  const worker = thread("/root/long/path/research");
  const rows = fleetOverview([worker], 6, () => ({ name: "Release notes" }), 12000, { unread: () => 2 });
  const row = rows.find(item => item.selection?.path)!;
  assert.match(row.text, /Release notes.*2 new/);
  assert.equal(row.selection?.path, worker.path); assert.equal(row.selection?.identity, worker.costId);
  const namedPath = fleetOverview([worker], 6, () => ({ name: worker.path }));
  assert.match(namedPath[1].text, /research/); assert.doesNotMatch(namedPath[1].text, /\/root\//);
});

test("completed summary pluralizes subagents and retains unread counts when other work is active", () => {
  const done = [thread("/root/one", "completed"), thread("/root/two", "completed")];
  const options = { collapseCompleted: true, unread: (worker: ThreadView) => worker.state === "completed" ? 1 : 0 };
  const summary = fleetOverview(done, 10, undefined, 6000, options);
  assert.match(summary[0].text, /2 subagents completed · 2 new/);
  const mixed = fleetOverview([...done, thread("/root/active")], 10, undefined, 6000, options);
  assert.match(mixed.at(-1)!.text, /2 completed · 2 new/);
});

test("activity remains visible on narrow terminals and every row fits by terminal cells", () => {
  const worker = thread("/root/漢字-agent"); worker.task = "A very long task description ".repeat(5);
  const rows = fleetOverview([worker], 6, undefined, 12000, { width: 40 });
  assert.ok(rows.some(row => row.text.includes("Tool: web_fetch")));
  assert.ok(rows.every(row => row.text.length <= 40));
});

test("navigation order does not change when a worker completes or queues", () => {
  const workers = [thread("/root/b"), { ...thread("/root/a"), createdAt: 0 }];
  assert.deepEqual(orderedAgents(workers).map(t => t.path), ["/root/a", "/root/b"]);
  workers[1].state = "completed";
  assert.deepEqual(orderedAgents(workers).map(t => t.path), ["/root/a", "/root/b"]);
});

test("other themes advertise the command instead of inactive arrow controls", () => {
  const rows = fleetOverview([thread("/root/active")], 6, undefined, 12000, { keyboard: false });
  assert.match(rows.at(-1)!.text, /\/agents tasks/);
  assert.doesNotMatch(rows.at(-1)!.text, /←/);
});

test("failed agents hide provider error bodies and unknown colors cannot reach theme", () => {
  const worker = thread("/root/failure", "failed");
  worker.status = "PRIVATE_FIXTURE_DATA";
  worker.error = "PRIVATE_FIXTURE_DATA";
  worker.color = "unsupported-theme-token";
  assert.equal(agentTone(worker), "accent");
  assert.equal(agentActivity(worker), "Failed · error details hidden");
  assert.doesNotMatch(fleetOverview([worker], 12).map(row => row.text).join("\n"), /PRIVATE_FIXTURE_DATA/);
  assert.equal(agentState(worker, { runState: "queued" }), "failed");
});

test("display text rejects terminal controls and invalid metrics, active time remains accurate", () => {
  const worker = thread("/root/active");
  worker.task = "\x1b[31mcolored\x1b[0m\nsecond line";
  worker.type = "\x1b]8;;https://example.com\x07role\x1b]8;;\x07";
  worker.startedAt = 1000;
  worker.inputTokens = Number.NaN;
  const rows = fleetOverview([worker], 12, () => ({ totalTokens: Number.NaN, turns: -1, toolUses: Number.NaN }), 4000);
  assert.doesNotMatch(rows.map(row => row.text).join("\n"), /\x1b|NaN|-1 turn/);
  assert.match(agentStats(worker, undefined, 4000), /400 tokens · 15.0s/);
  worker.state = "completed";
  assert.match(agentStats(worker, undefined, 4000), /12.0s/);
});
