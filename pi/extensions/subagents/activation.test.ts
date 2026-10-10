import assert from "node:assert/strict";
import test from "node:test";
import extension, { activationDecision, isolatedProfile } from "./index.ts";
test("package auto-load stays inert even with an enable flag when companion is installed", async () => {
  const calls: string[] = [];
  const api = new Proxy({}, { get(_target, key) { calls.push(String(key)); throw new Error("inactive extension touched Pi API"); } });
  const previous = process.env.PI_SETUP_SUBAGENTS_ENABLED;
  try {
    process.env.PI_SETUP_SUBAGENTS_ENABLED = "1";
    await extension(api as never);
    assert.deepEqual(calls, []);
    assert.deepEqual(activationDecision({ requested: true, companionPresent: true }), { enabled: false, reason: "companion_conflict" });
    assert.deepEqual(activationDecision({ requested: true, companionPresent: false }), { enabled: true, reason: "explicit_native_activation" });
  } finally {
    if (previous === undefined) delete process.env.PI_SETUP_SUBAGENTS_ENABLED;
    else process.env.PI_SETUP_SUBAGENTS_ENABLED = previous;
  }
});
test("temporary isolated activation profile excludes companion, extra resources and live writes", () => {
  assert.deepEqual(isolatedProfile(), { temporaryHomeOnly: true, packageSources: ["@irfansofyana/pi-setup", "@ff-labs/pi-fff"], extensionResources: ["subagents", "web-research", "headroom", "fff"], active: false });
});
