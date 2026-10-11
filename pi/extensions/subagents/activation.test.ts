import assert from "node:assert/strict";
import test from "node:test";
import extension, { activationDecision } from "./index.ts";
test("explicit environment opt-out keeps package auto-load inert", async () => {
  const calls: string[] = [];
  const api = new Proxy({}, { get(_target, key) { calls.push(String(key)); throw new Error("inactive extension touched Pi API"); } });
  const previous = process.env.PI_SETUP_SUBAGENTS_NATIVE;
  try {
    process.env.PI_SETUP_SUBAGENTS_NATIVE = "0";
    await extension(api as never);
    assert.deepEqual(calls, []);
    assert.deepEqual(activationDecision({ requested: true, companionPresent: true }), { enabled: false, reason: "companion_conflict" });
    assert.deepEqual(activationDecision({ requested: true, companionPresent: false }), { enabled: true, reason: "explicit_native_activation" });
  } finally {
    if (previous === undefined) delete process.env.PI_SETUP_SUBAGENTS_NATIVE;
    else process.env.PI_SETUP_SUBAGENTS_NATIVE = previous;
  }
});
test("removed preview flag cannot bypass explicit native opt-out", async () => {
  const previous = { native: process.env.PI_SETUP_SUBAGENTS_NATIVE, preview: process.env.PI_SETUP_SUBAGENTS_PREVIEW };
  try {
    process.env.PI_SETUP_SUBAGENTS_NATIVE = "0";
    process.env.PI_SETUP_SUBAGENTS_PREVIEW = "1";
    await extension(new Proxy({}, { get() { throw Error("removed preview activated"); } }) as never);
  } finally {
    for (const [key, value] of [["PI_SETUP_SUBAGENTS_NATIVE", previous.native], ["PI_SETUP_SUBAGENTS_PREVIEW", previous.preview]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
