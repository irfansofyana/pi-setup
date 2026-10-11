import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  AGENT_PROGRESS_INTERVAL,
  agentProgressIcon,
  renderAgentSummary,
  renderAgentTree,
  renderThreads,
  updateWidget,
} from "../src/ui/ui.ts";
import { AGENT_LOADERS } from "../src/ui/agent-loader.ts";
import { StatusDialog } from "../src/ui/status-ui.ts";
import { LiveAgentView } from "../src/ui/live-agent-view.ts";
import type {
  ThreadService,
  ThreadView,
  TranscriptListener,
  TranscriptSnapshot,
} from "../src/types.ts";

const roleIcon = "\uf121";
const theme = {
  fg: (_color: string, text: string) => text,
  colors: { accent: { kind: "rgb", r: 94, g: 172, b: 211 } },
  style: (text: string) => text,
} as unknown as Theme;
function thread(state: ThreadView["state"] = "running"): ThreadView {
  return {
    path: "/root/worker",
    parent: "/root",
    owner: "/root",
    type: "worker",
    icon: roleIcon,
    state,
    task: "Work",
    status: "Working",
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    elapsedMs: 1000,
    inputTokens: 10,
    outputTokens: 3,
  };
}
function snapshot(current: ThreadView, revision = 0): TranscriptSnapshot {
  return {
    thread: current,
    messages: [],
    assistant: null,
    tools: [],
    generation: 0,
    revision,
    inheritedCount: 0,
  };
}
const plain = (lines: string[]) => stripTerminalSequences(lines.join("\n"));

test("circle progress frames shape-shift deterministically and settled indicators remain static", () => {
  for (const state of ["starting", "running"] as const) {
    const agent = thread(state);
    const frames = Array.from({ length: 8 }, (_, index) =>
      agentProgressIcon(agent, true, index * AGENT_PROGRESS_INTERVAL),
    );
    assert.equal(new Set(frames).size, 8);
    for (const frame of frames) {
      assert.match(frame!, /^\p{Co}$/u);
      assert.equal(visibleWidth(frame!), 1);
      assert.notEqual(frame, roleIcon);
    }
    assert.equal(agentProgressIcon(agent, true, 8 * AGENT_PROGRESS_INTERVAL), frames[0]);
    assert.equal(agentProgressIcon(agent, true, AGENT_PROGRESS_INTERVAL - 1), frames[0]);
    assert.equal(agentProgressIcon(agent, false, AGENT_PROGRESS_INTERVAL), undefined);
    assert.equal(agentProgressIcon(agent, true, AGENT_PROGRESS_INTERVAL, false), frames[0]);
    assert.equal(
      agentProgressIcon({ state }, true, 0),
      frames[0],
      "missing role icon still animates",
    );
  }
  for (const state of ["paused", "stopped", "completed", "failed"] as const) {
    for (const now of [0, AGENT_PROGRESS_INTERVAL, 2000]) {
      assert.equal(agentProgressIcon(thread(state), true, now), AGENT_LOADERS.circle.states[state]);
      assert.equal(agentProgressIcon(thread(state), false, now), undefined);
    }
  }
});

test("widgets animate active glyphs, retain role glyphs in every state, and fit narrow widths", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const active = { ...thread(), icon: undefined };
  const settled = { ...thread("completed"), path: "/root/done" };
  const before = structuredClone([active, settled]);
  const first = renderAgentTree([active, settled], 120, theme, { nerdFontIcons: true });
  t.mock.timers.tick(AGENT_PROGRESS_INTERVAL);
  const second = renderAgentTree([active, settled], 120, theme, { nerdFontIcons: true });
  assert.notEqual(
    first.find((line) => line.includes(active.path)),
    second.find((line) => line.includes(active.path)),
  );
  assert.equal(
    first.find((line) => line.includes(settled.path)),
    second.find((line) => line.includes(settled.path)),
  );
  assert.ok(plain(second).includes(`${roleIcon} worker`));
  assert.ok(!plain(renderAgentTree([active, settled], 120, theme)).includes(roleIcon));
  for (let frame = 0; frame < 8; frame++) {
    for (const width of [0, 1, 2, 10, 20, 40, 100]) {
      for (const lines of [
        renderAgentTree([active, settled], width, theme, { nerdFontIcons: true }),
        renderAgentSummary([active, settled], width, theme, { nerdFontIcons: true }),
        renderThreads([active, settled], width, theme, true),
      ]) {
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `${width}, frame ${frame}`,
        );
      }
      assert.equal(
        renderAgentSummary([active, settled], width, theme, { nerdFontIcons: true }).length,
        1,
      );
    }
    t.mock.timers.tick(AGENT_PROGRESS_INTERVAL);
  }
  assert.deepEqual([active, settled], before);
});

test("full and minimal widgets repaint at animation cadence, dispose timers, and RPC stays static", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const intervals = t.mock.method(globalThis, "setInterval", globalThis.setInterval);
  let renders = 0;
  let component: { render(width: number): string[]; dispose(): void } | undefined;
  let content: unknown;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme,
      setWidget(_key: string, value: unknown) {
        component?.dispose();
        content = value;
        component =
          typeof value === "function"
            ? value({
                requestRender() {
                  renders++;
                },
              })
            : undefined;
      },
    },
  } as unknown as ExtensionContext;
  for (const mode of ["full", "minimal"] as const) {
    updateWidget(ctx, [thread()], mode, true);
    assert.equal(intervals.mock.calls.at(-1)!.arguments[1], AGENT_PROGRESS_INTERVAL);
    const initial = plain(component!.render(100));
    const previousRenders = renders;
    t.mock.timers.tick(AGENT_PROGRESS_INTERVAL - 1);
    assert.equal(renders, previousRenders);
    t.mock.timers.tick(1);
    assert.equal(renders, previousRenders + 1);
    assert.notEqual(plain(component!.render(100)), initial);
    component!.dispose();
    const disposedRenders = renders;
    t.mock.timers.tick(1000);
    assert.equal(renders, disposedRenders);
  }
  const animatedCalls = intervals.mock.callCount();
  for (const state of ["paused", "stopped", "completed", "failed"] as const) {
    updateWidget(ctx, [thread(state)], "full", true);
    assert.ok(plain(component!.render(100)).includes(`${roleIcon} worker`));
    t.mock.timers.tick(1000);
  }
  assert.equal(
    intervals.mock.callCount(),
    animatedCalls,
    "settled widgets allocate no animation timers",
  );
  ctx.mode = "rpc";
  updateWidget(ctx, [thread()], "full", true);
  assert.ok(Array.isArray(content));
  assert.ok(plain(content as string[]).includes(`${roleIcon} worker`));
  t.mock.timers.tick(AGENT_PROGRESS_INTERVAL);
  assert.equal(intervals.mock.callCount(), animatedCalls, "RPC allocates no timers");
  updateWidget(ctx, [thread()], "minimal", true);
  assert.equal((content as string[]).length, 1);
  assert.equal(intervals.mock.callCount(), animatedCalls);
});

test("status tree reuses its polling timer, speeds up only while active, and stops after disposal", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const intervals = t.mock.method(globalThis, "setInterval", globalThis.setInterval);
  let current = thread();
  let renders = 0;
  const dialog = new StatusDialog(
    {
      requestRender() {
        renders++;
      },
      terminal: { rows: 24 },
    },
    theme,
    { list: () => [current], get: () => current } as unknown as ThreadService,
    () => {},
    undefined,
    undefined,
    undefined,
    true,
  );
  try {
    dialog.startRefresh();
    assert.equal(intervals.mock.calls.at(-1)!.arguments[1], AGENT_PROGRESS_INTERVAL);
    const first = plain(dialog.render(120));
    t.mock.timers.tick(AGENT_PROGRESS_INTERVAL);
    assert.equal(renders, 1);
    assert.notEqual(plain(dialog.render(120)), first);
    current = thread("completed");
    assert.ok(plain(dialog.render(120)).includes(`${roleIcon} worker`));
    assert.equal(
      intervals.mock.calls.at(-1)!.arguments[1],
      1000,
      "settled uses ordinary status polling, not animation",
    );
    const atSettlement = renders;
    t.mock.timers.tick(AGENT_PROGRESS_INTERVAL);
    assert.equal(renders, atSettlement);
    current = thread("starting");
    dialog.render(120);
    assert.equal(intervals.mock.calls.at(-1)!.arguments[1], AGENT_PROGRESS_INTERVAL);
    const beforeDispose = renders;
    dialog.dispose();
    t.mock.timers.tick(2000);
    dialog.render(120);
    assert.equal(renders, beforeDispose);
    assert.equal(intervals.mock.callCount(), 3);
  } finally {
    dialog.dispose();
  }
});

test("settled and disabled live headers allocate no animation timer", async (t) => {
  const intervals = t.mock.method(globalThis, "setInterval", globalThis.setInterval);
  const cases: Array<{ state: ThreadView["state"]; enabled: boolean }> = [
    { state: "running", enabled: false },
    ...(["paused", "stopped", "completed", "failed"] as const).map((state) => ({
      state,
      enabled: true,
    })),
  ];
  for (const { state, enabled } of cases) {
    const view = new LiveAgentView(
      { requestRender() {}, terminal: { rows: 10 } },
      theme,
      {
        observeTranscript() {
          return { snapshot: snapshot(thread(state)), unsubscribe() {} };
        },
      } as unknown as ThreadService,
      "/root/worker",
      { scrollTop: 0, follow: true },
      () => {},
      enabled,
    );
    try {
      await Promise.resolve();
      assert.equal(view.render(100)[0]!.includes(`${roleIcon} worker`), enabled);
    } finally {
      view.dispose();
    }
  }
  assert.equal(intervals.mock.callCount(), 0);
});

test("live headers animate without transcript events, freeze on settlement, resume and dispose", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const intervals = t.mock.method(globalThis, "setInterval", globalThis.setInterval);
  let listener: TranscriptListener = () => {};
  let renders = 0;
  const view = new LiveAgentView(
    {
      requestRender() {
        renders++;
      },
      terminal: { rows: 10 },
    },
    theme,
    {
      observeTranscript(_path: string, receive: TranscriptListener) {
        listener = receive;
        return { snapshot: snapshot(thread()), unsubscribe() {} };
      },
    } as unknown as ThreadService,
    "/root/worker",
    { scrollTop: 0, follow: true },
    () => {},
    true,
  );
  try {
    await Promise.resolve();
    t.mock.timers.tick(16);
    const initialHeader = view.render(120)[0];
    renders = 0;
    assert.equal(intervals.mock.calls[0]!.arguments[1], AGENT_PROGRESS_INTERVAL);
    t.mock.timers.tick(AGENT_PROGRESS_INTERVAL);
    t.mock.timers.tick(16);
    assert.equal(renders, 1);
    assert.notEqual(view.render(120)[0], initialHeader);
    listener(snapshot(thread("completed"), 1));
    t.mock.timers.tick(16);
    const staticHeader = view.render(120)[0];
    assert.ok(staticHeader!.includes(`${roleIcon} worker`));
    renders = 0;
    t.mock.timers.tick(2000);
    assert.equal(renders, 0);
    assert.equal(view.render(120)[0], staticHeader);
    listener(snapshot(thread("running"), 2));
    t.mock.timers.tick(16);
    assert.equal(intervals.mock.callCount(), 2);
    view.dispose();
    renders = 0;
    t.mock.timers.tick(2000);
    assert.equal(renders, 0);
  } finally {
    view.dispose();
  }
});

