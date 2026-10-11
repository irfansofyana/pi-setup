import test from "node:test";
import assert from "node:assert/strict";
import { taskReminder } from "./task-reminder.ts";
import type { ThreadView } from "./upstream/src/types.ts";

const thread: ThreadView = { path: "/root/research", type: "researcher", parent: "/root", owner: "/root",
  task: "Find release notes", state: "running", status: "Tool: web_fetch", createdAt: 1000,
  lastStartedAt: 1000, updatedAt: 113000 };

test("reporting reminders describe observed work without claiming failure or inactivity", () => {
  const reminder = taskReminder(thread, "running", 121000)!;
  assert.equal(reminder.level, "info");
  assert.match(reminder.message, /still working.*elapsed 2m/);
  assert.match(reminder.message, /status updated 8s ago/);
  assert.match(reminder.message, /Tool: web_fetch/);
  assert.match(reminder.message, /execution continues/);
  assert.doesNotMatch(reminder.message, /timeout|stalled|failed|Warning/i);
});

test("queued reminders distinguish admission waiting from tool execution", () => {
  const reminder = taskReminder(thread, "queued", 61000)!;
  assert.match(reminder.message, /queued.*waiting for an execution slot/);
  assert.doesNotMatch(reminder.message, /web_fetch|still working/);
});

test("settled tasks do not generate late reporting reminders", () => {
  for (const state of ["completed", "failed", "stopped", "paused"] as const) {
    assert.equal(taskReminder({ ...thread, state }, undefined, 121000), undefined);
  }
});

test("reminders sanitize status text and clamp clock skew", () => {
  const reminder = taskReminder({ ...thread, status: "\x1b[31mreading\x1b[0m\nfiles" }, "running", 0)!;
  assert.doesNotMatch(reminder.message, /\x1b|\n|-\d/);
  assert.match(reminder.message, /elapsed 0s/);
});
