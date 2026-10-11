import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { setKeybindings, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import piSubagent from "../src/index.ts";
import { markImportOffered } from "../src/prefs/agent-import.ts";
import { DEFAULT_MANAGER_SETTINGS, loadManagerSettings, saveManagerSettings, LOADER_STYLES, type LoaderStyle } from "../src/prefs/settings.ts";
import { AGENT_LOADERS } from "../src/ui/agent-loader.ts";
import { ThreadManager } from "../src/orch/manager.ts";
import type { ThreadView } from "../src/types.ts";
import { AgentNavigationEditor } from "../src/ui/agent-navigation-editor.ts";
import { StatusDialog } from "../src/ui/status-ui.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  start() {}
  stop() {}
  async drainInput() {}
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const thread = (state: ThreadView["state"], path = "/root/worker"): ThreadView => ({
  path, parent: "/root", owner: "/root", type: "worker", state,
  task: "Work", status: state, createdAt: 1, updatedAt: 1,
});

async function fixture(
  run: (state: {
    editor(): AgentNavigationEditor | undefined;
    installations(): number;
    widget(): string[];
    command: any;
    ctx: ExtensionContext;
    hooks: Map<string, Function>;
    driver: ReturnType<typeof createDialogDriver>;
  }) => Promise<void>,
  options: {
    mode?: "tui" | "rpc"; hasUI?: boolean; draft?: string;
    competingEditor?: boolean; reason?: "startup" | "resume";
    threads?: ThreadView[];
    widgetMode?: "full" | "minimal";
    nerdFontIcons?: boolean;
    loaderStyle?: LoaderStyle;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agent-navigation-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  markImportOffered(cwd);
  if (options.widgetMode || options.nerdFontIcons || options.loaderStyle) saveManagerSettings({
    cwd, agentDir: cwd, includeProject: false, scope: "user",
    settings: {
      ...DEFAULT_MANAGER_SETTINGS,
      widgetMode: options.widgetMode ?? DEFAULT_MANAGER_SETTINGS.widgetMode,
      nerdFontIcons: options.nerdFontIcons ?? DEFAULT_MANAGER_SETTINGS.nerdFontIcons,
      loaderStyle: options.loaderStyle ?? DEFAULT_MANAGER_SETTINGS.loaderStyle,
    },
  });
  const list = mock.method(ThreadManager.prototype, "list", () => options.threads ?? []);
  const hooks = new Map<string, Function>();
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
  const keys = new KeybindingsManager();
  setKeybindings(keys);
  const host = new TuiMainScreen(new FakeTerminal());
  const theme = {
    fg: (_color: string, text: string) => text,
    style: (text: string) => text,
    colors: { accent: { kind: "rgb", r: 94, g: 172, b: 211 } },
  };
  const driver = createDialogDriver({ theme: theme as any, rows: 24 });
  driver.onChild = (component) => {
    assert.ok(component instanceof StatusDialog);
    component.handleInput("\x1b");
    return true;
  };
  let editor: AgentNavigationEditor | undefined;
  let installations = 0;
  let widget: { render(width: number): string[]; dispose?(): void } | undefined;
  let command: any;
  const pi = {
    getCommands: () => [],
    events: { emit() {} },
    on: (event: string, handler: Function) => hooks.set(event, handler),
    registerTool() {},
    registerCommand: (_name: string, definition: any) => { command = definition; },
    appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, sessionManager,
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    isProjectTrusted: () => false,
    ui: {
      theme,
      setStatus() {},
      setWidget(_key: string, factory: Function | undefined) {
        widget?.dispose?.();
        widget = factory?.(host, theme);
      },
      notify() {}, custom: driver.custom,
      getEditorText: () => options.draft ?? "",
      getEditorComponent: () => options.competingEditor ? (() => ({})) : undefined,
      setEditorComponent(factory: Function) {
        installations++;
        editor = factory(host, {
          borderColor: (text: string) => text,
          selectList: {
            selectedPrefix: (text: string) => text,
            selectedText: (text: string) => text,
            description: (text: string) => text,
            scrollInfo: (text: string) => text,
            noMatch: (text: string) => text,
          },
        }, keys);
        editor!.focused = true;
        editor!.render(80);
      },
    },
  } as unknown as ExtensionContext;
  try {
    piSubagent(pi);
    await hooks.get("session_start")!({ reason: options.reason ?? "resume" }, ctx);
    await run({ editor: () => editor, installations: () => installations,
      widget: () => widget?.render(120) ?? [], command, ctx, hooks, driver });
  } finally {
    await hooks.get("session_shutdown")?.({}, ctx);
    widget?.dispose?.();
    list.mock.restore();
    host.stop();
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("root passes the persisted loader family to widgets, tree command and browser gesture", async () => {
  const icon = "\uf121";
  for (const loaderStyle of LOADER_STYLES) {
    await fixture(async ({ widget, command, ctx, driver, editor }) => {
      // The test clock may advance between surfaces; accept any frame from this family.
      const hasLabel = (text: string) => AGENT_LOADERS[loaderStyle].frames.some((glyph) => text.includes(`${glyph} ${icon} worker`));
      assert.ok(hasLabel(widget().join("\n")), `widget family ${loaderStyle}`);
      driver.onChild = (component) => {
        assert.ok(component instanceof StatusDialog);
        assert.ok(hasLabel(component.render(120).join("\n")), `browser family ${loaderStyle}`);
        component.handleInput("\x1b");
        return true;
      };
      await command.handler("tree", ctx);
      const main = editor()!;
      main.setText("");
      main.handleInput("\x1b[H");
      main.handleInput("\x1b[D");
      await settle();
      assert.equal(driver.stats.outerOpens, 2);
    }, { threads: [{ ...thread("running"), icon }], loaderStyle, nerdFontIcons: true });
  }
});

test("root installs the public editor and command/gesture use the same tree without changing draft", async () => {
  await fixture(async ({ editor, command, ctx, driver }) => {
    const main = editor()!;
    main.setText("unfinished\ndraft");
    main.handleInput("\x1b[A");
    main.handleInput("\x1b[H");
    const cursor = main.getCursor();
    main.handleInput("\x1b[D");
    await settle();
    assert.equal(driver.stats.outerOpens, 1);
    assert.equal(driver.stats.outerCompletions, 1);
    assert.equal(main.getText(), "unfinished\ndraft");
    assert.deepEqual(main.getCursor(), cursor);
    await command.handler("tree", ctx);
    assert.equal(driver.stats.outerOpens, 2);
    main.setText("");
    main.handleInput("\x1b[A");
    assert.equal(main.getText(), "old prompt", "resumed session history is hydrated");
  }, { threads: [thread("running")] });
});

test("startup lets the host hydrate prompt history exactly once", async () => {
  await fixture(async ({ editor }) => {
    const main = editor()!;
    main.handleInput("\x1b[A");
    assert.equal(main.getText(), "");
    main.addToHistory("old prompt"); // renderInitialMessages runs after session_start.
    main.handleInput("\x1b[A");
    assert.equal(main.getText(), "old prompt");
  }, { reason: "startup" });
});

test("session tree does not reinstall the editor and root shutdown cancels queued navigation", async () => {
  await fixture(async ({ editor, installations, hooks, ctx, driver }) => {
    const main = editor()!;
    main.setText("preserved draft");
    await hooks.get("session_tree")!({}, ctx);
    assert.equal(installations(), 1);
    assert.equal(editor(), main);
    assert.equal(main.getText(), "preserved draft");
    main.handleInput("\x1b[H");
    main.handleInput("\x1b[D");
    await hooks.get("session_shutdown")!({}, ctx);
    await settle();
    assert.equal(driver.stats.outerOpens, 0);
  }, { threads: [thread("running")] });
});

test("Left opens only for live subagents, while the tree command always remains available", async () => {
  const threads: ThreadView[] = [];
  await fixture(async ({ editor, command, ctx, driver }) => {
    const main = editor()!;
    for (const text of ["", "unfinished draft"]) {
      main.setText(text);
      main.handleInput("\x1b[H");
      const cursor = main.getCursor();
      const idleCases = [
        [], [thread("running", "/root")],
        ...(["paused", "completed", "failed", "stopped"] as const).map((state) => [thread(state)]),
      ];
      for (const idle of idleCases) {
        threads.splice(0, threads.length, ...idle);
        const opens = driver.stats.outerOpens;
        main.handleInput("\x1b[D");
        await settle();
        assert.equal(driver.stats.outerOpens, opens, JSON.stringify(idle));
        assert.equal(main.getText(), text);
        assert.deepEqual(main.getCursor(), cursor);
        await command.handler("tree", ctx);
        assert.equal(driver.stats.outerOpens, opens + 1, "explicit command ignores activity");
      }
      for (const state of ["starting", "running"] as const) {
        for (const path of ["/root/worker", "/root/parent/child", "/independent"]) {
          threads.splice(0, threads.length, thread("completed"), thread(state, path));
          const opens = driver.stats.outerOpens;
          main.handleInput("\x1b[D");
          await settle();
          assert.equal(driver.stats.outerOpens, opens + 1, `${path}: ${state}`);
          assert.equal(main.getText(), text);
          assert.deepEqual(main.getCursor(), cursor);
        }
      }
    }
    // A child can settle after dispatch but before the deferred open.
    threads.splice(0, threads.length, thread("running"));
    const opens = driver.stats.outerOpens;
    main.handleInput("\x1b[D");
    threads[0]!.state = "completed";
    await settle();
    assert.equal(driver.stats.outerOpens, opens);
  }, { threads });
});

for (const widgetMode of ["full", "minimal"] as const) {
  test(`${widgetMode} widget keeps old settled agents hidden until explicitly resumed`, async () => {
    const threads = [
      thread("completed", "/root/old"),
      thread("failed", "/root/failed"),
      thread("stopped", "/root/stopped"),
      thread("paused", "/root/paused"),
      thread("running", "/root/live"),
      thread("starting", "/root/starting"),
    ];
    await fixture(async ({ widget, hooks, ctx, command }) => {
      await hooks.get("agent_start")!({}, ctx);
      assert.doesNotMatch(widget().join("\n"), /completed|failed|stopped|1 paused|\/root\/old/);
      if (widgetMode === "full") {
        assert.match(widget().join("\n"), /\/root\/live/);
        assert.match(widget().join("\n"), /\/root\/starting/);
      } else assert.match(widget()[0]!, /2 running/);

      // Repeated model turns and settings refreshes must not expose historical agents.
      await command.handler("reload", ctx);
      await hooks.get("agent_end")!({}, ctx);
      await hooks.get("agent_start")!({}, ctx);
      assert.doesNotMatch(widget().join("\n"), /completed|failed|stopped|1 paused|\/root\/old/);

      // Simulate the starting-state change emitted when agent_steer resumes /root/old.
      threads[0]!.state = "starting";
      await command.handler("reload", ctx);
      if (widgetMode === "full") assert.match(widget().join("\n"), /\/root\/old/);
      else assert.match(widget()[0]!, /3 running/);
      threads[0]!.state = "completed";
      threads[4]!.state = "completed";
      threads[5]!.state = "completed";
      await hooks.get("agent_end")!({}, ctx);
      assert.match(widget()[0]!, /0 running, 3 completed/);
      assert.doesNotMatch(widget()[0]!, /failed|stopped|paused/);

      // All settled: even the minimal status line disappears on the next task.
      await hooks.get("agent_start")!({}, ctx);
      assert.deepEqual(widget(), []);
      await command.handler("tree", ctx);
      assert.deepEqual(widget(), []);
      threads.push(thread("running", "/root/new"));
      await command.handler("reload", ctx);
      if (widgetMode === "full") assert.match(widget().join("\n"), /\/root\/new/);
      else assert.match(widget()[0]!, /1 running/);
      assert.doesNotMatch(widget().join("\n"), /completed|failed|stopped|1 paused|\/root\/old/);
    }, { threads, widgetMode });
  });
}

test("Right collapses for this session only, preserves Left entry and never saves preferences", async () => {
  const threads = [thread("running"), thread("paused", "/root/paused")];
  await fixture(async ({ editor, widget, hooks, ctx, driver }) => {
    const settingsFile = join(ctx.cwd, "subagent-manager", "settings.json");
    const configuredMode = () => loadManagerSettings({
      cwd: ctx.cwd, agentDir: ctx.cwd, includeProject: false,
    }).settings.widgetMode;
    const main = editor()!;
    assert.ok(widget().length > 1);
    main.handleInput("\x1b[C");
    await settle();
    assert.equal(widget().length, 1);
    assert.match(widget()[0]!, /1 running.*1 paused/);
    assert.equal(configuredMode(), "full");
    assert.equal(existsSync(settingsFile), false);

    main.handleInput("\x1b[D");
    await settle();
    assert.equal(driver.stats.outerOpens, 1);
    assert.equal(widget().length, 1, "opening and closing the dialog keeps the override");
    await hooks.get("agent_start")!({}, ctx);
    await hooks.get("session_tree")!({}, ctx);
    assert.equal(widget().length, 1, "refresh, new turns and tree rebuilds preserve collapse");
    assert.doesNotMatch(widget()[0]!, /paused/, "old paused agents stay hidden");

    threads[0]!.state = "completed";
    await hooks.get("agent_end")!({}, ctx);
    assert.equal(widget().length, 1);
    threads[0]!.state = "running";
    await hooks.get("agent_start")!({}, ctx);
    assert.equal(widget().length, 1, "resuming an agent keeps the override");

    await hooks.get("session_start")!({ reason: "resume" }, ctx);
    assert.ok(widget().length > 1, "replacing the session restores the configured full mode");
    assert.equal(configuredMode(), "full");
    assert.equal(existsSync(settingsFile), false);
  }, { threads });
});

test("Right can collapse settled previews, but is harmless with no agents or minimal settings", async () => {
  await fixture(async ({ editor, widget }) => {
    assert.ok(widget().length > 1);
    editor()!.handleInput("\x1b[C");
    await settle();
    assert.equal(widget().length, 1);
  }, { threads: [thread("completed")] });
  for (const options of [
    { threads: [] },
    { threads: [thread("running")], widgetMode: "minimal" as const },
  ]) {
    await fixture(async ({ editor, widget, hooks, ctx }) => {
      const before = widget();
      editor()!.handleInput("\x1b[C");
      await settle();
      assert.deepEqual(widget(), before);
      await hooks.get("session_start")!({ reason: "resume" }, ctx);
      assert.deepEqual(widget(), before);
    }, options);
  }
});

test("root shutdown cancels queued collapse", async () => {
  await fixture(async ({ editor, widget, hooks, ctx }) => {
    editor()!.handleInput("\x1b[C");
    await hooks.get("session_shutdown")!({}, ctx);
    await settle();
    assert.deepEqual(widget(), []);
  }, { threads: [thread("running")] });
});

test("non-TUI contexts and existing editors leave the custom-editor slot untouched", async () => {
  for (const options of [
    { mode: "rpc" as const }, { hasUI: false },
    { draft: "existing draft" }, { competingEditor: true },
  ]) {
    await fixture(async ({ installations, command, ctx, driver }) => {
      assert.equal(installations(), 0);
      if (options.mode === undefined && options.hasUI !== false) {
        await command.handler("tree", ctx);
        assert.equal(driver.stats.outerOpens, 1, "existing editors retain command navigation");
      }
    }, options);
  }
});

