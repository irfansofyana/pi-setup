import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { ConfigStore, parseAgentType, serializeAgentType } from "../src/prefs/config.ts";
import { DEFAULT_MANAGER_SETTINGS, loadManagerSettings, saveManagerSettings } from "../src/prefs/settings.ts";
import { ThreadManager } from "../src/orch/manager.ts";
import { agentTypeBadge, agentTypeLabel, renderAgentTree, renderThreads, updateWidget } from "../src/ui/ui.ts";
import { StatusDialog } from "../src/ui/status-ui.ts";
import { LiveAgentView } from "../src/ui/live-agent-view.ts";
import type { AgentType, ManagerOptions, ThreadService, ThreadView } from "../src/types.ts";

const icon = "\uf121";
const astralIcon = "\u{f0821}";
const definition: AgentType = { name: "worker", description: "Worker", systemPrompt: "Work", icon };
const theme = {
  fg: (_color: string, text: string) => text,
  colors: { accent: { kind: "rgb", r: 94, g: 172, b: 211 } },
  style: (text: string) => text,
} as unknown as Theme;
const host = { requestRender() {}, terminal: { rows: 24, columns: 100 } };
const thread: ThreadView = {
  path: "/root/worker", parent: "/root", owner: "/root", type: "worker", icon,
  state: "completed", task: "Work", status: "Done", createdAt: 0, updatedAt: 0,
};
const service = {
  list: () => [thread], get: () => thread,
  observeTranscript: () => ({
    snapshot: { thread, messages: [], tools: [], generation: 0, revision: 0, inheritedCount: 0 },
    unsubscribe() {},
  }),
} as unknown as ThreadService;

function manager(options: Partial<ManagerOptions> = {}) {
  return new ThreadManager({
    rootSnapshot: () => [], getType: () => definition, toolsFor: () => [],
    createDriver: async () => ({
      prompt: async () => {}, steer: async () => {}, snapshot: () => [], output: () => "Done",
      abort: async () => {}, dispose() {}, sendUpdate() {},
    }),
    ...options,
  });
}

test("optional icons round-trip BMP and supplementary glyphs, never glyph names or terminal controls", () => {
  for (const glyph of [icon, astralIcon, "\u{100001}"]) {
    const type = { ...definition, icon: glyph };
    assert.deepEqual(parseAgentType(serializeAgentType(type)), type);
  }
  const { icon: _icon, ...legacy } = definition;
  assert.deepEqual(parseAgentType(serializeAgentType(legacy)), legacy);
  for (const invalid of ["", "nf-fa-code", "U+F121", "x", " ", icon + icon, "\x1b[31m", "\n", true, 42, null]) {
    assert.throws(() => serializeAgentType({ ...definition, icon: invalid } as AgentType), /icon must be/);
  }
});

test("all six bundled agents carry distinct verified Nerd Fonts glyphs", () => {
  const expected = {
    architect: astralIcon, coder: icon, researcher: "\uf002",
    reviewer: "\uebd1", tasker: "\uf45e", writer: "\uf040",
  };
  assert.equal(new Set(Object.values(expected)).size, 6);
  for (const [name, glyph] of Object.entries(expected)) {
    const type = parseAgentType(readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8"));
    assert.equal(type.icon, glyph, name);
  }
});

test("custom agent icons save and reload in user and trusted project scopes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-icon-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ConfigStore({ cwd: root, agentDir: join(root, "global"), bundledDir: join(root, "bundled"), includeProject: true });
  store.save(definition, "user");
  assert.equal(store.get("worker").icon, icon);
  store.save({ ...definition, icon: astralIcon }, "project");
  assert.equal(store.get("worker").icon, astralIcon);
  const untrusted = new ConfigStore({ cwd: root, agentDir: join(root, "global"), bundledDir: join(root, "bundled"), includeProject: false });
  assert.equal(untrusted.get("worker").icon, icon);
  const { icon: _icon, ...cleared } = definition;
  store.save(cleared, "project");
  assert.equal(store.get("worker").icon, undefined);
});

test("labs toggle defaults off, layers per key, validates booleans, and persists", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-icon-settings-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const options = { cwd, agentDir: cwd, includeProject: true };
  assert.equal(loadManagerSettings(options).settings.nerdFontIcons, false);
  const globalFile = saveManagerSettings({ ...options, scope: "user", settings: { ...DEFAULT_MANAGER_SETTINGS, nerdFontIcons: true } });
  assert.equal(loadManagerSettings(options).settings.nerdFontIcons, true);
  const projectFile = join(cwd, ".pi", "agent", "subagent-manager", "settings.json");
  mkdirSync(join(cwd, ".pi", "agent", "subagent-manager"), { recursive: true });
  writeFileSync(projectFile, JSON.stringify({ nerdFontIcons: false }));
  assert.equal(loadManagerSettings(options).settings.nerdFontIcons, false);
  assert.equal(loadManagerSettings({ ...options, includeProject: false }).settings.nerdFontIcons, true);
  const before = readFileSync(globalFile, "utf8");
  for (const invalid of ["true", "false", 0, 1, null, [], {}]) {
    writeFileSync(projectFile, JSON.stringify({ nerdFontIcons: invalid, maxThreads: 123 }));
    const loaded = loadManagerSettings(options);
    assert.match(loaded.diagnostics[0]!, /nerdFontIcons must be a boolean/);
    assert.equal(loaded.settings.nerdFontIcons, true);
    assert.equal(loaded.settings.maxThreads, DEFAULT_MANAGER_SETTINGS.maxThreads);
    assert.throws(() => saveManagerSettings({ ...options, scope: "user", settings: { ...DEFAULT_MANAGER_SETTINGS, nerdFontIcons: invalid } as never }), /nerdFontIcons must be a boolean/);
    assert.equal(readFileSync(globalFile, "utf8"), before);
  }
});

test("badges and full widgets gate icons, preserve names, reject unsafe saved glyphs, and fit narrow widths", () => {
  assert.equal(agentTypeLabel("worker", icon), "worker");
  assert.equal(agentTypeLabel("worker", astralIcon, true), `${astralIcon} worker`);
  assert.equal(stripTerminalSequences(agentTypeBadge("worker", undefined, theme, icon, true)).trim(), `${icon} worker`);
  for (const invalid of ["\x1b]0;owned\x07", "nf-fa-code", icon + icon]) {
    assert.equal(agentTypeLabel("worker", invalid, true), "worker");
  }
  for (const width of [20, 40, 100]) {
    for (const lines of [renderThreads([thread], width, theme, true), renderAgentTree([thread], width, theme, { nerdFontIcons: true })]) {
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(stripTerminalSequences(lines.join("\n")), new RegExp(icon));
    }
  }
  assert.ok(!renderAgentTree([thread], 100, theme).join("\n").includes(icon));
  assert.ok(!renderThreads([{ ...thread, icon: undefined }], 100, theme, true).join("\n").includes(icon));
});

test("RPC widget, browser tree, and live header respect the same labs toggle", async () => {
  let widget: unknown;
  const ctx = { hasUI: true, mode: "rpc", ui: { theme, setWidget: (_key: string, value: unknown) => { widget = value; } } } as unknown as ExtensionContext;
  updateWidget(ctx, [thread], "full", true);
  assert.match((widget as string[]).join("\n"), new RegExp(icon));
  updateWidget(ctx, [thread], "full", false);
  assert.ok(!(widget as string[]).join("\n").includes(icon));
  for (const enabled of [false, true]) {
    const dialog = new StatusDialog(host, theme, service, () => {}, undefined, undefined, undefined, enabled);
    try { assert.equal(dialog.render(100).join("\n").includes(icon), enabled); }
    finally { dialog.dispose(); }
    const live = new LiveAgentView(host, theme, service, thread.path, { scrollTop: 0, follow: true }, () => {}, enabled);
    try {
      await Promise.resolve();
      assert.equal(live.render(100).join("\n").includes(`${icon} worker`), enabled);
    }
    finally { live.dispose(); }
  }
});

test("spawn, persistence, restore, and retained-definition fallback preserve agent icons", async () => {
  const first = manager();
  await first.spawn("/root", { path: "worker", type: "worker", task: "Work" });
  assert.equal(first.get(thread.path).icon, icon);
  const saved = first.saved();
  assert.equal(saved[0]!.view.icon, icon);
  assert.equal(saved[0]!.definition.icon, icon);
  const second = manager({ getType: () => ({ ...definition, icon: astralIcon }) });
  second.restore(saved);
  assert.equal(second.get(thread.path).icon, icon, "retained definitions keep their glyph");
  delete saved[0]!.view.icon;
  const third = manager();
  third.restore(saved);
  assert.equal(third.get(thread.path).icon, icon, "definition supplies missing saved view icon");
});

