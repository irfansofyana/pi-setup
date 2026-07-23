import assert from "node:assert/strict";
import test from "node:test";

import { createLoopGoalDriver } from "./goal-adapter.ts";

class FakeEventBus {
  handlers = new Map<string, Set<(value: unknown) => void>>();

  on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

test("Goal driver claim and release use request-scoped replies", async () => {
  const events = new FakeEventBus();
  events.on("goal-loop:driver:request", (value) => {
    const request = value as Record<string, unknown>;
    events.emit(`goal-loop:driver:response:${request.requestId}`, { ok: true });
  });
  const driver = createLoopGoalDriver({ events });
  const claim = { projectRoot: "/repo", sessionId: "session-1", generation: 1 };
  assert.deepEqual(await driver.claim(claim), { ok: true });
  await driver.release(claim);
});

test("Goal driver fails closed when coordinator rejects claim", async () => {
  const events = new FakeEventBus();
  events.on("goal-loop:driver:request", (value) => {
    const request = value as Record<string, unknown>;
    events.emit(`goal-loop:driver:response:${request.requestId}`, { ok: false, reason: "active goal" });
  });
  const driver = createLoopGoalDriver({ events });
  assert.deepEqual(
    await driver.claim({ projectRoot: "/repo", sessionId: "session-1", generation: 1 }),
    { ok: false, reason: "active goal" },
  );
});
