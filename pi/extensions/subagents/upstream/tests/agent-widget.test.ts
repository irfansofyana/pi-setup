import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_COLORS } from "../src/prefs/config.ts";
import { buildStatusTree, type StatusRow } from "../src/ui/status-ui.ts";
import { renderAgentSummary, renderAgentTree, updateWidget } from "../src/ui/ui.ts";
import type { ThreadView } from "../src/types.ts";

function thread(path: string, patch: Partial<ThreadView> = {}): ThreadView {
  const slash = path.lastIndexOf("/");
  return {
    parent: slash > 0 ? path.slice(0, slash) : null,
    owner: "/root",
    type: "worker",
    state: "running",
    task: "Investigate",
    status: "Working",
    createdAt: 1,
    updatedAt: 2,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    color: "accent",
    ...patch,
    path,
  };
}

function testTheme(appearance: "dark" | "light" = "dark"): Theme {
  const foreground = appearance === "dark" ? "#eeeeee" : "#111111";
  const background = appearance === "dark" ? "#111111" : "#eeeeee";
  const colors = {
    ...Object.fromEntries(AGENT_COLORS.map((token) => [token, foreground])),
    accent: appearance === "dark" ? "#60a5fa" : "#1e40af",
    success: "#166534",
    warning: "#facc15",
    error: "#b91c1c",
    muted: appearance === "dark" ? "#9ca3af" : "#374151",
  } as ConstructorParameters<typeof Theme>[0];
  const backgrounds = Object.fromEntries(
    [
      "selectedBg",
      "searchMatchBg",
      "userMessageBg",
      "customMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ].map((token) => [token, background]),
  ) as ConstructorParameters<typeof Theme>[1];
  return new Theme(colors, backgrounds, "truecolor", { appearance });
}

const theme = testTheme();

function plain(lines: string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line));
}

function lineOf(lines: string[], text: string): string {
  const found = plain(lines).find((line) => line.includes(text));
  assert.ok(found, text);
  return found;
}

function indexOf(lines: string[], text: string): number {
  const index = plain(lines).findIndex((line) => line.includes(text));
  assert.ok(index >= 0, text);
  return index;
}

test("overflow previews select the most recent agents within a state", () => {
  const threads = Array.from({ length: 14 }, (_, index) =>
    thread(`/root/job-${index}`, { createdAt: index, task: `TASK_${index}` }),
  );
  const lines = plain(renderAgentTree(threads, 120, theme));
  for (let index = 4; index < 14; index++)
    assert.ok(lines.some((line) => line.includes(`TASK_${index}`)));
  for (let index = 0; index < 4; index++)
    assert.ok(!lines.some((line) => new RegExp(`\\bTASK_${index}\\b`).test(line)));
  assert.match(lines.at(-1)!, /14 running.*\+4 more agents.*Press ←/);
});

test("status tree honors a sibling comparator but cycle repair stays lexical", () => {
  const reverse = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  const siblings = [thread("/root/b"), thread("/root/a")];
  const paths = (rows: StatusRow[]) => rows.map((row) => row.path);
  assert.deepEqual(paths(buildStatusTree(siblings, new Set())), ["/root", "/root/a", "/root/b"]);
  assert.deepEqual(paths(buildStatusTree(siblings, new Set(), reverse)), [
    "/root",
    "/root/b",
    "/root/a",
  ]);
  const cycle = buildStatusTree(
    [
      thread("/root/a", { parent: "/root/b" }),
      thread("/root/b", { parent: "/root/a", state: "paused" }),
    ],
    new Set(),
    reverse,
  );
  assert.equal(cycle.find((row) => row.path === "/root/a")?.prefix, "");
  assert.equal(cycle.find((row) => row.path === "/root/b")?.prefix, "└ ");
});

test("agent tree heading, hierarchy, declared parents, and root exclusion", () => {
  const nested = renderAgentTree(
    [
      thread("/root", { type: "main", task: "MAIN_SENTINEL", status: "main" }),
      thread("/root/a", { parent: "/root", state: "running", task: "Parent" }),
      thread("/root/a/b", {
        parent: "/root/a",
        state: "paused",
        task: "Child",
      }),
      thread("/root/a/b/c", {
        parent: "/root/a/b",
        state: "stopped",
        task: "Grand",
        status: "idle",
      }),
      thread("/root/z", { parent: "/root", state: "paused", task: "Sibling" }),
    ],
    120,
    theme,
  );
  const text = plain(nested);
  assert.match(text[0]!, /Agents/);
  assert.match(text[0]!, /1 live · 2 paused$/);
  assert.ok(!text.some((line) => line.includes("MAIN_SENTINEL")));
  assert.ok(indexOf(nested, "Parent") < indexOf(nested, "Child"));
  assert.ok(indexOf(nested, "Child") < indexOf(nested, "Grand"));
  assert.ok(indexOf(nested, "Grand") < indexOf(nested, "Sibling"));
  assert.match(lineOf(nested, "Child"), /^│ └ /);
  assert.match(lineOf(nested, "Grand"), /^│   └ /);
  assert.equal(nested.length, 6);

  const declared = renderAgentTree(
    [
      thread("/team", { parent: null, state: "running", task: "Lead" }),
      thread("/other/place", {
        parent: "/team",
        state: "paused",
        task: "Delegate",
        status: "waiting",
      }),
      thread("/team/not-child", {
        parent: "/elsewhere",
        state: "completed",
        task: "Away",
        status: "done",
      }),
    ],
    120,
    theme,
  );
  const declaredText = plain(declared);
  assert.ok(indexOf(declared, "Lead") < indexOf(declared, "Delegate"));
  const elsewhere = declaredText.findIndex(
    (line) => line.includes("/elsewhere") && line.includes("missing parent"),
  );
  assert.ok(elsewhere >= 0);
  assert.ok(indexOf(declared, "Away") > elsewhere);
  assert.ok(!declaredText.some((line) => /\/other\s+missing parent/.test(line)));

  const indie = renderAgentTree(
    [
      thread("/k", { parent: null, state: "paused", task: "Indie" }),
      thread("/k/child", {
        parent: "/k",
        state: "failed",
        task: "Nested",
        status: "boom",
      }),
    ],
    100,
    theme,
  );
  assert.ok(indexOf(indie, "Indie") < indexOf(indie, "Nested"));
  assert.match(lineOf(indie, "Nested"), /^└ /);
  assert.doesNotMatch(lineOf(indie, "Indie"), /^[├└] /);

  const missing = renderAgentTree(
    [
      thread("/root/gone/child", {
        parent: "/root/gone",
        state: "stopped",
        task: "Hold",
        status: "halted",
      }),
    ],
    100,
    theme,
  );
  const missingText = plain(missing);
  const gone = missingText.findIndex(
    (line) => line.includes("/root/gone") && line.includes("missing parent"),
  );
  assert.ok(gone >= 0);
  assert.ok(indexOf(missing, "Hold") > gone);
  assert.match(lineOf(missing, "Hold"), /└ /);
});

test("agents sort newest-started first; a branch ranks by its most recent start", () => {
  const ordered = renderAgentTree(
    [
      thread("/root/a-old", { state: "running", task: "Old", createdAt: 1, lastStartedAt: 1 }),
      thread("/root/b-new", { state: "completed", task: "New", createdAt: 3, lastStartedAt: 3 }),
      thread("/root/c-mid", { state: "paused", task: "Mid", createdAt: 2, lastStartedAt: 2 }),
    ],
    100,
    theme,
  );
  assert.ok(indexOf(ordered, "New") < indexOf(ordered, "Mid"));
  assert.ok(indexOf(ordered, "Mid") < indexOf(ordered, "Old"));

  // Resuming an older agent moves it back to the top.
  const resumed = renderAgentTree(
    [
      thread("/root/first", { task: "First", createdAt: 1, lastStartedAt: 10 }),
      thread("/root/second", { task: "Second", createdAt: 5, lastStartedAt: 5 }),
    ],
    100,
    theme,
  );
  assert.ok(indexOf(resumed, "First") < indexOf(resumed, "Second"));

  // A recently started child promotes its parent branch; saves without lastStartedAt use createdAt.
  const promoted = renderAgentTree(
    [
      thread("/root/p", { task: "Parent", createdAt: 1 }),
      thread("/root/p/kid", { parent: "/root/p", task: "Kid", createdAt: 9 }),
      thread("/root/q", { task: "Other", createdAt: 5 }),
    ],
    100,
    theme,
  );
  assert.ok(indexOf(promoted, "Parent") < indexOf(promoted, "Kid"));
  assert.ok(indexOf(promoted, "Kid") < indexOf(promoted, "Other"));
});

test("shows task and elapsed tokens in one row per agent without status text", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const lines = renderAgentTree(
      [
        thread("/root/job", {
          type: "researcher",
          state: "running",
          task: "Investigate",
          status: "Reading src/ui.ts",
          startedAt: 995_000,
          elapsedMs: 2_000,
          inputTokens: 1_200,
          outputTokens: 34,
        }),
        thread("/root/hold", {
          state: "paused",
          task: "Wait",
          status: "",
          startedAt: 1,
          elapsedMs: 9_000,
          inputTokens: 10,
          outputTokens: 3,
        }),
      ],
      80,
      theme,
    );
    const text = plain(lines);
    assert.match(text[0]!, /1 live · 1 paused$/);
    const job = lineOf(lines, "/root/job");
    assert.match(job, /Investigate/);
    assert.equal(job.includes("Reading"), false);
    assert.ok(job.endsWith("7s ↑1.2k ↓34"), job);
    assert.equal(lines.length, 4);
    assert.doesNotMatch(text.join("\n"), /Reading src\/ui\.ts/);
    const hold = lineOf(lines, "/root/hold");
    assert.match(hold, /Wait/);
    assert.ok(hold.endsWith("9s ↑10 ↓3"), hold);
    assert.equal(text.filter((line) => line.includes("Wait")).length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("omits lifecycle and activity lines for every state without changing retained status", () => {
  const statuses = {
    starting: "Starting",
    running: "Working",
    paused: "Awaiting further input",
    completed: "Completed; session retained",
    stopped: "Stopped; session retained",
    failed: "Failure details",
  } as const;
  const threads = Object.entries(statuses).map(([state, status]) =>
    thread(`/root/${state}`, { state: state as ThreadView["state"], status }),
  );
  const snapshot = structuredClone(threads);
  const lines = plain(renderAgentTree(threads, 120, theme));
  assert.equal(lines.length, threads.length + 2);
  for (const agent of threads) {
    assert.match(lineOf(lines, agent.path), new RegExp(`\\[${agent.state}\\]`));
    assert.ok(!lines.some((line) => line.includes(agent.status)), agent.status);
  }
  assert.deepEqual(threads, snapshot);
});

test("sanitizes controls and clips unicode without dropping right counters", () => {
  const hostile = "\x1b[31mred\x1b[0m\x1b]0;owned\x07\n\x00" + "界".repeat(8);
  const segments = ["n0", "n1", "n2", "n3", "n4", "n5", "n6"];
  const leaf = `/root/${segments.join("/")}`;
  const threads = [
    thread(leaf, {
      parent: `/root/${segments.slice(0, -1).join("/")}`,
      type: "bad\x1b[2J",
      task: hostile,
      status: hostile,
      state: "failed",
      color: "\x1b[31mnot-a-token",
    }),
  ];
  const counters = "0s ↑0 ↓0";
  for (const width of [0, 1, 2, 20, 80, 160]) {
    const lines = renderAgentTree(threads, width, theme);
    assert.ok(lines.length <= 12, String(width));
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      String(width),
    );
    assert.ok(
      lines.every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line))),
      String(width),
    );
    if (width >= visibleWidth(theme.fg("muted", counters))) {
      const agent = lines.find((line) => line.endsWith(theme.fg("muted", counters)));
      assert.ok(agent, String(width));
      assert.equal(visibleWidth(agent), width);
    }
  }
  const wide = plain(renderAgentTree(threads, 160, theme));
  assert.match(wide.find((line) => line.includes("n6")) ?? "", /界/);
  assert.match(wide.join("\n"), /missing parent/);
});

test("ends below agent rows with running count and browser entry", () => {
  for (const state of ["running", "completed"] as const) {
    const lines = plain(renderAgentTree([thread("/root/job", { state })], 80, theme));
    assert.equal(lines.length, 3);
    assert.equal(
      lines.at(-1),
      state === "running"
        ? "1 running · Press ← to open subagent browser · → collapse"
        : "0 running · → collapse",
    );
    assert.match(lines.at(-2)!, /\/root\/job/);
    assert.doesNotMatch(lines.join("\n"), /Working/);
    assert.doesNotMatch(lines.join("\n"), /Esc:|abort main|more agents/);
  }
});

test("browser hint appears only for starting or running subagents in either widget mode", () => {
  for (const render of [renderAgentTree, renderAgentSummary]) {
    for (const state of [
      "starting",
      "running",
      "paused",
      "completed",
      "failed",
      "stopped",
    ] as const) {
      const lines = plain(render([thread("/root"), thread("/root/job", { state })], 100, theme));
      assert.equal(
        lines.some((line) => line.includes("←")),
        state === "starting" || state === "running",
        state,
      );
      assert.equal(
        lines.some((line) => line.includes("→ collapse")),
        render === renderAgentTree,
      );
      const rpcLines = plain(
        render([thread("/root/job", { state })], 100, theme, { showBrowserHint: false }),
      );
      assert.doesNotMatch(rpcLines.join("\n"), /←|→ collapse/);
    }
  }
});

test("bounds the widget to twelve lines and counts every omitted real agent", () => {
  const many = Array.from({ length: 11 }, (_, index) =>
    thread(`/root/m${String(index).padStart(2, "0")}`, {
      parent: "/root",
      state: "completed",
      task: `Job ${index}`,
      status: `status ${index}`,
    }),
  );
  // Ten one-line previews fit between the heading and reserved status strip.
  const ten = renderAgentTree(many.slice(0, 10), 80, theme);
  assert.equal(ten.length, 12);
  assert.equal(
    plain(ten).some((line) => line.includes("more agents")),
    false,
  );
  const eleven = renderAgentTree(many, 80, theme);
  assert.equal(eleven.length, 12);
  assert.equal(plain(eleven).at(-1), "0 running · +1 more agents · → collapse");
  assert.equal(
    plain(eleven).some((line) => line.includes("Job 10")),
    false,
  );
  const four = renderAgentTree(many.slice(0, 4), 80, theme);
  assert.equal(four.length, 6);
  assert.equal(
    plain(four).some((line) => line.includes("more agents")),
    false,
  );

  const nested = [
    thread("/root/p", { parent: "/root", state: "running", task: "Parent" }),
    ...Array.from({ length: 11 }, (_, index) =>
      thread(`/root/p/c${String(index).padStart(2, "0")}`, {
        parent: "/root/p",
        state: "running",
        task: `Child ${index}`,
      }),
    ),
  ];
  const packed = renderAgentTree(nested, 90, theme);
  assert.equal(packed.length, 12);
  assert.match(plain(packed)[0]!, /12 live · 0 paused$/);
  assert.equal(
    plain(packed).at(-1),
    "12 running · +2 more agents · Press ← to open subagent browser · → collapse",
  );
  assert.ok(indexOf(packed, "Parent") < indexOf(packed, "Child 0"));
  assert.match(plain(packed).join("\n"), /Child 8/);
  assert.equal(
    plain(packed).some((line) => line.includes("Child 9")),
    false,
  );
});

test("live branches cannot be hidden by settled descendants", () => {
  const lines = renderAgentTree(
    [
      thread("/root/a", { task: "Active parent" }),
      ...Array.from({ length: 9 }, (_, index) =>
        thread(`/root/a/done${index}`, {
          state: "completed",
          task: `Settled child ${index}`,
        }),
      ),
      thread("/root/z", { task: "Other active branch" }),
    ],
    100,
    theme,
  );
  assert.equal(lines.length, 12);
  assert.match(plain(lines)[0]!, /2 live · 0 paused$/);
  assert.ok(indexOf(lines, "Active parent") < indexOf(lines, "Settled child 0"));
  assert.ok(indexOf(lines, "Other active branch") >= 0);
  assert.equal(
    plain(lines).at(-1),
    "2 running · +1 more agents · Press ← to open subagent browser · → collapse",
  );
});

test("browser strip counts unique real starting/running agents and clips safely", () => {
  const threads = [
    thread("/root"),
    thread("/root/a", { state: "starting" }),
    thread("/root/a", { state: "running" }),
    thread("/root/missing/b"),
    thread("/root/paused", { state: "paused" }),
    thread("/root/stopped", { state: "stopped" }),
    thread("/root/failed", { state: "failed" }),
    thread("/root/completed", { state: "completed" }),
  ];
  const before = structuredClone(threads);
  for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
    const lines = renderAgentTree(threads, width, theme);
    assert.ok(lines.length <= 12);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      String(width),
    );
    if (width >= 80) {
      const footer = lines.at(-1)!;
      assert.equal(
        stripTerminalSequences(footer),
        "2 running · Press ← to open subagent browser · → collapse",
      );
      assert.ok(footer.includes(theme.fg("accent", "2 running")));
      assert.ok(
        footer.includes(theme.fg("muted", " · Press ← to open subagent browser · → collapse")),
      );
    }
  }
  assert.deepEqual(threads, before);
});

test("cycle rendering stays finite and keeps both agents with their parent row", () => {
  const threads = [
    thread("/root/a", { parent: "/root/b", state: "running", task: "Alpha" }),
    thread("/root/b", { parent: "/root/a", state: "paused", task: "Beta" }),
  ];
  const snapshot = structuredClone(threads);
  const lines = renderAgentTree(threads, 80, theme);
  assert.deepEqual(threads, snapshot);
  assert.ok(lines.length <= 12);
  assert.ok(indexOf(lines, "Alpha") < indexOf(lines, "Beta"));
  assert.match(lineOf(lines, "Beta"), /└ |├ /);
  assert.equal(renderAgentTree([], 80, theme).length, 0);
  assert.deepEqual(renderAgentTree([thread("/root", { task: "MAIN_SENTINEL" })], 80, theme), []);
});

test("updateWidget pins the tree above the editor, clears when empty, and uses strings in RPC", () => {
  const calls: { content: unknown; options: unknown }[] = [];
  const context = (mode?: string, hasUI = true) =>
    ({
      hasUI,
      mode,
      ui: {
        theme,
        setWidget: (_key: string, content: unknown, options: unknown) => {
          calls.push({ content, options });
        },
      },
    }) as unknown as ExtensionContext;
  const ctx = context();
  updateWidget(ctx, [thread("/root/job", { state: "completed", task: "Done" })]);
  const widget = (
    calls[0]!.content as (tui: { requestRender(): void }) => {
      render(width: number): string[];
      dispose(): void;
    }
  )({ requestRender() {} });
  assert.match(plain(widget.render(80)).join("\n"), /Agents[\s\S]*Done/);
  assert.equal(plain(widget.render(80)).at(-1), "0 running · → collapse");
  widget.dispose();

  updateWidget(ctx, []);
  updateWidget(ctx, [thread("/root")]);
  assert.deepEqual(
    calls.slice(1).map((call) => call.content),
    [undefined, undefined],
  );
  assert.ok(
    calls.every((call) => (call.options as { placement: string }).placement === "aboveEditor"),
  );

  calls.length = 0;
  updateWidget(context("rpc"), [thread("/root/job", { status: "Digging", startedAt: Date.now() })]);
  const rpcLines = calls[0]!.content as string[];
  assert.ok(Array.isArray(rpcLines) && rpcLines.length <= 12);
  assert.ok(rpcLines.every((line) => visibleWidth(line) <= 80));
  assert.match(plain(rpcLines).join("\n"), /Agents[\s\S]*Investigate/);
  assert.doesNotMatch(plain(rpcLines).join("\n"), /Digging/);
  assert.equal(plain(rpcLines).at(-1), "1 running");
  assert.doesNotMatch(plain(rpcLines).join("\n"), /Press ←/);

  calls.length = 0;
  updateWidget(context("rpc", false), [thread("/hidden")]);
  assert.equal(calls.length, 0);
});

test("widget collapses only after the root turn ends and every real agent is idle", () => {
  let content: unknown;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme,
      setWidget: (_key: string, value: unknown) => {
        content = value;
      },
    },
  } as unknown as ExtensionContext;
  const renderLast = () => {
    if (Array.isArray(content)) return plain(content);
    const component = (
      content as (tui: { requestRender(): void }) => {
        render(width: number): string[];
        dispose(): void;
      }
    )({ requestRender() {} });
    const lines = plain(component.render(80));
    component.dispose();
    return lines;
  };
  const agents = [
    thread("/root"), // Synthetic main thread must not count as a running subagent.
    ...(["completed", "failed", "paused", "stopped"] as const).map((state) =>
      thread(`/root/${state}`, { state }),
    ),
  ];
  for (const transport of ["tui", "rpc"] as const) {
    ctx.mode = transport;
    updateWidget(ctx, agents, "full", false, false);
    assert.match(renderLast().join("\n"), /Agents[\s\S]*\/root\/completed/);

    for (const mode of ["full", "minimal"] as const) {
      updateWidget(ctx, agents, mode, false, true);
      const lines = renderLast();
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /^0 running, 1 stopped, 1 failed, 1 paused, 1 completed/);
      assert.doesNotMatch(lines[0]!, /Agents|\/root|Press ←/);
    }

    for (const state of ["starting", "running"] as const) {
      updateWidget(ctx, [...agents, thread("/independent", { state })], "full", false, true);
      assert.match(renderLast().join("\n"), /Agents[\s\S]*\/independent/);
    }
    // The next change after the final child settles collapses the tree too.
    updateWidget(ctx, agents, "full", false, true);
    assert.equal(renderLast().length, 1);
    // A new main turn restores the user's configured full preview.
    updateWidget(ctx, agents, "full", false, false);
    assert.match(renderLast().join("\n"), /Agents/);
    updateWidget(ctx, [], "full", false, true);
    assert.equal(content, undefined);
  }
});

test("minimal summary counts unique real agents with semantic colors and active-only token sums", () => {
  const threads = [
    thread("/root", { inputTokens: 999_999, outputTokens: 999_999 }),
    thread("/root/a", { inputTokens: 1_100, outputTokens: 12 }),
    thread("/root/missing/b", { inputTokens: 100, outputTokens: 13 }),
    thread("/independent", { state: "starting", inputTokens: 200, outputTokens: 14 }),
    thread("/root/stopped1", { state: "stopped", inputTokens: 50_000, outputTokens: 50_000 }),
    thread("/root/stopped2", { state: "stopped", inputTokens: 50_000, outputTokens: 50_000 }),
    thread("/root/failed", { state: "failed", inputTokens: 50_000, outputTokens: 50_000 }),
    thread("/root/paused", { state: "paused", inputTokens: 50_000, outputTokens: 50_000 }),
    thread("/root/completed", { state: "completed", inputTokens: 50_000, outputTokens: 50_000 }),
    // Match the full tree's first occurrence wins rule; neither duplicates nor missing parents count.
    thread("/root/a", { inputTokens: 999_999, outputTokens: 999_999 }),
  ];
  const before = structuredClone(threads);
  const lines = renderAgentSummary(threads, 100, theme);
  assert.equal(lines.length, 1);
  assert.match(plain(lines)[0]!, /← browser/);
  const line = lines[0]!;
  assert.match(
    plain(lines)[0]!,
    /^3 running, 2 stopped, 1 failed, 1 paused, 1 completed · ← browser\s+↑1\.4k ↓39$/,
  );
  for (const [color, text] of [
    ["accent", "3 running"],
    ["muted", "2 stopped"],
    ["error", "1 failed"],
    ["warning", "1 paused"],
    ["success", "1 completed"],
    ["muted", "↑1.4k ↓39"],
  ] as const) {
    assert.ok(line.includes(theme.fg(color, text)), `${color}: ${text}`);
  }
  assert.equal(visibleWidth(line), 100);
  assert.doesNotMatch(plain(lines)[0]!, /Agents|missing parent|\/root|Esc:|starting/);
  assert.deepEqual(threads, before);
});

test("minimal summary handles empty and settled agents, metrics boundaries, and narrow widths", () => {
  assert.deepEqual(renderAgentSummary([], 80, theme), []);
  assert.deepEqual(renderAgentSummary([thread("/root")], 80, theme), []);
  const settled = [
    thread("/root/completed", { state: "completed", inputTokens: 100, outputTokens: 200 }),
  ];
  const settledLines = plain(renderAgentSummary(settled, 80, theme));
  assert.equal(settledLines.length, 1);
  assert.match(settledLines[0]!, /^0 running, 1 completed\s+↑0 ↓0$/);

  const threads = [
    thread("/root/a", { inputTokens: 1_000_000, outputTokens: 1_500_000 }),
    thread("/root/b", { inputTokens: Number.NaN, outputTokens: -1 }),
    thread("/root/c", { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0.9 }),
    ...Array.from({ length: 20 }, (_, index) =>
      thread(`/root/paused${index}`, { state: "paused", inputTokens: 5_000, outputTokens: 6_000 }),
    ),
  ];
  assert.match(
    plain(renderAgentSummary(threads, 100, theme))[0]!,
    /^3 running, 20 paused · ← browser\s+↑1m ↓1.5m$/,
  );
  const counters = theme.fg("muted", "↑1m ↓1.5m");
  for (const width of [0, 1, 2, 4, 9, 10, 20, 40, 80, 100]) {
    const lines = renderAgentSummary(threads, width, theme);
    assert.equal(lines.length, 1);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      String(width),
    );
    const line = lines[0]!;
    assert.ok(visibleWidth(line) <= width, String(width));
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line)));
    if (width >= visibleWidth(counters)) assert.ok(line.endsWith(counters), String(width));
  }
});

test("updateWidget retains full default and switches minimal/full in TUI and RPC", () => {
  const calls: { content: unknown; options: unknown }[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme,
      setWidget: (_key: string, content: unknown, options: unknown) => {
        calls.push({ content, options });
      },
    },
  } as unknown as ExtensionContext;
  const threads = [thread("/root/job", { state: "completed", task: "Done" })];
  const renderLast = () => {
    const component = (
      calls.at(-1)!.content as (tui: { requestRender(): void }) => {
        render(width: number): string[];
        dispose(): void;
      }
    )({ requestRender() {} });
    const lines = component.render(80);
    component.dispose();
    return lines;
  };
  updateWidget(ctx, threads);
  const full = renderLast();
  assert.deepEqual(full, renderAgentTree(threads, 80, theme));
  updateWidget(ctx, threads, "minimal");
  assert.deepEqual(renderLast(), renderAgentSummary(threads, 80, theme));
  updateWidget(ctx, threads, "full");
  assert.deepEqual(renderLast(), full);

  ctx.mode = "rpc";
  updateWidget(ctx, threads, "minimal");
  assert.deepEqual(
    calls.at(-1)!.content,
    renderAgentSummary(threads, 80, theme, { showBrowserHint: false }),
  );
  assert.doesNotMatch(plain(calls.at(-1)!.content as string[]).join("\n"), /Press ←/);
  updateWidget(ctx, threads, "full");
  assert.deepEqual(
    calls.at(-1)!.content,
    renderAgentTree(threads, 80, theme, { showBrowserHint: false }),
  );
  updateWidget(ctx, [], "minimal");
  assert.equal(calls.at(-1)!.content, undefined);
  updateWidget(ctx, [thread("/root")], "minimal");
  assert.equal(calls.at(-1)!.content, undefined);
  assert.ok(
    calls.every((call) => (call.options as { placement: string }).placement === "aboveEditor"),
  );
});

test("full widget status strip resolves the current theme at render time", () => {
  let content: unknown;
  let current = theme;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      get theme() {
        return current;
      },
      setWidget: (_key: string, value: unknown) => {
        content = value;
      },
    },
  } as unknown as ExtensionContext;
  updateWidget(ctx, [thread("/root/job", { state: "completed" })]);
  const component = (
    content as (tui: { requestRender(): void }) => {
      render(width: number): string[];
      invalidate(): void;
      dispose(): void;
    }
  )({ requestRender() {} });
  const first = component.render(80);
  current = testTheme("light");
  component.invalidate();
  const second = component.render(80);
  assert.deepEqual(plain(second), plain(first));
  assert.notEqual(second.at(-1), first.at(-1));
  assert.equal(
    second.at(-1),
    current.fg("accent", "0 running") + current.fg("muted", " · → collapse"),
  );
  component.dispose();
});

test("minimal widget resolves live themes without allocating elapsed-time timers", (t) => {
  let content: unknown;
  let current = theme;
  const interval = t.mock.method(globalThis, "setInterval", () => {
    throw new Error("minimal mode has no elapsed time to repaint");
  });
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      get theme() {
        return current;
      },
      setWidget: (_key: string, value: unknown) => {
        content = value;
      },
    },
  } as unknown as ExtensionContext;
  updateWidget(ctx, [thread("/root/job", { inputTokens: 12, outputTokens: 3 })], "minimal");
  const component = (
    content as (tui: { requestRender(): void }) => {
      render(width: number): string[];
      invalidate(): void;
      dispose(): void;
    }
  )({ requestRender() {} });
  const first = component.render(80);
  assert.ok(first[0]!.includes(current.fg("accent", "1 running")));
  current = testTheme("light");
  component.invalidate();
  const second = component.render(80);
  assert.notDeepEqual(second, first);
  assert.deepEqual(plain(second), plain(first));
  assert.ok(second[0]!.includes(current.fg("accent", "1 running")));
  assert.ok(second[0]!.endsWith(current.fg("muted", "↑12 ↓3")));
  assert.equal(second.length, 1);
  assert.ok(second[0]!.includes(current.fg("muted", " · ← browser")));
  assert.equal(interval.mock.callCount(), 0);
  component.dispose();
});

