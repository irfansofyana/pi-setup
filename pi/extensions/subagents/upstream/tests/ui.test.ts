import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { quote } from "shell-quote";
import {
  colorToRgb,
  CURSOR_MARKER,
  rgbColor,
  stripTerminalSequences,
  styleText,
  visibleWidth,
  type Color,
} from "@earendil-works/pi-tui";
import {
  Theme,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import { DialogEditor, DialogMenu, dialogHeight } from "../src/ui/dialog.ts";
import { configureAgents } from "../src/ui/settings-ui.ts";
import { ToolPickerComponent } from "../src/ui/tool-picker.ts";
import { DEFAULT_MANAGER_SETTINGS } from "../src/prefs/settings.ts";
import { bindDialogDriver, createDialogDriver, dialogDriverFor } from "./helpers/dialogDriver.ts";
import { AGENT_COLORS, ConfigStore, parseAgentType, serializeAgentType } from "../src/prefs/config.ts";
import {
  editAgentTypes,
  editorArguments,
  renderThreads,
  sanitizeText,
  showThreads,
  updateWidget,
  type ThreadController,
} from "../src/ui/ui.ts";

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

function thread(path: string, overrides: Partial<ThreadView> = {}): ThreadView {
  return {
    path,
    parent: "/root",
    owner: "/root",
    type: "worker",
    state: "running",
    task: "Task",
    status: "Working",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function testTheme(
  appearance: "dark" | "light",
  mode: "truecolor" | "256color" = "truecolor",
): Theme {
  const foreground = appearance === "dark" ? "#eeeeee" : "#111111";
  const background = appearance === "dark" ? "#111111" : "#eeeeee";
  const colors = {
    ...Object.fromEntries(AGENT_COLORS.map((token) => [token, foreground])),
    accent: appearance === "dark" ? "#60a5fa" : "#1e40af",
    success: appearance === "dark" ? "#166534" : "#b7e4c7",
    warning: "#facc15",
    error: "#b91c1c",
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
  return new Theme(colors, backgrounds, mode, { appearance });
}

const darkTheme = testTheme("dark");
const lightTheme = testTheme("light");

/** Black text above the WCAG black/white crossover (~0.179), otherwise white. */
function contrastChannel(color: Color): 0 | 255 {
  const { r, g, b } = colorToRgb(color);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > Math.sqrt(0.0525) - 0.05 ? 0 : 255;
}

function badgeToken(color: string | undefined): ThemeColor {
  return AGENT_COLORS.includes(color as (typeof AGENT_COLORS)[number])
    ? (color as ThemeColor)
    : "accent";
}

function expectedBadge(theme: Theme, name: string, color?: string): string {
  const background = theme.colors[badgeToken(color)];
  const channel = contrastChannel(background);
  return styleText(
    ` ${sanitizeText(name)} `,
    { bg: background, fg: rgbColor(channel, channel, channel), bold: true },
    theme.getColorMode(),
  );
}

function expectedPath(theme: Theme, path: string, color?: string): string {
  return theme.fg(badgeToken(color), sanitizeText(path));
}

/** Zero-metric fixtures only. Counters are the literal unset label, padded, not truncated. */
function expectedThreadLine(theme: Theme, view: ThreadView, width = 80) {
  const token = view.state === "failed" ? "error" : view.state === "paused" ? "warning" : "accent";
  const left = `${expectedBadge(theme, view.type, view.color)} ${expectedPath(theme, view.path, view.color)} ${theme.fg(token, `[${sanitizeText(view.state)}]`)} ${sanitizeText(view.status || view.task)}`;
  const right = theme.fg("muted", "0s ↑0 ↓0");
  return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}

/** Visible text inside each background-color span. Resets are not part of the span. */
function backgroundCoveredText(line: string): string[] {
  const spans: string[] = [];
  const pattern = /\x1b\[48;(?:2(?:;\d+){3}|5;\d+)m/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const close = line.indexOf("\x1b[49m", match.index);
    assert.ok(close > match.index, "background SGR must reset");
    spans.push(stripTerminalSequences(line.slice(match.index, close)));
    pattern.lastIndex = close + "\x1b[49m".length;
  }
  return spans;
}

type WidgetComponent = { render(width: number): string[]; dispose(): void };

test("widget is compact, excludes current root, and reports hidden threads", () => {
  const threads = [
    thread("/root"),
    ...Array.from({ length: 10 }, (_, i) =>
      thread(`/worker${i}`, { state: "completed", updatedAt: i }),
    ),
    thread("/working", { updatedAt: 10 }),
    thread("/paused", { state: "paused", updatedAt: 12 }),
    thread("/starting", { state: "starting", updatedAt: 11 }),
  ];
  const lines = renderThreads(threads, 80, darkTheme);
  assert.equal(lines.length, 8);
  assert.ok(!lines.some((line) => line.includes("/root")));
  assert.match(lines[0]!, /\/starting/);
  assert.match(lines[1]!, /\/working/);
  assert.match(lines[2]!, /\/paused/);
  assert.match(lines[3]!, /\/worker9/);
  assert.match(lines.at(-1)!, /\+6 more threads · \/agents tree/);
  assert.equal(renderThreads(threads.slice(1, 9), 80, darkTheme).length, 8);
});

test("widget sanitizes hostile text, fits narrow widths, and keeps counters right-aligned", () => {
  assert.equal(sanitizeText("\x1b]0;owned\x07hello\r\nthere"), "hello  there");
  const hostile = "\x1b[31mred\x1b[0m\x1b]0;owned\x07\n\x00" + "界".repeat(30);
  const view = thread("/root/" + "p".repeat(180), {
    type: "researcher" + hostile,
    status: hostile,
    task: hostile,
    color: "success",
    elapsedMs: 65_000,
    inputTokens: 1_200,
    outputTokens: 34,
  });
  const styled = darkTheme.fg("muted", "1m5s ↑1.2k ↓34");
  for (const width of [0, 1, 4, 8, 16, 40, 80]) {
    const line = renderThreads([view], width, darkTheme)[0]!;
    assert.ok(visibleWidth(line) <= width);
    assert.ok(!CONTROL.test(stripTerminalSequences(line)));
    if (width >= visibleWidth(styled)) {
      assert.ok(line.endsWith(styled));
      assert.equal(visibleWidth(line), width);
    }
  }
});

test("widget counter literals cover duration steps and count boundaries", () => {
  const cases = [
    [65_000, 999, 1_000, "1m5s ↑999 ↓1k"],
    [3_600_000, 1_200, 999_999, "1h0m ↑1.2k ↓1m"],
    [86_400_000, 1_000_000, 1_500_000, "1d0h ↑1m ↓1.5m"],
    [-5, Number.NaN, -1, "0s ↑0 ↓0"],
  ] as const;
  for (const [elapsedMs, inputTokens, outputTokens, counters] of cases) {
    const line = stripTerminalSequences(
      renderThreads(
        [
          thread("/job", {
            state: "completed",
            elapsedMs,
            inputTokens,
            outputTokens,
          }),
        ],
        80,
        darkTheme,
      )[0]!,
    );
    assert.ok(line.endsWith(` ${counters}`), line);
  }
});

test("thread pills use the type color with contrasting text; state colors only the state label", () => {
  const channels = new Set<0 | 255>();
  for (const theme of [
    darkTheme,
    lightTheme,
    testTheme("dark", "256color"),
    testTheme("light", "256color"),
  ]) {
    for (const color of ["accent", "success", "warning", "text", "error"] as const) {
      const view = thread("/root/controller-security-research", {
        type: "researcher",
        color,
      });
      const line = renderThreads([view], 120, theme)[0]!;
      channels.add(contrastChannel(theme.colors[color]));
      assert.equal(line, expectedThreadLine(theme, view, 120));
      assert.deepEqual(backgroundCoveredText(line), [" researcher "]);
    }
  }
  assert.ok(channels.has(0), "a light background must use black text");
  assert.ok(channels.has(255), "a dark background must use white text");

  for (const state of ["failed", "paused", "starting", "completed", "stopped"] as const) {
    const view = thread("/worker", {
      type: "researcher",
      state,
      color: "success",
      status: "Busy",
      task: "Ignored",
    });
    const line = renderThreads([view], 80, darkTheme)[0]!;
    assert.equal(line, expectedThreadLine(darkTheme, view));
  }

  // Unknown colors fall back to accent; hostile type/path text is sanitized.
  const invalid = thread("/owned\x1b[31m", {
    type: "bad\x1b[31m",
    color: "\x1b[31mnot-a-token",
    state: "failed",
    status: "",
    task: "Recover",
  });
  const fallback = renderThreads([invalid], 100, darkTheme)[0]!;
  assert.equal(fallback, expectedThreadLine(darkTheme, invalid, 100));
  assert.ok(!CONTROL.test(stripTerminalSequences(fallback)));
});

test("widget resolves the theme at render time", () => {
  let content: unknown;
  let marker = "first";
  const tokenColor = (name: string) =>
    rgbColor(AGENT_COLORS.indexOf(name as (typeof AGENT_COLORS)[number]) + 1, 8, 9);
  const ctx = {
    hasUI: true,
    ui: {
      get theme() {
        const current = marker;
        return {
          fg: (color: string, text: string) => `${current}<fg:${color}>${text}</fg>`,
          colors: Object.fromEntries(AGENT_COLORS.map((name) => [name, tokenColor(name)])),
          style: (text: string, style: { bg?: Color }) =>
            `${current}<bg:${colorToRgb(style.bg!).r}>${text}</bg>`,
        };
      },
      setWidget: (_key: string, value: unknown) => {
        content = value;
      },
    },
  } as unknown as ExtensionContext;
  updateWidget(ctx, [
    thread("/worker", { color: "success" }),
    thread("/fallback", { type: "fallback", color: "\x1b[31m" }),
  ]);
  const widget = (content as (tui: unknown) => WidgetComponent)({
    requestRender() {},
  });
  assert.match(widget.render(200)[0]!, /first<fg:accent>Agents<\/fg>/);
  marker = "second";
  const second = widget.render(200).join("\n");
  assert.doesNotMatch(second, /first</);
  const bg = (name: string) => colorToRgb(tokenColor(name)).r;
  assert.ok(
    second.includes(`second<bg:${bg("accent")}> fallback </bg> second<fg:accent>/fallback</fg>`),
  );
  assert.ok(
    second.includes(`second<bg:${bg("success")}> worker </bg> second<fg:success>/worker</fg>`),
  );
  widget.dispose();
});

test("widget timer rerenders live elapsed and does not run when settled or headless", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const intervals = globalThis.setInterval;
  let unrefs = 0;
  globalThis.setInterval = ((fn: TimerHandler, ms?: number) => {
    const timer = intervals(fn, ms as number) as unknown as NodeJS.Timeout;
    const unref = timer.unref.bind(timer);
    timer.unref = () => {
      unrefs += 1;
      return unref();
    };
    return timer;
  }) as unknown as typeof setInterval;
  try {
    let renders = 0;
    let component: WidgetComponent | undefined;
    const tui = { requestRender: () => void (renders += 1) };
    const ctx = {
      hasUI: true,
      ui: {
        theme: darkTheme,
        setWidget: (_key: string, factory: unknown) => {
          component?.dispose();
          component = typeof factory === "function" ? (factory(tui) as WidgetComponent) : undefined;
        },
      },
    } as unknown as ExtensionContext;
    const line = () =>
      stripTerminalSequences(
        component!.render(100).find((row) => stripTerminalSequences(row).includes("↑")) ?? "",
      );
    const job = (patch: Partial<ThreadView>) =>
      thread("/root/job", { type: "researcher", ...patch });

    updateWidget(ctx, [
      job({ startedAt: 995_000, elapsedMs: 2_000, inputTokens: 10, outputTokens: 3 }),
    ]);
    assert.equal(unrefs, 1);
    assert.match(line(), /7s ↑10 ↓3$/);
    t.mock.timers.tick(1000);
    assert.equal(renders, 1);
    assert.match(line(), /8s ↑10 ↓3$/);

    renders = 0;
    updateWidget(ctx, [job({ startedAt: Date.now(), elapsedMs: 65_000 })]);
    t.mock.timers.tick(1000);
    assert.equal(renders, 1, "replacing a live widget must dispose the previous timer");
    assert.match(line(), /1m6s ↑0 ↓0$/);

    renders = 0;
    updateWidget(ctx, [thread("/done", { state: "completed", startedAt: 1, elapsedMs: 9_000 })]);
    assert.match(line(), /9s ↑0 ↓0$/);
    t.mock.timers.tick(5000);
    assert.equal(renders, 0);
    assert.equal(unrefs, 2);

    updateWidget(
      {
        hasUI: false,
        ui: {
          setWidget() {
            throw new Error("no ui");
          },
        },
      } as unknown as ExtensionContext,
      [thread("/hidden", { startedAt: 1_000_000 })],
    );
    t.mock.timers.tick(2000);
    assert.equal(renders, 0);
  } finally {
    globalThis.setInterval = intervals;
    t.mock.timers.reset();
  }
});

test("editor command accepts quoted argv but rejects shell operators", () => {
  assert.deepEqual(editorArguments('"/Applications/My Editor/bin/editor" --wait "a b"'), [
    "/Applications/My Editor/bin/editor",
    "--wait",
    "a b",
  ]);
  for (const command of ["", "vim; touch /tmp/owned", "vim | sh", "vim && echo x", "vim *.md"]) {
    assert.throws(() => editorArguments(command), /VISUAL\/EDITOR/);
  }
});

test("thread dialogs exclude root, discard viewer edits, and resume through steer", async () => {
  const views = [thread("/root"), thread("/worker", { state: "completed" })];
  const calls: string[] = [];
  const choices = [
    "/worker [completed] Working",
    "View transcript",
    "Send input / resume",
    "Back",
    undefined,
  ];
  const controller: ThreadController = {
    list: () => views,
    get: (path) => views.find((view) => view.path === path)!,
    output: () => "output",
    transcript: async () => "original transcript",
    steer: async (path, message) => {
      calls.push(`${path}: ${message}`);
      return views[1]!;
    },
    stop: async () => {
      throw new Error("unexpected stop");
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        assert.ok(!options.some((option) => option.startsWith("/root")));
        return choices.shift();
      },
      editor: async (title: string, text: string) => {
        if (title.includes("READ ONLY")) {
          assert.equal(text, "original transcript");
          return "ignored changes";
        }
        return "continue please";
      },
      notify: () => {
        throw new Error("unexpected notification");
      },
    },
  } as unknown as ExtensionCommandContext;
  await showThreads(ctx, controller);
  assert.deepEqual(calls, ["/worker: continue please"]);
});

function userAgentsDir(agentDir: string) {
  return join(agentDir, "subagent-manager", "agents");
}

async function configFixture(fileName = "worker.md") {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-ui-test-"));
  const agentDir = join(root, "global");
  await mkdir(userAgentsDir(agentDir), { recursive: true });
  const body = "# Instructions\n\nKeep **Markdown** and whitespace.\n\n";
  const file = join(userAgentsDir(agentDir), fileName);
  await writeFile(
    file,
    serializeAgentType({ name: "worker", description: "Worker", systemPrompt: body }),
  );
  const store = new ConfigStore({
    cwd: root,
    agentDir,
    bundledDir: join(root, "bundled"),
    includeProject: false,
  });
  /** Overwrite worker.md with extra fields and reload the store. */
  const writeWorker = async (patch: Record<string, unknown>) => {
    await writeFile(
      join(userAgentsDir(agentDir), "worker.md"),
      serializeAgentType({
        name: "worker",
        description: "Worker",
        systemPrompt: body,
        ...patch,
      }),
    );
    store.reload();
  };
  return { root, agentDir, store, body, file, writeWorker };
}

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof configFixture>>) => Promise<void>,
  fileName?: string,
) {
  const fixture = await configFixture(fileName);
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

const EDIT_FIELD_ACTIONS = new Set([
  "name",
  "description",
  "models",
  "modelSuggestions",
  "thinkingLevel",
  "tools.allow",
  "tools.block",
  "color",
  "icon",
  "systemPrompt",
]);

/** Map scripted bare field actions to decorated labels only in the main unsaved edit menu. */
function scriptedEditChoice(title: string, options: string[], choice: string) {
  if (!/^Edit .+ \(unsaved\)$/.test(title) || !EDIT_FIELD_ACTIONS.has(choice)) return choice;
  const label = options.find((option) => option.startsWith(`${choice}: `));
  assert.ok(label, `Missing decorated field label for ${choice}`);
  return label;
}

const TWO_MODELS = [
  { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
  { provider: "anthropic", id: "claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
];

function editorContext(
  root: string,
  choices: (string | undefined)[],
  inputs: (string | undefined)[] = [],
  options: {
    availableModels?: { provider: string; id: string; name: string }[];
    scopedModels?: string[];
  } = {},
) {
  const diagnostics: string[] = [];
  const scopes: string[][] = [];
  const menus: { title: string; options: string[] }[] = [];
  const frames: string[][] = [];
  const editors: { title: string; prefill?: string }[] = [];
  const driver = createDialogDriver({
    theme: darkTheme,
    width: 100,
    choices,
    inputs,
    menuLabels: (menu) =>
      menu.rows.map((row) => (EDIT_FIELD_ACTIONS.has(row.id) ? `${row.id}: ${row.value}` : row.id)),
    resolveChoice: scriptedEditChoice,
    onMenu(menu, labels) {
      menus.push({ title: menu.title, options: labels });
      if (menu.title === "Save scope") scopes.push(labels);
    },
    onEditor(editor) {
      editors.push({ title: editor.title, prefill: editor.prefill });
    },
    onFrame(component, lines) {
      if (component instanceof DialogMenu) frames.push(lines.map(stripTerminalSequences));
    },
  });
  const availableModels = options.availableModels ?? [];
  const scopedModels = (options.scopedModels ?? []).map((identity) => ({
    model: availableModels.find((entry) => `${entry.provider}/${entry.id}` === identity)!,
  }));
  const dialogOnly = async () => {
    throw new Error("Agent fields must use the bordered dialog editor");
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: root,
    modelRegistry: { getAvailable: () => availableModels },
    scopedModels,
    ui: {
      select: dialogOnly,
      input: dialogOnly,
      editor: dialogOnly,
      custom: driver.custom,
      notify: (message: string) => diagnostics.push(message),
      confirm: async () => false,
    },
  } as unknown as ExtensionCommandContext;
  bindDialogDriver(ctx, driver);
  return { ctx, diagnostics, scopes, menus, editors, frames, driver };
}

function unsavedMenus(menus: { title: string; options: string[] }[]) {
  return menus.filter((menu) => /^Edit .+ \(unsaved\)$/.test(menu.title));
}

/** Drive the model picker child by selecting values or pressing reorder keys. */
function pickModels(driver: ReturnType<typeof createDialogDriver>, values: string[]) {
  driver.onChild = (component) => {
    if (typeof component.getMode !== "function") return false;
    for (const value of values) {
      if (value === "key:ctrl-up") {
        component.handleInput("\u001B[1;5A");
        continue;
      }
      const item = component
        .getCurrentItems()
        .find((entry: { value: string }) => entry.value === value);
      assert.ok(item, `Missing model picker option: ${value}`);
      component.getSelectList().onSelect?.(item);
    }
    return true;
  };
}

test("agent editor is a bordered two-column form and edits the prompt body in a dialog", async () => {
  await withFixture(async ({ root, store }) => {
    const prompt = "# Updated prompt\n\nUse 日本語 and retain **Markdown**.\n";
    const { ctx, frames, editors, diagnostics } = editorContext(
      root,
      ["worker", "systemPrompt", "Save", "Global", undefined],
      [prompt],
    );
    await editAgentTypes(ctx, store);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /Saved/);
    assert.equal(store.get("worker")?.systemPrompt, prompt);
    assert.equal(editors[0]?.title, "Agent systemPrompt");
    const form = frames.find((frame) => frame[0]?.includes("Edit worker"))!;
    assert.match(form[0]!, /^╭.*╮$/);
    assert.match(form.at(-1)!, /^╰.*╯$/);
    assert.match(form.join("\n"), /Name +│ worker/);
  });
});

test("agent editor scope field and source are modal and do not modify the draft on cancel", async () => {
  await withFixture(async ({ root, store, body }) => {
    const { ctx, scopes, diagnostics } = editorContext(
      root,
      ["worker", "Source", "Save scope", "Global", "systemPrompt", "Cancel", undefined],
      ["discard me"],
    );
    await editAgentTypes(ctx, store);
    assert.deepEqual(scopes, [["Global"]]);
    assert.equal(store.get("worker")?.systemPrompt, body);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /worker\.md/);
  });
});

test("type field editor handles YAML fields without changing Markdown", async () => {
  await withFixture(async ({ root, store, body }) => {
    const { ctx, driver } = editorContext(
      root,
      [
        "worker",
        "name",
        "description",
        "thinkingLevel",
        "high",
        "tools.allow",
        "tools.block",
        "color",
        "success",
        "Save",
        "Global",
        undefined,
      ],
      ["renamed", "New description"],
    );
    let picker = 0;
    driver.onChild = (component) => {
      if (!(component instanceof ToolPickerComponent)) return false;
      const values = picker++ === 0 ? ["action:empty", "action:done"] : ["tool:bash", "tool:read", "action:done"];
      for (const value of values) component.getSelectList().onSelect!(component.getCurrentItems().find((item) => item.value === value)!);
      return true;
    };
    await editAgentTypes(ctx, store, false, {
      getAllTools: () => [{ name: "bash", description: "Run shell" }, { name: "read", description: "Read file" }],
      toolFiltering: "allowed",
    });
    const saved = store.get("renamed");
    assert.equal(saved.description, "New description");
    assert.equal(saved.thinkingLevel, "high");
    assert.equal(saved.color, "success");
    assert.deepEqual(saved.tools, { allow: [], block: ["bash", "read"] });
    assert.equal(saved.systemPrompt, body);
    assert.equal(
      store.get("worker").systemPrompt,
      body,
      "renaming must leave the original file intact",
    );
  });
});

test("model picker uses current draft suggestions, including unsaved edits to them", async () => {
  await withFixture(async ({ root, store, writeWorker }) => {
    await writeWorker({ modelSuggestions: ["GPT"] });
    const { ctx, driver } = editorContext(
      root,
      ["worker", "models", "modelSuggestions", "models", "Save", "Global", undefined],
      ["snnt"],
      {
        availableModels: TWO_MODELS,
        scopedModels: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
      },
    );
    const pickerOrders: string[][] = [];
    driver.onChild = (component) => {
      if (typeof component.getMode !== "function") return false;
      pickerOrders.push(
        component.getCurrentItems()
          .filter((item: { value: string }) => !item.value.startsWith("action:"))
          .map((item: { value: string }) => item.value),
      );
      if (pickerOrders.length === 1) {
        // Suggestions order the picker but do not commit model preferences.
        component.handleInput("\u001B");
      } else {
        component.handleInput("\r");
        const done = component
          .getCurrentItems()
          .find((item: { value: string }) => item.value === "action:done");
        component.getSelectList().onSelect?.(done);
      }
      return true;
    };
    await editAgentTypes(ctx, store);
    assert.deepEqual(pickerOrders, [
      ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
      ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1"],
    ]);
    assert.deepEqual(store.get("worker").modelSuggestions, ["snnt"]);
    assert.deepEqual(store.get("worker").models, ["anthropic/claude-3.7-sonnet"]);
  });
});

test("legacy scalar model opens the ordered picker and cancel keeps the saved definition", async () => {
  await withFixture(async ({ root, store, body, file }) => {
    const legacy = `---\nname: worker\ndescription: Worker\nmodel: openai/gpt-4.1\n---\n${body}`;
    await writeFile(file, legacy);
    store.reload();
    const { ctx, driver } = editorContext(root, ["worker", "models", "Cancel", undefined], [], {
      availableModels: TWO_MODELS,
      scopedModels: ["openai/gpt-4.1"],
    });
    const observed = { mode: "", label: "" };
    driver.onChild = (component) => {
      if (typeof component.getMode !== "function") return false;
      const first = component.getCurrentItems()[0];
      observed.mode = component.getMode();
      observed.label = first?.label ?? "";
      component.handleInput("\u001B");
      return true;
    };
    await editAgentTypes(ctx, store);
    assert.equal(observed.mode, "picker");
    assert.equal(observed.label, "[x] 1. openai/gpt-4.1");
    assert.deepEqual(store.get("worker").models, ["openai/gpt-4.1"]);
    assert.equal(await readFile(file, "utf8"), legacy);
  });
});

test("saving model preferences stores canonical ordered models after add and reorder", async () => {
  await withFixture(async ({ root, store, body }) => {
    const { ctx, driver } = editorContext(
      root,
      ["worker", "models", "Save", "Global", undefined],
      [],
      {
        availableModels: [
          ...TWO_MODELS,
          { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        ],
        scopedModels: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
      },
    );
    pickModels(driver, [
      "openai/gpt-4.1",
      "anthropic/claude-3.7-sonnet",
      "key:ctrl-up",
      "action:done",
    ]);
    await editAgentTypes(ctx, store);
    const saved = store.get("worker");
    assert.deepEqual(saved.models, ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1"]);
    assert.equal(saved.systemPrompt, body);
    const persisted = await readFile(saved.filePath!, "utf8");
    assert.match(persisted, /models:\n  - anthropic\/claude-3\.7-sonnet\n  - openai\/gpt-4\.1/);
    assert.doesNotMatch(persisted, /\nmodel:/);
  });
});

function driveColorPicker(
  ctx: ExtensionCommandContext,
  theme: Theme,
  drive: (component: any) => void,
) {
  let pickerError: unknown;
  const driver = dialogDriverFor(ctx);
  driver.theme = theme;
  driver.onChild = (component) => {
    if (component instanceof DialogMenu || component instanceof DialogEditor || !component.getItems)
      return false;
    try {
      drive(component);
    } catch (error) {
      pickerError = error;
      component.getSelectList?.().onCancel?.();
    }
    return true;
  };
  return () => {
    if (pickerError) throw pickerError;
  };
}

/** Preview paints the type pill and a sample task path, matching the widget — not a path pill. */
function assertColorPreview(
  component: any,
  theme: Theme,
  agentName: string,
  color: string | undefined,
) {
  const preview = component.getPreview().render(160).join("\n");
  const path = expectedPath(theme, "/root/example-task", color);
  const head = `${expectedBadge(theme, agentName, color)} ${path} ${theme.fg("accent", "[running]")} Working`;
  assert.ok(preview.includes(`Preview: ${head}`));
  assert.deepEqual(backgroundCoveredText(preview), [` ${agentName} `]);
}

const selectedValue = (component: any) => component.getSelectList().getSelectedItem()?.value;

function selectDefaultColor(component: any) {
  for (
    let step = 0;
    step < AGENT_COLORS.length && selectedValue(component) !== "__default__";
    step++
  )
    component.handleInput("\x1b[A");
  assert.equal(selectedValue(component), "__default__");
}

test("agent picker uses runtime name pills with definition colors and no brackets", async () => {
  await withFixture(async ({ root, store, writeWorker }) => {
    for (const theme of [darkTheme, lightTheme, testTheme("dark", "256color")]) {
      for (const color of [undefined, "success", "warning"]) {
        await writeWorker({ color });
        const { ctx, driver } = editorContext(root, [undefined]);
        driver.theme = theme;
        let checked = false;
        driver.onChild = (component) => {
          if (!(component instanceof DialogMenu) || component.title !== "Agent types") return false;
          const index = component.rows.findIndex((row) => row.id === "worker");
          assert.ok(index >= 0);
          for (const selected of [false, true]) {
            if (selected) {
              component.handleInput("\x1b[H");
              for (let step = 0; step < index; step++) component.handleInput("\x1b[B");
              assert.equal(component.getSelectedId(), "worker");
            }
            const lines: string[] = component.render(100);
            const row: string = lines.find((line) => stripTerminalSequences(line).includes("worker"))!;
            assert.ok(row.includes(expectedBadge(theme, "worker", color)));
            assert.deepEqual(backgroundCoveredText(row), [" worker "]);
            assert.doesNotMatch(stripTerminalSequences(row), /\[worker\]/);
            for (const width of [1, 10, 40, 100]) {
              const narrow = component.render(width);
              assert.ok(narrow.every((line) => visibleWidth(line) <= width));
              assert.equal(narrow.length, width < 4 ? 1 : dialogHeight({ terminal: { rows: 24 }, requestRender() {} }));
            }
          }
          checked = true;
          component.handleInput("\x1b");
          return true;
        };
        await editAgentTypes(ctx, store);
        assert.ok(checked);
      }
    }
  });
});

test("color picker shows background pills, previews the draft name, and cancel keeps the saved color", async () => {
  await withFixture(async ({ root, store, file, writeWorker }) => {
    await writeWorker({ color: "success" });
    const original = await readFile(file, "utf8");
    const { ctx } = editorContext(root, ["worker", "name", "color", undefined], ["scout"]);
    const pickerError = driveColorPicker(ctx, darkTheme, (component) => {
      const items = component.getItems();
      assert.deepEqual(
        items.map((item: { value: string }) => item.value),
        ["__default__", ...AGENT_COLORS],
      );
      for (const item of items.slice(1))
        assert.equal(item.label, expectedBadge(darkTheme, item.value, item.value));
      assert.equal(selectedValue(component), "success");
      assertColorPreview(component, darkTheme, "scout", "success");
      component.handleInput("\x1b[B");
      assert.equal(selectedValue(component), "error");
      assertColorPreview(component, darkTheme, "scout", "error");
      selectDefaultColor(component);
      assertColorPreview(component, darkTheme, "scout", undefined);
      component.handleInput("\x1b");
    });
    await editAgentTypes(ctx, store);
    pickerError();
    assert.equal(store.get("worker").color, "success");
    assert.equal(await readFile(file, "utf8"), original);
  });
});

test("color picker default unsets a configured color", async () => {
  await withFixture(async ({ root, store, writeWorker }) => {
    await writeWorker({ color: "success" });
    const { ctx } = editorContext(root, ["worker", "color", "Save", "Global", undefined]);
    const pickerError = driveColorPicker(ctx, lightTheme, (component) => {
      selectDefaultColor(component);
      assertColorPreview(component, lightTheme, "worker", undefined);
      component.handleInput("\r");
    });
    await editAgentTypes(ctx, store);
    pickerError();
    const saved = store.get("worker");
    assert.equal(saved.color, undefined);
    assert.doesNotMatch(await readFile(saved.filePath!, "utf8"), /^color:/m);
  });
});

test("invalid field edits and untrusted project saves leave configuration unchanged", async () => {
  await withFixture(async ({ root, store, body }) => {
    const { ctx, diagnostics, scopes } = editorContext(
      root,
      [
        "worker",
        "name",
        "Edit frontmatter YAML",
        "Cancel",
        "Save",
        undefined,
        "Cancel",
        undefined,
      ],
      ["../escape", "name: worker\ndescription: Worker\ntools:\n  allow: [read, read]"],
    );
    await editAgentTypes(ctx, store);
    assert.equal(store.get("worker").systemPrompt, body);
    assert.equal(store.get("worker").tools, undefined);
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(scopes, [["Global"]]);
  });
});

test("editing a noncanonical filename in preferred storage updates that file in place", async () => {
  await withFixture(async ({ root, store, agentDir, body, file }) => {
    const { ctx } = editorContext(
      root,
      ["worker", "description", "Save", "Global", undefined],
      ["Revised"],
    );
    await editAgentTypes(ctx, store);
    assert.deepEqual(await readdir(userAgentsDir(agentDir)), ["custom.md"]);
    const saved = store.get("worker");
    assert.equal(saved.description, "Revised");
    assert.equal(saved.filePath, file);
    assert.equal(saved.systemPrompt, body);
  }, "custom.md");
});

test("renaming a type cannot overwrite an existing definition", async () => {
  await withFixture(async ({ root, store, agentDir }) => {
    const content = serializeAgentType({
      name: "other",
      description: "Other",
      systemPrompt: "Original",
    });
    const other = join(userAgentsDir(agentDir), "other.md");
    await writeFile(other, content);
    store.reload();
    const { ctx, diagnostics } = editorContext(
      root,
      ["worker", "name", "Save", "Global", "Cancel", undefined],
      ["other"],
    );
    await editAgentTypes(ctx, store);
    assert.match(diagnostics[0]!, /already exists/);
    assert.equal(await readFile(other, "utf8"), content);
  });
});

test("external invalid edit restores draft, reports diagnostics, and restarts TUI", async () => {
  const visual = process.env.VISUAL;
  try {
    await withFixture(async ({ root, store, file }) => {
      process.env.VISUAL = quote([
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], "---\\nname: bad\\ndescription: bad\\nmodel: invalid\\n---\\nchanged")',
      ]);
      const original = await readFile(file, "utf8");
      const { ctx, diagnostics, driver } = editorContext(root, [
        "worker",
        "External editor (entire Markdown)",
        "Cancel",
        "Save",
        "Global",
        undefined,
      ]);
      const terminalEvents: string[] = [];
      driver.onPassthrough = (factory) =>
        new Promise((done, reject) => {
          try {
            factory(
              {
                stop: () => terminalEvents.push("stop"),
                start: () => terminalEvents.push("start"),
                requestRender: () => terminalEvents.push("render"),
              },
              {},
              {},
              done,
            );
          } catch (error) {
            reject(error);
          }
        });
      await editAgentTypes(ctx, store);
      assert.deepEqual(terminalEvents, ["stop", "start", "render"]);
      assert.match(diagnostics[0]!, /Edit not accepted.*model/);
      assert.equal(await readFile(file, "utf8"), original);
    });
  } finally {
    if (visual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = visual;
  }
});

test("frontmatter editor retries invalid YAML and preserves Markdown on save", async () => {
  await withFixture(async ({ root, store, body }) => {
    const { ctx, diagnostics, editors } = editorContext(
      root,
      ["worker", "Edit frontmatter YAML", "Retry", "Save", "Global", undefined],
      [
        "name: worker\ndescription: Worker\nthinkingLevel: impossible",
        "name: worker\ndescription: Revised\ncolor: muted",
      ],
    );
    await editAgentTypes(ctx, store);
    assert.equal(editors.length, 2);
    assert.equal(store.get("worker").description, "Revised");
    assert.equal(store.get("worker").systemPrompt, body);
    assert.match(diagnostics[0]!, /Edit not accepted/);
  });
});

const INHERIT = "Default (inherit)";
const UNSET = "Unset (use default policy)";

function fieldLabels(fields: {
  name: string;
  description: string;
  models?: string;
  thinkingLevel?: string;
  allow?: string;
  block?: string;
  color?: string;
}): string[] {
  return [
    "Customization",
    `name: ${fields.name}`,
    `description: ${fields.description}`,
    `models: ${fields.models ?? INHERIT}`,
    "modelSuggestions: None",
    `thinkingLevel: ${fields.thinkingLevel ?? INHERIT}`,
    `tools.allow: ${fields.allow ?? UNSET}`,
    `tools.block: ${fields.block ?? UNSET}`,
    `color: ${fields.color ?? INHERIT}`,
    "icon: None",
    "systemPrompt: 5 lines · 51 characters",
    "Save scope",
    "Source",
    "Edit frontmatter YAML",
    "External editor (entire Markdown)",
    "Save",
    "Cancel",
  ];
}

test("edit menu shows current values, ordered models, legacy scalars, and tool policy states", async () => {
  await withFixture(async ({ root, store, agentDir, body, writeWorker }) => {
    const hostile = "Worker\x1b[31mred\x1b[0m\x1b]0;owned\x07\r\nnext";
    await writeFile(
      join(userAgentsDir(agentDir), "legacy.md"),
      `---\nname: legacy\ndescription: Legacy scalar\nmodel: google/gemini-2.5-pro\n---\n${body}`,
    );
    await writeFile(
      join(userAgentsDir(agentDir), "empty.md"),
      serializeAgentType({
        name: "empty",
        description: "Explicit empty tools",
        systemPrompt: body,
        tools: { allow: [], block: [] },
      }),
    );
    await writeWorker({
      description: hostile,
      models: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
      thinkingLevel: "high",
      color: "success",
      tools: { allow: ["bash", "read"], block: ["edit"] },
    });
    const { ctx, menus } = editorContext(root, [
      "worker",
      "Cancel",
      "legacy",
      "Cancel",
      "empty",
      "Cancel",
      undefined,
    ]);
    await editAgentTypes(ctx, store);
    const editMenus = unsavedMenus(menus);
    assert.deepEqual(
      editMenus.map((menu) => menu.title),
      ["Edit worker (unsaved)", "Edit legacy (unsaved)", "Edit empty (unsaved)"],
    );
    assert.deepEqual(
      editMenus[0]!.options,
      fieldLabels({
        name: "worker",
        description: sanitizeText(hostile),
        models: "openai/gpt-4.1, anthropic/claude-3.7-sonnet",
        thinkingLevel: "high",
        allow: "bash, read",
        block: "edit",
        color: "success",
      }),
    );
    assert.ok(editMenus[0]!.options.every((option) => !CONTROL.test(option)));
    assert.deepEqual(
      editMenus[1]!.options,
      fieldLabels({
        name: "legacy",
        description: "Legacy scalar",
        models: "google/gemini-2.5-pro",
      }),
    );
    assert.deepEqual(
      editMenus[2]!.options,
      fieldLabels({
        name: "empty",
        description: "Explicit empty tools",
        allow: "Empty list",
        block: "Empty list",
      }),
    );
  });
});

test("field editor prefills current values and cancelled or invalid edits keep the visible draft", async () => {
  await withFixture(async ({ root, store, body, writeWorker }) => {
    await writeWorker({ tools: { allow: ["read"], block: ["bash"] } });
    const { ctx, menus, editors, diagnostics, driver } = editorContext(
      root,
      [
        "worker",
        "name",
        "name",
        "description",
        "tools.allow",
        "tools.block",
        "tools.allow",
        "name",
        "Cancel",
        undefined,
      ],
      // rename, cancel, empty description, unsafe name
      ["renamed", undefined, "", "../escape"],
    );
    let picker = 0;
    const initial: (readonly string[] | undefined)[] = [];
    driver.onChild = (component) => {
      if (!(component instanceof ToolPickerComponent)) return false;
      initial.push(component.getDraftTools() === undefined ? undefined : [...component.getDraftTools()!]);
      const values = picker++ === 0 ? ["tool:read", "tool:bash", "tool:edit", "action:done"] : ["action:cancel"];
      for (const value of values) component.getSelectList().onSelect!(component.getCurrentItems().find((item) => item.value === value)!);
      return true;
    };
    await editAgentTypes(ctx, store, false, {
      getAllTools: () => ["read", "bash", "edit"].map((name) => ({ name, description: name })),
      toolFiltering: "allowed",
    });
    assert.deepEqual(initial, [["read"], ["bash"], ["bash", "edit"]]);
    assert.deepEqual(editors, [
      { title: "Agent name", prefill: "worker" },
      { title: "Agent name", prefill: "renamed" },
      { title: "Agent description", prefill: "Worker" },
      { title: "Agent name", prefill: "renamed" },
    ]);
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(
      unsavedMenus(menus).at(-1)!.options,
      fieldLabels({
        name: "renamed",
        description: "Worker",
        allow: "bash, edit",
        block: "bash",
      }),
    );
    assert.equal(store.get("worker").name, "worker");
    assert.deepEqual(store.get("worker").tools, { allow: ["read"], block: ["bash"] });
    assert.equal(store.get("worker").systemPrompt, body);
  });
});

test("agent save shows warning-colored changes for edited and new drafts, clearing on revert", async () => {
  await withFixture(async ({ root, store }) => {
    const original = store.get("worker");
    const { ctx, driver } = editorContext(
      root,
      [
        "worker", "description", "description", "description", "Edit frontmatter YAML",
        "Cancel", "Create new type", "Cancel", undefined,
      ],
      [undefined, "Changed description", original.description, undefined],
    );
    const saves: { value?: string; valueColor?: string }[] = [];
    driver.onChild = (component) => {
      if (component instanceof DialogMenu && component.title.startsWith("Edit ")) {
        const save = component.rows.find((row) => row.id === "Save")!;
        assert.equal(save.label, "Save");
        saves.push({ value: save.value, valueColor: save.valueColor });
        component.handleInput("\x1b[F");
        const rendered = component.render(100).join("\n");
        if (save.value) {
          assert.match(stripTerminalSequences(rendered), /Save\s+│ \(changes\)/);
          assert.ok(rendered.includes(darkTheme.fg("warning", "(changes)")));
        }
      }
      return false;
    };
    await editAgentTypes(ctx, store);
    assert.deepEqual(saves, [
      { value: "", valueColor: undefined },
      { value: "", valueColor: undefined },
      { value: "(changes)", valueColor: "warning" },
      { value: "", valueColor: undefined },
      { value: "", valueColor: undefined },
      { value: "(changes)", valueColor: "warning" },
    ]);
  });
});

test("description editor prefills sanitized text and unchanged submits keep the raw original", async () => {
  await withFixture(async ({ root, store, body, writeWorker }) => {
    const hostile = "  keep\x1b[31mred\x1b[0m\x1b]0;owned\x07\r\n\tline\rrest\ntab\there  ";
    const prefill = hostile
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map(sanitizeText)
      .join("\n");
    await writeWorker({ description: hostile });
    const { ctx, editors } = editorContext(
      root,
      ["worker", "description", "description", "description", "Save", "Global", undefined],
      [undefined, prefill, prefill.trim()],
    );
    await editAgentTypes(ctx, store);
    assert.deepEqual(
      editors.map((call) => call.prefill),
      [prefill, prefill, prefill],
    );
    assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(prefill));
    const saved = store.get("worker");
    assert.equal(saved.description, hostile);
    assert.equal(parseAgentType(await readFile(saved.filePath!, "utf8")).description, hostile);
    assert.equal(saved.systemPrompt, body);
  });
});

function assertOneOverlay(driver: ReturnType<typeof createDialogDriver>, label: string) {
  const { outerOpens, outerCompletions, forcedRenders } = driver.stats;
  assert.deepEqual(
    { outerOpens, outerCompletions, forcedRenders },
    { outerOpens: 1, outerCompletions: 1, forcedRenders: 0 },
    label,
  );
}

test("agent definition edits including model, color, and text use one overlay", async () => {
  await withFixture(async ({ root, store }) => {
    const prompt = "Be brief.";
    const { ctx, driver } = editorContext(
      root,
      [
        "worker",
        "name",
        "description",
        "color",
        "success",
        "models",
        "systemPrompt",
        "Save",
        "Global",
        undefined,
      ],
      ["scout", "Field notes", prompt],
      { availableModels: TWO_MODELS },
    );
    pickModels(driver, ["openai/gpt-4.1", "action:done"]);
    const pick = driver.onChild!;
    driver.onChild = (component) => {
      if (driver.session && component instanceof DialogEditor) {
        driver.session.focused = true;
        assert.equal(component.focused, true);
        assert.ok(driver.session.render(100).some((line: string) => line.includes(CURSOR_MARKER)));
      }
      return pick(component);
    };
    await editAgentTypes(ctx, store);
    const saved = store.get("scout");
    assert.equal(saved.description, "Field notes");
    assert.equal(saved.systemPrompt, prompt);
    assert.equal(saved.color, "success");
    assert.deepEqual(saved.models, ["openai/gpt-4.1"]);
    assertOneOverlay(driver, "agent definition edits");
    const height = dialogHeight({ requestRender() {}, terminal: { rows: 24 } });
    assert.ok(driver.stats.frameHeights.length >= 3);
    assert.ok(driver.stats.frameHeights.every((lines) => lines === height));
  });
});

test("nested definition editor from settings uses one overlay", async () => {
  await withFixture(async ({ root, agentDir, store }) => {
    const { ctx, driver } = editorContext(
      root,
      ["types", "worker", "description", "Cancel", undefined, "cancel"],
      ["Nested edit"],
    );
    ctx.isProjectTrusted = () => false;
    let applied = 0;
    await configureAgents(ctx, {
      store,
      agentDir,
      settings: { ...DEFAULT_MANAGER_SETTINGS },
      apply: () => {
        applied++;
      },
    });
    assert.equal(applied, 0);
    assert.equal(store.get("worker").description, "Worker");
    assertOneOverlay(driver, "nested definition editor");
  });
});

test("custom icon editor validates, cancels, saves, prefills, and removes optional glyphs", async () => {
  await withFixture(async ({ root, store }) => {
    const run = async (choices: (string | undefined)[], inputs: (string | undefined)[]) => {
      const context = editorContext(root, choices, inputs);
      await editAgentTypes(context.ctx, store, true);
      return context;
    };
    const invalid = await run(["worker", "icon", "Cancel", undefined], ["nf-fa-code"]);
    assert.match(invalid.diagnostics.join("\n"), /icon must be/);
    assert.equal(store.get("worker").icon, undefined);
    await run(["worker", "icon", "Cancel", undefined], ["\uf121"]);
    assert.equal(store.get("worker").icon, undefined);
    await run(["worker", "icon", "Save", "Global", undefined], ["\u{f0821}"]);
    assert.equal(store.get("worker").icon, "\u{f0821}");
    const cancelled = await run(["worker", "icon", "Cancel", undefined], [undefined]);
    assert.equal(cancelled.editors[0]!.prefill, "\u{f0821}");
    assert.equal(store.get("worker").icon, "\u{f0821}");
    await run(["worker", "icon", "Save", "Global", undefined], ["  "]);
    assert.equal(store.get("worker").icon, undefined);
    assert.doesNotMatch(await readFile(store.get("worker").filePath!, "utf8"), /icon:/);
  });
});

test("model suggestion editor shows sanitized names and preserves them across cancel and other edits", async () => {
  await withFixture(async ({ root, store, writeWorker }) => {
    const suggestions = ["Claude\x1b[31m Opus\x1b[0m", "GPT"];
    await writeWorker({ models: ["openai/gpt-4.1"], modelSuggestions: suggestions });
    const shown = `modelSuggestions: ${sanitizeText(suggestions.join(", "))}`;
    const { ctx, menus, editors } = editorContext(
      root,
      ["worker", "modelSuggestions", "description", "Cancel", undefined],
      [undefined, "Revised description"],
    );
    await editAgentTypes(ctx, store);
    const editMenus = unsavedMenus(menus);
    assert.ok(editMenus.every((menu) => menu.options.includes(shown)));
    assert.ok(editMenus[2]!.options.includes("description: Revised description"));
    assert.equal(editors[0]?.title, "Agent modelSuggestions (one display name per line)");
    assert.equal(editors[0]?.prefill, suggestions.map(sanitizeText).join("\n"));
    assert.deepEqual(store.get("worker").modelSuggestions, suggestions);
  });
});

test("model suggestion edits save display names, reject duplicates, empty clears, and other saves keep an explicit empty list", async () => {
  await withFixture(async ({ root, store, writeWorker }) => {
    await writeWorker({
      models: ["openai/gpt-4.1"],
      modelSuggestions: ["Claude Opus", "GPT"],
    });
    const run = async (choices: (string | undefined)[], inputs: (string | undefined)[]) => {
      const context = editorContext(root, choices, inputs);
      await editAgentTypes(context.ctx, store);
      return context;
    };
    const persisted = () => readFile(store.get("worker").filePath!, "utf8");

    const duplicate = await run(["worker", "modelSuggestions", "Cancel", undefined], ["GPT\nGPT"]);
    assert.match(duplicate.diagnostics.join("\n"), /duplicate/);
    assert.ok(
      unsavedMenus(duplicate.menus).at(-1)!.options.includes("modelSuggestions: Claude Opus, GPT"),
    );

    await run(["worker", "modelSuggestions", "Save", "Global", undefined], ["Sonnet\n\n GPT \n"]);
    assert.deepEqual(store.get("worker").modelSuggestions, ["Sonnet", "GPT"]);
    assert.deepEqual(store.get("worker").models, ["openai/gpt-4.1"]);
    assert.match(await persisted(), /modelSuggestions:\n  - Sonnet\n  - GPT/);

    await run(["worker", "modelSuggestions", "Save", "Global", undefined], ["\n  \n"]);
    assert.equal(store.get("worker").modelSuggestions, undefined);
    assert.doesNotMatch(await persisted(), /modelSuggestions/);

    await writeWorker({ modelSuggestions: [] });
    const keptEmpty = await run(
      ["worker", "modelSuggestions", "description", "Save", "Global", undefined],
      ["", "Still empty"],
    );
    assert.equal(keptEmpty.editors[0]?.prefill, "");
    assert.deepEqual(store.get("worker").modelSuggestions, []);
    assert.equal(store.get("worker").description, "Still empty");
    assert.match(await persisted(), /modelSuggestions: \[\]/);
  });
});

async function bundledFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-override-ui-"));
  const agentDir = join(root, "global");
  const bundledDir = join(root, "bundled");
  await mkdir(userAgentsDir(agentDir), { recursive: true });
  await mkdir(bundledDir, { recursive: true });
  const body = "# Bundled prompt\n\nFollow the task.\n";
  await writeFile(
    join(bundledDir, "coder.md"),
    serializeAgentType({
      name: "coder",
      description: "Bundled coder",
      systemPrompt: body,
      thinkingLevel: "high",
    }),
  );
  const store = new ConfigStore({ cwd: root, agentDir, bundledDir, includeProject: false });
  return { root, agentDir, bundledDir, store, body };
}

test("bundled tweak-settings saves a sparse .yml and locks prompt and name", async () => {
  const fixture = await bundledFixture();
  try {
    const run = async (choices: (string | undefined)[], inputs: (string | undefined)[] = []) => {
      const context = editorContext(fixture.root, choices, inputs);
      await editAgentTypes(context.ctx, fixture.store);
      return context;
    };
    const locked = await run(["coder", "override", "systemPrompt", "name", "Cancel", undefined]);
    assert.equal(locked.editors.length, 0);
    assert.match(locked.diagnostics.join("\n"), /bundled definition/);
    assert.match(locked.diagnostics.join("\n"), /cannot rename/);
    assert.deepEqual(await readdir(userAgentsDir(fixture.agentDir)), []);
    assert.ok(
      locked.menus.some((menu) => menu.title === "Customize coder"),
      "mode picker appears before any setting can change",
    );

    await run(["coder", "override", "thinkingLevel", "low", "Save", "Global", undefined]);
    assert.deepEqual(await readdir(userAgentsDir(fixture.agentDir)), ["coder.yml"]);
    assert.equal(fixture.store.get("coder").thinkingLevel, "low");
    assert.equal(fixture.store.get("coder").systemPrompt, fixture.body);
    assert.equal(fixture.store.get("coder").customization?.kind, "override");
    assert.equal(
      await readFile(join(userAgentsDir(fixture.agentDir), "coder.yml"), "utf8"),
      "name: coder\nthinkingLevel: low\n",
    );
    assert.equal(
      await readFile(join(fixture.bundledDir, "coder.md"), "utf8"),
      serializeAgentType({
        name: "coder",
        description: "Bundled coder",
        systemPrompt: fixture.body,
        thinkingLevel: "high",
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Reset to bundled deletes the override and restores the shipped agent", async () => {
  const fixture = await bundledFixture();
  try {
    const run = async (choices: (string | undefined)[]) => {
      const context = editorContext(fixture.root, choices);
      await editAgentTypes(context.ctx, fixture.store);
      return context;
    };
    const first = await run(["coder", "override", "Cancel", undefined]);
    assert.ok(!first.menus.some((m) => m.options.includes("Reset to bundled")));
    await run(["coder", "override", "thinkingLevel", "low", "Save", "Global", undefined]);
    assert.equal(fixture.store.get("coder").thinkingLevel, "low");
    const kept = await run(["coder", "Reset to bundled", "keep", "Cancel", undefined]);
    assert.ok(kept.menus.some((m) => m.options.includes("Reset to bundled")));
    assert.deepEqual(await readdir(userAgentsDir(fixture.agentDir)), ["coder.yml"]);
    const reset = await run(["coder", "Reset to bundled", "reset", undefined]);
    assert.match(reset.diagnostics.join("\n"), /Reset coder/);
    assert.deepEqual(await readdir(userAgentsDir(fixture.agentDir)), []);
    assert.equal(fixture.store.get("coder").thinkingLevel, "high");
    assert.equal(fixture.store.get("coder").source, "bundled");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bundled fork copies the full definition including prompt edits", async () => {
  const fixture = await bundledFixture();
  try {
    const prompt = "# Forked prompt\n\nMy own instructions.\n";
    const context = editorContext(
      fixture.root,
      ["coder", "fork", "systemPrompt", "Save", "Global", undefined],
      [prompt],
    );
    await editAgentTypes(context.ctx, fixture.store);
    assert.deepEqual(await readdir(userAgentsDir(fixture.agentDir)), ["coder.md"]);
    assert.equal(fixture.store.get("coder").systemPrompt, prompt);
    assert.equal(fixture.store.get("coder").customization?.kind, "fork");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancelling the customization picker leaves bundled definitions untouched", async () => {
  const fixture = await bundledFixture();
  try {
    const context = editorContext(fixture.root, ["coder", undefined, undefined]);
    await editAgentTypes(context.ctx, fixture.store);
    assert.deepEqual(await readdir(userAgentsDir(fixture.agentDir)), []);
    assert.equal(fixture.store.get("coder").source, "bundled");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("tool picker unset removes fields, preserves other lists, and cleans an empty tools object on save", async () => {
  await withFixture(async ({ root, store, writeWorker }) => {
    await writeWorker({ tools: { allow: ["read"], block: ["bash"] } });
    const { ctx, driver } = editorContext(root, ["worker", "tools.allow", "Save", "Global", undefined]);
    driver.onChild = (component) => {
      if (!(component instanceof ToolPickerComponent)) return false;
      for (const value of ["action:unset", "action:done"]) component.getSelectList().onSelect!(component.getCurrentItems().find((item) => item.value === value)!);
      return true;
    };
    await editAgentTypes(ctx, store);
    assert.deepEqual(store.get("worker").tools, { block: ["bash"] });
    const other = editorContext(root, ["worker", "tools.block", "Save", "Global", undefined]);
    other.driver.onChild = driver.onChild;
    await editAgentTypes(other.ctx, store);
    assert.equal(store.get("worker").tools, undefined);
    assert.doesNotMatch(await readFile(store.get("worker").filePath!, "utf8"), /^tools:/m);
  });
});

test("nested tool pickers use the settings draft policy and freshly fetch session tools", async () => {
  await withFixture(async ({ root, store, agentDir }) => {
    const { ctx, driver } = editorContext(root, ["toolFiltering", "all", "types", "worker", "tools.allow", "tools.block", "Cancel", undefined, "cancel"]);
    ctx.isProjectTrusted = () => false;
    let fetched = 0;
    let pickers = 0;
    driver.onChild = (component) => {
      if (!(component instanceof ToolPickerComponent)) return false;
      pickers++;
      assert.match(stripTerminalSequences(component.render(100)[1]!), /list is not used until Tool Filtering/);
      assert.ok(component.getCurrentItems().some((item) => item.value === `tool:inactive_${pickers}`));
      component.handleInput("\x1b");
      return true;
    };
    await configureAgents(ctx, {
      store, agentDir, settings: { ...DEFAULT_MANAGER_SETTINGS },
      getAllTools: () => [{ name: `inactive_${++fetched}`, description: "Registered session tool" }],
      apply: () => assert.fail("Cancelled settings must not apply"),
    });
    assert.equal(fetched, 2);
    assert.equal(pickers, 2);
    assert.equal(store.get("worker").tools, undefined);
    assertOneOverlay(driver, "nested tool pickers");
  });
});

