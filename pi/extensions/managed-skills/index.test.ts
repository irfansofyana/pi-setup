import assert from "node:assert/strict";
import test from "node:test";

import managedSkillsExtension, {
  DEFAULT_CONFIG,
  autoCaptureDeliveryOptions,
  normalizeManagedSkillsConfig,
  sanitizeSkillName,
} from "./index.ts";

test("entry point exposes the Pi extension and stable helper exports", () => {
  assert.equal(typeof managedSkillsExtension, "function");
  assert.equal(sanitizeSkillName(" Demo "), "demo");
  assert.deepEqual(autoCaptureDeliveryOptions(), { deliverAs: "followUp", triggerTurn: true });
  assert.deepEqual(normalizeManagedSkillsConfig({}), DEFAULT_CONFIG);
});
