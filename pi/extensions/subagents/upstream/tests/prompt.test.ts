import assert from "node:assert/strict";
import test from "node:test";
import { subagentPrompt } from "../src/orch/prompt.ts";
import { DEFAULT_MANAGER_SETTINGS } from "../src/prefs/settings.ts";

test("off produces no subagent system prompt", () => {
  assert.equal(subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode: "off" }), undefined);
});

for (const subagentMode of ["opportunistic", "orchestration"] as const) {
  test(`${subagentMode} produces a subagent system prompt`, () => {
    const prompt = subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode });
    assert.equal(typeof prompt, "string");
    assert.ok(prompt!.trim().length > 0);
  });
}

