import assert from "node:assert/strict";
import test from "node:test";

import { GoalDriverRegistry, parseGoalDriverRequest, type GoalDriverRequest } from "./driver.ts";

const request: GoalDriverRequest = {
  requestId: "request-1",
  action: "claim",
  owner: "loop",
  projectRoot: "/repo",
  sessionId: "session-1",
  generation: 1,
};

test("driver claim is idempotent and blocks competing ownership", () => {
  const registry = new GoalDriverRegistry();
  assert.equal(registry.handle(request, false).ok, true);
  assert.equal(registry.handle({ ...request, requestId: "request-2" }, false).ok, true);
  const conflict = registry.handle({ ...request, requestId: "request-3", sessionId: "session-2" }, false);
  assert.equal(conflict.ok, false);
  assert.match((conflict as { reason: string }).reason, /Another loop driver/);
});

test("driver refuses claim while an active goal exists", () => {
  const registry = new GoalDriverRegistry();
  const result = registry.handle(request, true);
  assert.equal(result.ok, false);
  assert.equal(registry.current(), undefined);
});

test("release requires matching generation and session", () => {
  const registry = new GoalDriverRegistry();
  registry.handle(request, false);
  assert.equal(registry.handle({ ...request, action: "release", generation: 2 }, false).ok, false);
  assert.equal(registry.isClaimed("/repo"), true);
  assert.equal(registry.handle({ ...request, action: "release" }, false).ok, true);
  assert.equal(registry.current(), undefined);
});

test("session shutdown releases matching claim", () => {
  const registry = new GoalDriverRegistry();
  registry.handle(request, false);
  registry.releaseSession("other");
  assert.equal(registry.isClaimed("/repo"), true);
  registry.releaseSession("session-1");
  assert.equal(registry.current(), undefined);
});

test("request parser rejects malformed or unsupported payloads", () => {
  assert.deepEqual(parseGoalDriverRequest(request), request);
  assert.equal(parseGoalDriverRequest({ ...request, owner: "other" }), undefined);
  assert.equal(parseGoalDriverRequest({ ...request, generation: 0 }), undefined);
  assert.equal(parseGoalDriverRequest({ ...request, action: "delete" }), undefined);
});
