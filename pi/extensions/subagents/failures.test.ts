import assert from "node:assert/strict";
import test from "node:test";
import { failureCodes, failureSummary, runFailure } from "./failures.ts";

test("known startup rejection codes survive without raw exception text", () => {
  for (const code of failureCodes) {
    const failure = runFailure(Error(code));
    assert.deepEqual(failure, { code });
    assert.ok(failureSummary(failure).startsWith(`${code}:`));
    assert.ok(Object.isFrozen(failure));
  }
});

test("unrecognized errors cannot expose provider response bodies or credentials", () => {
  const failure = runFailure(Error("private provider response body"));
  assert.deepEqual(failure, { code: "execution_failed" });
  assert.ok(!JSON.stringify(failure).includes("private"));
  assert.deepEqual(runFailure("unsupported_provider"), { code: "execution_failed" });
});
