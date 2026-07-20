import assert from "node:assert/strict";
import test from "node:test";
import type { Stats } from "node:fs";

import { classifyFileEvent } from "./event-watcher.ts";

function stats(input: { exists: boolean; mtimeMs?: number; ctimeMs?: number; size?: number }): Stats {
  return {
    nlink: input.exists ? 1 : 0,
    mtimeMs: input.mtimeMs ?? 0,
    ctimeMs: input.ctimeMs ?? 0,
    size: input.size ?? 0,
  } as Stats;
}

test("classifyFileEvent detects create change and delete", () => {
  assert.equal(classifyFileEvent(stats({ exists: true }), stats({ exists: false })), "create");
  assert.equal(classifyFileEvent(stats({ exists: false }), stats({ exists: true })), "delete");
  assert.equal(classifyFileEvent(
    stats({ exists: true, mtimeMs: 2, size: 10 }),
    stats({ exists: true, mtimeMs: 1, size: 9 }),
  ), "change");
  assert.equal(classifyFileEvent(stats({ exists: true }), stats({ exists: true })), undefined);
  assert.equal(classifyFileEvent(stats({ exists: false }), stats({ exists: false })), undefined);
});
