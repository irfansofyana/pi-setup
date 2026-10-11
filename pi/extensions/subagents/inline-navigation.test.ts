import test from "node:test";
import assert from "node:assert/strict";
import { createInlineNavigation } from "./inline-navigation.ts";
import type { AgentSelection } from "./fleet-view.ts";
import type { ThreadView } from "./upstream/src/types.ts";

const active = { focused: true, autocomplete: false };
const thread = (path: string, createdAt = 1): ThreadView => ({
  path, state: "running", type: "scout", parent: "/root", owner: "/root",
  task: "Read assigned files", status: "Working", createdAt, updatedAt: 1, costId: path,
});
function fixture() {
  const threads = [thread("/root/map"), thread("/root/review", 2)];
  const opened: AgentSelection[] = [];
  let text = "";
  const nav = createInlineNavigation({ threads: () => threads, editor: { getText: () => text },
    openDetails: selection => opened.push(selection), changed() {} });
  return { nav, threads, opened, get text() { return text; }, set text(value) { text = value; } };
}

test("empty focused Left/Down focus the task list without opening or changing Main", () => {
  for (const key of ["left", "down"] as const) {
    const f = fixture();
    assert.equal(f.nav.handle(key, { ...active, focused: false }), false);
    assert.equal(f.nav.handle(key, { ...active, autocomplete: true }), false);
    f.text = "draft"; assert.equal(f.nav.handle(key, active), false);
    f.text = " "; assert.equal(f.nav.handle(key, active), false);
    f.text = ""; assert.equal(f.nav.handle(key, active), true);
    assert.equal(f.nav.picking, true); assert.deepEqual(f.opened, []);
    assert.match(f.nav.render().join("\n"), /› Main/);
  }
});

test("selection clamps at the last task and Up above Main returns editor focus", () => {
  const f = fixture(); f.nav.handle("left", active);
  for (let i = 0; i < 10; i++) f.nav.handle("down", active);
  f.nav.handle("enter", active);
  assert.deepEqual(f.opened, [{ path: "/root/review", identity: "/root/review" }]);
  f.nav.handle("up", active); f.nav.handle("up", active);
  assert.match(f.nav.render().join("\n"), /› Main/);
  f.nav.handle("up", active); assert.equal(f.nav.picking, false);
});

test("a task changing state or a newly arriving task cannot move the highlighted recipient", () => {
  const f = fixture(); f.nav.handle("left", active); f.nav.handle("down", active);
  f.threads[0].state = "completed";
  f.threads.unshift(thread("/root/new", 3));
  f.nav.handle("enter", active);
  assert.deepEqual(f.opened, [{ path: "/root/map", identity: "/root/map" }]);
});

test("replacing or reaping a highlighted identity returns to Main before Enter", () => {
  for (const replace of [true, false]) {
    const f = fixture(); f.nav.handle("left", active); f.nav.handle("down", active);
    if (replace) f.threads[0] = { ...f.threads[0], costId: "replacement" };
    else f.threads.shift();
    assert.equal(f.nav.handle("enter", active), true);
    assert.deepEqual(f.opened, []); assert.equal(f.nav.picking, false);
  }
});

test("one-row task list always displays the actual highlighted recipient", () => {
  const f = fixture(); f.nav.handle("left", active); f.nav.handle("down", active);
  const rows = f.nav.view(1);
  assert.equal(rows.length, 1); assert.match(rows[0].text, /›.*map/);
  assert.equal(rows[0].selection?.identity, "/root/map");
  f.nav.handle("enter", active); assert.equal(f.opened[0].path, "/root/map");
});

test("typing, pasting, escape and nonempty arrows relinquish selection without routing Main input", () => {
  for (const key of ["edit", "escape", "right"] as const) {
    const f = fixture(); f.nav.handle("left", active); f.nav.handle("down", active);
    f.nav.handle(key, active); assert.equal(f.nav.picking, false); assert.deepEqual(f.opened, []);
  }
  const f = fixture(); f.nav.handle("left", active); f.text = "inserted draft";
  assert.equal(f.nav.handle("enter", active), false);
  assert.equal(f.nav.picking, false); assert.equal(f.text, "inserted draft"); assert.deepEqual(f.opened, []);
});

test("mouse opens only the rendered lifetime; reopening preserves highlight and Main draft", () => {
  const f = fixture(); f.text = "Main draft";
  const selection = f.nav.view().find(row => row.selection?.path === "/root/map")!.selection!;
  assert.equal(f.nav.open(selection), true); assert.equal(f.text, "Main draft");
  assert.match(f.nav.render().join("\n"), /›.*map/);
  f.threads[0].costId = "replacement";
  assert.equal(f.nav.open(selection), false); assert.equal(f.opened.length, 1);
});

test("reset and empty fleets remove list focus without touching the editor", () => {
  const f = fixture(); f.nav.handle("left", active); f.nav.reset();
  assert.equal(f.nav.picking, false);
  f.nav.handle("left", active); f.threads.length = 0;
  assert.deepEqual(f.nav.view(), []); assert.equal(f.nav.picking, false);
  assert.equal(f.nav.handle("down", active), false);
});

test("settled idle dock collapses but expanding retains every task and exact recipient", () => {
  const f = fixture();
  for (const item of f.threads) { item.state = "completed"; item.updatedAt = Date.now() - 6000; }
  assert.equal(f.nav.view().length, 1);
  assert.match(f.nav.render()[0], /2 subagents completed/);
  f.nav.handle("left", active); f.nav.handle("down", active);
  assert.match(f.nav.render().join("\n"), /›.*map/);
  f.nav.handle("enter", active);
  assert.deepEqual(f.opened, [{ path: "/root/map", identity: "/root/map" }]);
  f.nav.handle("escape", active);
  assert.equal(f.nav.view().length, 1);
  assert.equal(f.threads.length, 2, "collapse must not reap retained sessions");
});

test("completion grace expires without collapsing an active selection", () => {
  const f = fixture();
  f.nav.handle("left", active); f.nav.handle("down", active);
  f.threads[0].state = "completed"; f.threads[0].updatedAt = Date.now() - 6000;
  assert.match(f.nav.render().join("\n"), /›.*map/);
  f.nav.handle("down", active); f.nav.handle("enter", active);
  assert.equal(f.opened[0].path, "/root/review");
  f.nav.handle("escape", active);
  assert.doesNotMatch(f.nav.render().join("\n"), /✓ map/);
  assert.match(f.nav.render().join("\n"), /review/);
});
