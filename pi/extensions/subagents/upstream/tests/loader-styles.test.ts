import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_MANAGER_SETTINGS,
  LOADER_STYLES,
  loadManagerSettings,
  saveManagerSettings,
} from "../src/prefs/settings.ts";
import {
  AGENT_LOADERS,
  AGENT_PROGRESS_INTERVAL,
  agentProgressIcon,
} from "../src/ui/agent-loader.ts";
import {
  agentTypeLabel,
  renderAgentTree,
  renderAgentSummary,
  renderThreads,
  updateWidget,
} from "../src/ui/ui.ts";
import { StatusDialog } from "../src/ui/status-ui.ts";
import { LiveAgentView } from "../src/ui/live-agent-view.ts";
import type { ThreadService, ThreadView } from "../src/types.ts";

const icon = "\uf121";
const theme = {
  fg: (_color: string, text: string) => text,
  colors: { accent: { kind: "rgb", r: 94, g: 172, b: 211 } },
  style: (text: string) => text,
} as unknown as Theme;
const plain = (lines: string[]) => stripTerminalSequences(lines.join("\n"));
const thread = (state: ThreadView["state"]): ThreadView => ({
  path: "/root/worker",
  parent: "/root",
  owner: "/root",
  type: "worker",
  icon,
  state,
  task: "Work",
  status: "Working",
  createdAt: 0,
  updatedAt: 0,
});

test("hourglass completion uses a solid check-square rather than a running frame", () => {
  assert.equal(AGENT_LOADERS.hourglass.states.completed, "\uf14a");
  assert.ok(!AGENT_LOADERS.hourglass.frames.includes(AGENT_LOADERS.hourglass.states.completed));
});

test("loader styles default to circle, layer by key, persist in both scopes and reject invalid layers atomically", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-loader-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { cwd: root, agentDir: root, includeProject: true };
  assert.equal(loadManagerSettings(options).settings.loaderStyle, "circle");
  const globalFile = saveManagerSettings({
    ...options,
    scope: "user",
    settings: { ...DEFAULT_MANAGER_SETTINGS, loaderStyle: "braille" },
  });
  for (const loaderStyle of LOADER_STYLES) {
    saveManagerSettings({
      ...options,
      scope: "project",
      settings: { ...DEFAULT_MANAGER_SETTINGS, loaderStyle },
    });
    assert.equal(loadManagerSettings(options).settings.loaderStyle, loaderStyle);
    assert.equal(
      loadManagerSettings({ ...options, includeProject: false }).settings.loaderStyle,
      "braille",
    );
  }
  const projectFile = join(root, ".pi", "agent", "subagent-manager", "settings.json");
  mkdirSync(dirname(projectFile), { recursive: true });
  writeFileSync(projectFile, JSON.stringify({ nerdFontIcons: true }));
  assert.equal(
    loadManagerSettings(options).settings.loaderStyle,
    "braille",
    "missing key preserves global selection",
  );
  const before = readFileSync(globalFile, "utf8");
  for (const invalid of ["Braille", "spinner", "", true, 0, null, [], {}]) {
    writeFileSync(projectFile, JSON.stringify({ loaderStyle: invalid, maxThreads: 123 }));
    const loaded = loadManagerSettings(options);
    assert.match(loaded.diagnostics[0]!, /loaderStyle must be circle, braille or hourglass/);
    assert.equal(loaded.settings.loaderStyle, "braille");
    assert.equal(loaded.settings.maxThreads, DEFAULT_MANAGER_SETTINGS.maxThreads);
    assert.throws(
      () =>
        saveManagerSettings({
          ...options,
          scope: "user",
          settings: { ...DEFAULT_MANAGER_SETTINGS, loaderStyle: invalid } as never,
        }),
      /loaderStyle must be/,
    );
    assert.equal(readFileSync(globalFile, "utf8"), before);
  }
});

test("every family cycles all frames, freezes RPC, and has distinct stable completed/paused/failed/stopped indicators", () => {
  for (const loaderStyle of LOADER_STYLES) {
    const loader = AGENT_LOADERS[loaderStyle];
    assert.ok(loader.frames.length > 1);
    assert.equal(new Set(loader.frames).size, loader.frames.length);
    assert.equal(new Set(Object.values(loader.states)).size, 4);
    for (const state of ["starting", "running"] as const) {
      for (const [index, glyph] of loader.frames.entries()) {
        const now = index * AGENT_PROGRESS_INTERVAL;
        assert.equal(agentProgressIcon({ state }, true, now, true, loaderStyle), glyph);
        assert.equal(agentProgressIcon({ state }, true, now, false, loaderStyle), loader.frames[0]);
        assert.equal(agentProgressIcon({ state }, false, now, true, loaderStyle), undefined);
        assert.equal(visibleWidth(glyph), 1);
        assert.equal(agentTypeLabel("worker", icon, true, glyph), `${glyph} ${icon} worker`);
      }
      assert.equal(
        agentProgressIcon(
          { state },
          true,
          loader.frames.length * AGENT_PROGRESS_INTERVAL,
          true,
          loaderStyle,
        ),
        loader.frames[0],
      );
    }
    for (const state of ["completed", "paused", "failed", "stopped"] as const) {
      for (const now of [0, 180, 9999]) {
        assert.equal(
          agentProgressIcon({ state }, true, now, true, loaderStyle),
          loader.states[state],
        );
        assert.equal(
          agentProgressIcon({ state }, true, now, false, loaderStyle),
          loader.states[state],
        );
        assert.equal(agentProgressIcon({ state }, false, now, true, loaderStyle), undefined);
      }
    }
  }
  for (const state of ["completed", "paused", "failed", "stopped"] as const) {
    assert.equal(new Set(LOADER_STYLES.map((style) => AGENT_LOADERS[style].states[state])).size, 3);
  }
});

test("separate loader prefix never loosens custom-role or terminal-control validation", () => {
  const loader = AGENT_LOADERS.braille.frames[0]!;
  for (const invalid of ["x", "nf-fa-code", icon + icon, "\x1b[31m", "\n"]) {
    assert.equal(agentTypeLabel("worker", invalid, true, loader), `${loader} worker`);
    assert.equal(agentTypeLabel("worker", icon, true, invalid), `${icon} worker`);
  }
  assert.equal(agentTypeLabel("worker", icon, false, loader), "worker");
});

test("all surfaces show chosen loader before role icon and selected state in every family", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  for (const loaderStyle of LOADER_STYLES) {
    for (const state of [
      "starting",
      "running",
      "completed",
      "paused",
      "failed",
      "stopped",
    ] as const) {
      const agent = thread(state);
      const glyph = agentProgressIcon(agent, true, 0, true, loaderStyle)!;
      const label = `${glyph} ${icon} worker`;
      const opts = { nerdFontIcons: true, loaderStyle };
      assert.ok(plain(renderAgentTree([agent], 140, theme, opts)).includes(label));
      assert.ok(plain(renderThreads([agent], 140, theme, true, loaderStyle)).includes(label));
      const summary = plain(renderAgentSummary([agent], 140, theme, opts));
      assert.ok(summary.includes(`${glyph} 1 ${state === "starting" ? "running" : state}`));
      for (const width of [0, 1, 2, 20, 40, 80]) {
        for (const lines of [
          renderAgentTree([agent], width, theme, opts),
          renderAgentSummary([agent], width, theme, opts),
          renderThreads([agent], width, theme, true, loaderStyle),
        ]) {
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
        }
      }
      const service = {
        list: () => [agent],
        get: () => agent,
        observeTranscript: () => ({
          snapshot: {
            thread: agent,
            messages: [],
            tools: [],
            generation: 0,
            revision: 0,
            inheritedCount: 0,
          },
          unsubscribe() {},
        }),
      } as unknown as ThreadService;
      const host = { requestRender() {}, terminal: { rows: 24 } };
      const dialog = new StatusDialog(
        host,
        theme,
        service,
        () => {},
        undefined,
        undefined,
        undefined,
        true,
        loaderStyle,
      );
      const live = new LiveAgentView(
        host,
        theme,
        service,
        agent.path,
        { scrollTop: 0, follow: true },
        () => {},
        true,
        loaderStyle,
      );
      try {
        await Promise.resolve();
        assert.ok(plain(dialog.render(160)).includes(label), `tree: ${loaderStyle} ${state}`);
        assert.ok(plain(live.render(160)).includes(label), `live: ${loaderStyle} ${state}`);
      } finally {
        dialog.dispose();
        live.dispose();
      }
      let widget: string[] = [];
      const ctx = {
        hasUI: true,
        mode: "rpc",
        ui: {
          theme,
          setWidget: (_key: string, lines: string[]) => {
            widget = lines;
          },
        },
      } as unknown as ExtensionContext;
      updateWidget(ctx, [agent], "full", true, false, loaderStyle);
      assert.ok(plain(widget).includes(label), `RPC: ${loaderStyle} ${state}`);
      const first = plain(widget);
      t.mock.timers.tick(AGENT_PROGRESS_INTERVAL);
      updateWidget(ctx, [agent], "full", true, false, loaderStyle);
      assert.equal(plain(widget), first, "RPC snapshot ignores animation time");
      t.mock.timers.setTime(0);
    }
  }
});

