import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  buildCavemanPrompt,
  configText,
  normalizeActiveLevel,
  normalizeCavemanConfig,
  normalizeLevel,
  parseBoolean,
  parseCavemanCommand,
  promptTriggerDecision,
  statusText,
} from "./index.ts";

test("normalize level accepts known levels only", () => {
  assert.equal(normalizeLevel("FULL"), "full");
  assert.equal(normalizeLevel(" micro "), "micro");
  assert.equal(normalizeLevel("wenyan"), undefined);
  assert.equal(normalizeActiveLevel("off"), undefined);
  assert.equal(normalizeActiveLevel("ultra"), "ultra");
});

test("parseBoolean accepts config-friendly values", () => {
  assert.equal(parseBoolean(true), true);
  assert.equal(parseBoolean("on"), true);
  assert.equal(parseBoolean("disable"), false);
  assert.equal(parseBoolean("wat"), undefined);
});

test("normalize config fills defaults and maps legacy showFooter", () => {
  assert.deepEqual(normalizeCavemanConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(normalizeCavemanConfig({ defaultLevel: "lite", showFooter: false, autoTrigger: false, triggerLevel: "micro" }), {
    defaultLevel: "lite",
    showStatus: false,
    autoTrigger: false,
    triggerLevel: "micro",
  });
  assert.deepEqual(normalizeCavemanConfig({ defaultLevel: "bad", triggerLevel: "off" }), DEFAULT_CONFIG);
});

test("parse command handles toggles and direct levels", () => {
  assert.deepEqual(parseCavemanCommand(""), { kind: "toggle" });
  assert.deepEqual(parseCavemanCommand("full"), { kind: "set-level", level: "full" });
  assert.deepEqual(parseCavemanCommand("normal"), { kind: "set-level", level: "off" });
  assert.deepEqual(parseCavemanCommand("status"), { kind: "status" });
});

test("parse command handles config writes", () => {
  assert.deepEqual(parseCavemanCommand("default off"), { kind: "set-default", level: "off" });
  assert.deepEqual(parseCavemanCommand("config default ultra"), { kind: "set-default", level: "ultra" });
  assert.deepEqual(parseCavemanCommand("status-bar off"), { kind: "set-status", showStatus: false });
  assert.deepEqual(parseCavemanCommand("config auto-trigger on"), { kind: "set-auto-trigger", autoTrigger: true });
  assert.deepEqual(parseCavemanCommand("trigger-level micro"), { kind: "set-trigger-level", triggerLevel: "micro" });
  assert.match((parseCavemanCommand("trigger-level off") as { message: string }).message, /trigger-level/);
});

test("prompt builder preserves code and exact-data instructions", () => {
  const prompt = buildCavemanPrompt("full");
  assert.match(prompt, /Code blocks unchanged/);
  assert.match(prompt, /JSON\/YAML\/TOML unchanged/);
  assert.match(prompt, /Errors, file paths, flags, API names, function names quoted exact/);
  assert.equal(buildCavemanPrompt("off"), "");
  assert.match(buildCavemanPrompt("micro"), /Token efficiency/);
});

test("natural prompt triggers can start or stop caveman", () => {
  assert.equal(promptTriggerDecision("please be brief", DEFAULT_CONFIG), "full");
  assert.equal(promptTriggerDecision("normal mode for this answer", DEFAULT_CONFIG), "off");
  assert.equal(promptTriggerDecision("please be brief", { ...DEFAULT_CONFIG, autoTrigger: false }), undefined);
  assert.equal(promptTriggerDecision("short answers", { ...DEFAULT_CONFIG, triggerLevel: "micro" }), "micro");
});

test("status and config text expose important knobs", () => {
  assert.equal(statusText("full", DEFAULT_CONFIG), "level=full default=full status=on auto-trigger=on trigger-level=full");
  assert.match(configText(DEFAULT_CONFIG), /Config path:/);
  assert.match(configText(DEFAULT_CONFIG), /\/caveman default/);
});
