import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/prefs/config.ts";
import { dialogHeight, type DialogRow } from "../src/ui/dialog.ts";
import { AGENT_LOADERS } from "../src/ui/agent-loader.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { configureAgents } from "../src/ui/settings-ui.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
  LOADER_STYLES,
  type ManagerSettings,
} from "../src/prefs/settings.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
type Menu = { title: string; rows: DialogRow[] };

/** Runs configureAgents with scripted menu/input choices and reports what reached disk. */
async function run(
  t: TestContext,
  actions: (string | undefined)[],
  { settings = DEFAULT_MANAGER_SETTINGS, trusted = false, width = 80, root: existingRoot, agentDir: existingAgentDir } = {} as {
    settings?: ManagerSettings;
    trusted?: boolean;
    width?: number;
    root?: string;
    agentDir?: string;
  },
) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "pi-settings-ui-"));
  if (!existingRoot) t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = existingAgentDir ?? root;
  const notifications: string[] = [];
  const menus: Menu[] = [];
  const driver = createDialogDriver({
    theme,
    width,
    choices: actions,
    unified: true,
    assertBorder: true,
    onOpen: (options) => assert.equal((options as { overlay?: boolean }).overlay, true),
    onMenu: (menu) =>
      menus.push({
        title: menu.title,
        rows: menu.rows.map((row) => ({ ...row })),
      }),
  });
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui: { notify: (message: string) => notifications.push(message), custom: driver.custom },
  } as unknown as ExtensionCommandContext;
  let applied = 0;
  await configureAgents(ctx, {
    store: new ConfigStore({ cwd: root, agentDir, includeProject: false }),
    agentDir,
    settings: { ...settings },
    apply: () => applied++,
  });
  // Every settings flow stays inside one outer overlay with a fixed frame height.
  assert.equal(driver.stats.outerOpens, 1);
  assert.equal(driver.stats.outerCompletions, 1);
  assert.equal(driver.stats.forcedRenders, 0);
  const height = dialogHeight({ requestRender() {}, terminal: { rows: 24 } });
  assert.ok(driver.stats.frameHeights.every((frame) => frame === height));
  const value = (menu: number, id: string) => menus[menu]?.rows.find((row) => row.id === id)?.value;
  return {
    root,
    applied,
    notifications,
    menus,
    renders: driver.renders,
    value,
    loaded: loadManagerSettings({ cwd: root, agentDir, includeProject: true }),
    userFile: join(agentDir, "subagent-manager", "settings.json"),
    projectFile: join(root, ".pi", "agent", "subagent-manager", "settings.json"),
  };
}

test("[labs] Loader style previews all families and states together, and saves every selection", async (t) => {
  for (const loaderStyle of LOADER_STYLES) {
    const result = await run(t, ["loaderStyle", loaderStyle, "save"]);
    const chooser = result.menus[1]!;
    assert.equal(result.menus[0]!.rows.find((row) => row.id === "loaderStyle")!.label, "[labs] Loader style");
    assert.equal(result.value(0, "loaderStyle"), "Circle");
    assert.equal(chooser.title, "[labs] Loader style");
    assert.deepEqual(chooser.rows.map((row) => row.id), [...LOADER_STYLES]);
    const preview = result.renders.find((lines) => lines[0]?.includes("[labs] Loader style"))!;
    assert.ok(preview, "loader picker rendered");
    const text = stripTerminalSequences(preview.join("\n"));
    for (const row of chooser.rows) {
      const loader = AGENT_LOADERS[row.id as typeof loaderStyle];
      assert.ok(text.includes(loader.label), `${loader.label} visible alongside other options`);
      for (const glyph of [...loader.frames, ...Object.values(loader.states)]) {
        assert.ok(row.value!.includes(glyph));
        assert.ok(text.includes(glyph), `${row.id} preview ${glyph} visible`);
      }
      for (const state of ["Starting/running", "Completed", "Paused", "Failed", "Stopped"]) {
        assert.ok(row.help!.includes(state));
      }
    }
    assert.ok(text.includes("completed, paused, failed, stopped"), "visible preview legend");
    assert.equal(result.loaded.settings.loaderStyle, loaderStyle);
    assert.equal(result.applied, 1);
    assert.equal(result.value(2, "loaderStyle"), AGENT_LOADERS[loaderStyle].label);
  }
});

test("[labs] Loader style cancel, restore-defaults and narrow layouts preserve draft semantics", async (t) => {
  const cancelled = await run(t, ["loaderStyle", "braille", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
  const chooserCancelled = await run(t, ["loaderStyle", undefined, "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, loaderStyle: "hourglass" },
  });
  assert.equal(chooserCancelled.loaded.settings.loaderStyle, "hourglass");
  const restored = await run(t, ["defaults", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, loaderStyle: "braille" },
  });
  assert.equal(restored.loaded.settings.loaderStyle, "circle");
  for (const width of [20, 40, 60]) {
    const result = await run(t, ["loaderStyle", "hourglass", "save"], { width, trusted: true });
    assert.equal(result.loaded.settings.loaderStyle, "hourglass");
    assert.ok(result.renders.every((lines) => lines.every((line) => visibleWidth(line) <= width)));
  }
});

test("[labs] Nerd Font setting toggles, persists, and cancels without saving", async (t) => {
  const enabled = await run(t, ["nerdFontIcons", "save"]);
  const field = enabled.menus[0]!.rows.find((row) => row.id === "nerdFontIcons")!;
  assert.equal(field.label, "[labs] Nerd Font icons");
  assert.equal(field.value, "Off");
  assert.equal(enabled.loaded.settings.nerdFontIcons, true);
  assert.equal(enabled.applied, 1);
  const disabled = await run(t, ["nerdFontIcons", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, nerdFontIcons: true },
  });
  assert.equal(disabled.loaded.settings.nerdFontIcons, false);
  const cancelled = await run(t, ["nerdFontIcons", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
});

test("invalid numbers are rejected in place and valid edits save once to the user scope", async (t) => {
  const result = await run(t, ["maxLevels", "33", "maxLevels", "0", "maxLevels", "5", "save"]);
  assert.equal(result.applied, 1);
  assert.equal(result.loaded.settings.maxLevels, 5);
  assert.equal(result.notifications.filter((message) => message.includes("at most 32")).length, 2);
  assert.ok(result.notifications.some((message) => message.includes(result.userFile)));
  assert.equal(existsSync(result.projectFile), false);
});

test("selecting each subagent mode saves it", async (t) => {
  for (const [mode, label] of [
    ["off", "Off"],
    ["opportunistic", "Opportunistic"],
    ["orchestration", "Orchestration"],
  ]) {
    const result = await run(t, ["subagentMode", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "subagentMode")!;
    assert.equal(field.label, "Subagent Mode");
    assert.equal(field.value, "Opportunistic");
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Subagent Mode");
    assert.deepEqual(chooser.rows.map((row) => row.id), ["off", "opportunistic", "orchestration"]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "subagentMode"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.subagentMode, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).subagentMode, mode);
  }
});

test("mode selection and chooser cancellation remain draft-only", async (t) => {
  const canceled = await run(t, ["subagentMode", "off", "cancel"]);
  assert.equal(canceled.value(2, "subagentMode"), "Off");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["subagentMode", undefined, "save"]);
  assert.equal(escaped.value(2, "subagentMode"), "Opportunistic");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.subagentMode, "opportunistic");
});

for (const width of [32, 80]) {
  test(`mode screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["subagentMode", "orchestration", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Subagent Mode") || lines[0]!.includes("Agents settings"),
    ));
    // The shared two-column menu clips labels at narrow widths; the selected
    // mode's full name remains visible in its help and in the settings value.
    assert.ok(result.renders[1]!.join("\n").includes(width === 32 ? "Orchestra" : "Orchestration"));
    assert.ok(result.renders[2]!.join("\n").includes("Orchestration"));
  });
}

test("Model Picking saves all three modes", async (t) => {
  for (const [mode, label] of [
    ["pick-first-available", "Pick First (available)"],
    ["pick-first-scoped", "Pick First (scoped)"],
    ["use-current", "Use Current"],
  ]) {
    const result = await run(t, ["modelSelection", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "modelSelection")!;
    assert.equal(field.label, "Model Picking");
    assert.equal(field.value, "Pick First (scoped)");
    assert.equal(result.menus[0]!.rows.some((row) => row.id === "scopedModelFiltering"), false);
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Model Picking");
    assert.deepEqual(chooser.rows.map((row) => row.id), [
      "pick-first-available", "pick-first-scoped", "use-current",
    ]);
    assert.deepEqual(chooser.rows.map((row) => row.label), [
      "Pick First (available)", "Pick First (scoped)", "Use Current",
    ]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "modelSelection"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.modelSelection, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    const stored = JSON.parse(readFileSync(result.userFile, "utf8"));
    assert.equal(stored.modelSelection, mode);
    assert.equal(Object.hasOwn(stored, "scopedModelFiltering"), false);
  }
});

test("Model Picking and other edits stay draft-only until save; chooser cancellation keeps the value", async (t) => {
  const canceled = await run(t, ["modelSelection", "pick-first-available", "maxLevels", "4", "cancel"]);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.equal(canceled.value(0, "modelSelection"), "Pick First (scoped)");
  assert.equal(canceled.value(2, "modelSelection"), "Pick First (available)");
  assert.match(canceled.menus[2]?.title ?? "", /unsaved/);
  assert.equal(canceled.value(3, "maxLevels"), "4");

  const escaped = await run(t, ["modelSelection", undefined, "save"]);
  assert.equal(escaped.value(2, "modelSelection"), "Pick First (scoped)");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.modelSelection, "pick-first-scoped");
});

test("Model Picking saves to a trusted project", async (t) => {
  const saved = await run(t, ["modelSelection", "use-current", "save"], { trusted: true });
  assert.equal(saved.applied, 1);
  assert.equal(saved.loaded.settings.modelSelection, "use-current");
  assert.equal(JSON.parse(readFileSync(saved.projectFile, "utf8")).modelSelection, "use-current");
  assert.equal(existsSync(saved.userFile), false);
});

test("save shows a warning-colored changes value only while the draft is dirty", async (t) => {
  const result = await run(t, [
    "modelSelection", "pick-first-available", "modelSelection", "pick-first-scoped",
    "maxLevels", "5", "defaults", "cancel",
  ]);
  const settingsMenus = result.menus.filter((menu) => menu.title.startsWith("Agents settings"));
  const save = (index: number) => settingsMenus[index]!.rows.find((row) => row.id === "save")!;
  for (const index of [0, 2, 4]) {
    assert.equal(save(index).value, undefined, "unchanged or reverted drafts clear the indicator");
    assert.equal(save(index).valueColor, undefined);
  }
  for (const index of [1, 3]) {
    assert.equal(save(index).label, "Save and apply");
    assert.equal(save(index).value, "(changes)");
    assert.equal(save(index).valueColor, "warning");
  }
});

for (const width of [32, 80]) {
  test(`Model Picking screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["modelSelection", "use-current", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Model Picking") || lines[0]!.includes("Agents settings"),
    ));
    assert.equal(result.value(2, "modelSelection"), "Use Current");
    assert.ok(result.renders[2]!.join("\n").includes("Use Current"));
  });
}

test("changing save scope preserves the draft without saving on cancel", async (t) => {
  const result = await run(t, ["maxLevels", "5", "scope", "scope", "cancel"], { trusted: true });
  for (const index of [1, 2, 3]) {
    assert.equal(result.value(index, "maxLevels"), "5");
  }
  assert.equal(result.value(1, "scope"), "Current Project");
  assert.equal(result.value(2, "scope"), "Global");
  assert.equal(result.value(3, "scope"), "Current Project");
  assert.equal(result.applied, 0);
  assert.equal(existsSync(result.userFile), false);
  assert.equal(existsSync(result.projectFile), false);
});

test("restore defaults resets the whole draft before save", async (t) => {
  const result = await run(t, ["defaults", "save"], {
    settings: {
      ...DEFAULT_MANAGER_SETTINGS,
      subagentMode: "orchestration",
      toolFiltering: "all",
      modelSelection: "use-current",
      maxLevels: 9,
    },
  });
  assert.equal(result.applied, 1);
  assert.equal(result.value(1, "modelSelection"), "Pick First (scoped)");
  assert.equal(result.value(1, "subagentMode"), "Opportunistic");
  assert.equal(result.value(1, "toolFiltering"), "Allowed (except blocked)");
  assert.deepEqual(result.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.match(readFileSync(result.userFile, "utf8"), /"modelSelection": "pick-first-scoped"/);
});

test("project scope requires trust; trusted projects save to the project file", async (t) => {
  const untrusted = await run(t, ["scope", "maxThreads", "2", undefined]);
  assert.equal(untrusted.applied, 0);
  assert.ok(untrusted.notifications.some((message) => message.includes("trusted project")));
  assert.deepEqual(untrusted.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const trusted = await run(t, ["subagentMode", "off", "maxThreads", "9", "save"], { trusted: true });
  assert.equal(trusted.applied, 1);
  assert.equal(trusted.loaded.settings.maxThreads, 9);
  assert.equal(trusted.loaded.settings.subagentMode, "off");
  assert.equal(existsSync(trusted.projectFile), true);
  assert.equal(existsSync(trusted.userFile), false);

  const toggled = await run(t, ["scope", "save"], { trusted: true });
  assert.equal(toggled.value(0, "scope"), "Current Project");
  assert.equal(toggled.value(1, "scope"), "Global");
  assert.equal(existsSync(toggled.userFile), true);
  assert.equal(existsSync(toggled.projectFile), false);
});

test("Global save scope sticks across reopenings and projects without changing precedence", async (t) => {
  const initial = await run(t, ["save"], {
    trusted: true,
    settings: { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 7 },
  });
  const global = await run(t, ["scope", "maxLevels", "5", "save"], {
    trusted: true,
    root: initial.root,
  });
  assert.equal(global.value(1, "scope"), "Global");
  assert.equal(JSON.parse(readFileSync(global.userFile, "utf8")).maxLevels, 5);
  assert.equal(global.loaded.settings.maxLevels, 7); // Project override still wins.
  assert.deepEqual(global.loaded.diagnostics, []);

  const reopened = await run(t, ["cancel"], { trusted: true, root: initial.root });
  assert.equal(reopened.value(0, "scope"), "Global");
  const otherProject = await run(t, ["save"], { trusted: true, agentDir: initial.root });
  assert.equal(otherProject.value(0, "scope"), "Global");
  assert.equal(existsSync(otherProject.projectFile), false);
});

test("scope selection persists even on cancel; untrusted fallback does not overwrite it", async (t) => {
  const global = await run(t, ["scope", "cancel"], { trusted: true });
  assert.equal(existsSync(global.userFile), false);
  assert.equal(existsSync(global.projectFile), false);
  const project = await run(t, ["scope", "cancel"], { trusted: true, root: global.root });
  assert.equal(project.value(0, "scope"), "Global");
  assert.equal(project.value(1, "scope"), "Current Project");
  const untrusted = await run(t, ["scope", "save"], { root: global.root });
  assert.equal(untrusted.value(0, "scope"), "Global");
  assert.ok(untrusted.notifications.some((message) => message.includes("trusted project")));
  assert.equal(existsSync(untrusted.projectFile), false);
  const trustedAgain = await run(t, ["cancel"], { trusted: true, root: global.root });
  assert.equal(trustedAgain.value(0, "scope"), "Current Project");
});

test("Tool Filtering saves every mode", async (t) => {
  for (const [mode, label] of [
    ["allowed", "Allowed (except blocked)"],
    ["all-except-blocked", "All except blocked"],
    ["all", "All"],
  ]) {
    const result = await run(t, ["toolFiltering", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "toolFiltering")!;
    assert.equal(field.label, "Tool Filtering");
    assert.equal(field.value, "Allowed (except blocked)");
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Tool Filtering");
    assert.deepEqual(
      chooser.rows.map((row) => row.id),
      ["allowed", "all-except-blocked", "all"],
    );
    assert.deepEqual(
      chooser.rows.map((row) => row.label),
      ["Allowed (except blocked)", "All except blocked", "All"],
    );
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "toolFiltering"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.toolFiltering, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).toolFiltering, mode);
  }
});

test("Tool Filtering selection and chooser cancellation remain draft-only", async (t) => {
  const canceled = await run(t, ["toolFiltering", "all", "cancel"]);
  assert.equal(canceled.value(2, "toolFiltering"), "All");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["toolFiltering", undefined, "save"]);
  assert.equal(escaped.value(2, "toolFiltering"), "Allowed (except blocked)");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.toolFiltering, "allowed");
});

test("Tool Filtering saves to a trusted project and restores defaults without saving on cancel", async (t) => {
  const saved = await run(t, ["toolFiltering", "all-except-blocked", "save"], { trusted: true });
  assert.equal(saved.applied, 1);
  assert.equal(saved.loaded.settings.toolFiltering, "all-except-blocked");
  assert.equal(
    JSON.parse(readFileSync(saved.projectFile, "utf8")).toolFiltering,
    "all-except-blocked",
  );
  assert.equal(existsSync(saved.userFile), false);

  const restored = await run(t, ["toolFiltering", "all", "defaults", "cancel"]);
  assert.equal(restored.value(2, "toolFiltering"), "All");
  assert.equal(restored.value(3, "toolFiltering"), "Allowed (except blocked)");
  assert.doesNotMatch(restored.menus[3]!.title, /unsaved/);
  assert.equal(restored.applied, 0);
  assert.equal(existsSync(restored.userFile), false);
});

for (const width of [32, 80]) {
  test(`Tool Filtering screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["toolFiltering", "all", "cancel"], { width });
    assert.ok(
      result.renders.every(
        (lines) => lines[0]!.includes("Tool Filtering") || lines[0]!.includes("Agents settings"),
      ),
    );
    assert.ok(result.renders[1]!.join("\n").includes("All"));
    assert.equal(result.value(2, "toolFiltering"), "All");
  });
}

test("Status Widget saves each mode", async (t) => {
  for (const [mode, label] of [["full", "Full"], ["minimal", "Minimal"]]) {
    const result = await run(t, ["widgetMode", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "widgetMode")!;
    assert.equal(field.label, "Status Widget");
    assert.equal(field.value, "Full");
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Status Widget");
    assert.deepEqual(chooser.rows.map((row) => row.id), ["full", "minimal"]);
    assert.deepEqual(chooser.rows.map((row) => row.label), ["Full", "Minimal"]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "widgetMode"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.widgetMode, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).widgetMode, mode);
  }
});

test("Status Widget cancellation leaves settings unchanged and defaults restore Full", async (t) => {
  const canceled = await run(t, ["widgetMode", "minimal", "cancel"]);
  assert.equal(canceled.value(2, "widgetMode"), "Minimal");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["widgetMode", undefined, "save"]);
  assert.equal(escaped.value(2, "widgetMode"), "Full");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.widgetMode, "full");

  const restored = await run(t, ["defaults", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, widgetMode: "minimal" },
  });
  assert.equal(restored.value(1, "widgetMode"), "Full");
  assert.equal(restored.loaded.settings.widgetMode, "full");
});

test("Status Widget saves to a trusted project", async (t) => {
  const result = await run(t, ["widgetMode", "minimal", "save"], { trusted: true });
  assert.equal(result.applied, 1);
  assert.equal(JSON.parse(readFileSync(result.projectFile, "utf8")).widgetMode, "minimal");
  assert.equal(existsSync(result.userFile), false);
});

for (const width of [32, 80]) {
  test(`Status Widget screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["widgetMode", "minimal", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Status Widget") || lines[0]!.includes("Agents settings"),
    ));
    assert.ok(result.renders[1]!.join("\n").includes("Full"));
    assert.ok(result.renders[1]!.join("\n").includes("Minimal"));
    assert.equal(result.value(2, "widgetMode"), "Minimal");
  });
}

test("[labs] Final Recap toggles and saves to both scopes", async (t) => {
  const enabled = await run(t, ["finalRecap", "save"]);
  const field = enabled.menus[0]!.rows.find((row) => row.id === "finalRecap")!;
  assert.equal(field.label, "[labs] Final Recap");
  assert.equal(field.value, "Off");
  assert.equal(enabled.value(1, "finalRecap"), "On");
  assert.match(enabled.menus[1]!.title, /unsaved/);
  assert.equal(enabled.applied, 1);
  assert.equal(enabled.loaded.settings.finalRecap, true);
  assert.equal(JSON.parse(readFileSync(enabled.userFile, "utf8")).finalRecap, true);

  const disabled = await run(t, ["finalRecap", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, finalRecap: true }, trusted: true,
  });
  assert.equal(disabled.value(1, "finalRecap"), "Off");
  assert.equal(disabled.loaded.settings.finalRecap, false);
  assert.equal(disabled.applied, 1);
  assert.equal(JSON.parse(readFileSync(disabled.projectFile, "utf8")).finalRecap, false);
  assert.equal(existsSync(disabled.userFile), false);
});

test("[labs] Final Recap cancellation, toggle reversal and restore-defaults keep it opt-in", async (t) => {
  const cancelled = await run(t, ["finalRecap", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
  assert.equal(cancelled.loaded.settings.finalRecap, false);
  const reverted = await run(t, ["finalRecap", "finalRecap", "save"]);
  assert.doesNotMatch(reverted.menus[2]!.title, /unsaved/);
  assert.equal(reverted.loaded.settings.finalRecap, false);
  const restored = await run(t, ["defaults", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, finalRecap: true },
  });
  assert.equal(restored.value(1, "finalRecap"), "Off");
  assert.equal(restored.loaded.settings.finalRecap, false);
});

for (const width of [32, 80]) {
  test(`[labs] Final Recap renders a bordered settings frame at width ${width}`, async (t) => {
    const result = await run(t, ["finalRecap", "cancel"], { width });
    assert.ok(result.renders.every((lines) => lines[0]!.includes("Agents settings")));
    assert.equal(result.value(1, "finalRecap"), "On");
  });
}


test("[labs] Cost display offers and saves all three transports", async (t) => {
  for (const mode of ["pi-footer-event", "pi-footer-status", "pi-status"] as const) {
    const result = await run(t, ["costDisplay", mode, "save"]);
    assert.equal(result.menus[1]!.title, "[labs] Cost display");
    assert.deepEqual(result.menus[1]!.rows.map((row) => row.id), ["pi-footer-event", "pi-footer-status", "pi-status"]);
    assert.equal(result.value(0, "costDisplay"), "pi-footer status key");
    assert.equal(result.loaded.settings.costDisplay, mode);
    assert.equal(result.applied, 1);
  }
});

