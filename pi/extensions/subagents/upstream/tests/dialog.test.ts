import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  rgbColor,
  stripTerminalSequences,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
  type OverlayHandle,
  type Terminal,
} from "@earendil-works/pi-tui";
import { AGENT_COLORS, ConfigStore } from "../src/prefs/config.ts";
import {
  DIALOG_OPTIONS,
  DialogEditor,
  DialogMenu,
  DialogSession,
  dialogHeight,
  dialogInput,
  frameDialog,
  withDialogSession,
} from "../src/ui/dialog.ts";
import { configureAgents } from "../src/ui/settings-ui.ts";
import { DEFAULT_MANAGER_SETTINGS, loadManagerSettings } from "../src/prefs/settings.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  colors: Object.fromEntries(AGENT_COLORS.map((color) => [color, rgbColor(238, 238, 238)])),
  style: (text: string) => text,
} as unknown as Theme;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const host = (rows = 24) => ({ requestRender() {}, terminal: { rows } });
const DOWN = "\x1b[B";
const CTRL_S = "\x13";
const ESC = "\x1b";

function bounded(lines: string[], width: number, rows: number) {
  assert.ok(lines.length <= dialogHeight(host(rows)), `${width}x${rows} too tall`);
  assert.ok(
    lines.every((line) => visibleWidth(line) <= width),
    `${width}x${rows} too wide`,
  );
}

// --- Primitives ---------------------------------------------------------------

test("frameDialog bounds, sanitizes, borders, and pads to a fixed height", () => {
  assert.equal(dialogHeight(host(24)), 21);
  for (const width of [0, 1, 3, 4, 20, 80]) {
    for (const height of [1, 4, 10]) {
      const lines = frameDialog(
        theme,
        width,
        height,
        "Agents 界\x1b]0;bad\x07",
        Array(30).fill("界".repeat(100)),
        "Esc close",
      );
      assert.ok(lines.length <= height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(!lines.join("").includes("\x1b]0;bad"));
      if (width >= 4 && height >= 4) {
        const plain = lines.map(stripTerminalSequences);
        assert.match(plain[0]!, /^╭.*╮$/);
        assert.match(plain.at(-1)!, /^╰.*╯$/);
        assert.ok(plain.slice(1, -2).every((line) => /^│.*│$|^├.*┤$/.test(line)));
      }
    }
  }
  const short = frameDialog(theme, 80, 21, "Title", ["only"], "Esc");
  const tall = frameDialog(theme, 80, 21, "Title", Array(40).fill("row"), "Esc");
  assert.equal(short.length, 21);
  assert.equal(tall.length, 21);
});

test("menu restores selection, navigates, selects, saves, and cancels within bounds", () => {
  let selected: string | undefined;
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    label: `Field ${i}`,
    value: `Value 界 ${i}`,
    help: "Help",
  }));
  const menu = new DialogMenu(
    host(12),
    theme,
    "Settings",
    rows,
    (id) => {
      selected = id;
    },
    "20",
    "Enter edit · Esc close",
    "save",
  );
  assert.equal(menu.getSelectedId(), "20");
  const text = menu.render(80).join("\n");
  assert.ok(text.includes("Field 20"), "initial selection is scrolled into view");
  assert.ok(text.includes("Esc close"));
  menu.handleInput(DOWN);
  assert.equal(menu.getSelectedId(), "21");
  menu.handleInput("\r");
  assert.equal(selected, "21");
  menu.handleInput(CTRL_S);
  assert.equal(selected, "save");
  menu.handleInput(ESC);
  assert.equal(selected, undefined);
  for (const width of [1, 10, 40, 100]) bounded(menu.render(width), width, 12);
});

test("menu values keep their warning color and column even on the selected row", () => {
  const coloredTheme = {
    fg: (color: string, text: string) => {
      if (color === "warning") return `\x1b[33m${text}\x1b[0m`;
      if (color === "accent") return `\x1b[36m${text}\x1b[0m`;
      return text;
    },
  } as Theme;
  const menu = new DialogMenu(host(), coloredTheme, "Settings", [
    { id: "other", label: "Other", value: "42" },
    { id: "save", label: "Save and apply", value: "(changes)", valueColor: "warning" },
  ], () => {});
  for (const selected of [false, true]) {
    if (selected) menu.handleInput(DOWN);
    const rendered = menu.render(80).join("\n");
    assert.match(rendered, /\x1b\[33m\(changes\)\x1b\[0m/);
    const plain = stripTerminalSequences(rendered);
    assert.match(plain, /Save and apply\s+│ \(changes\)/);
    const lines = plain.split("\n");
    assert.equal(
      lines.find((line) => line.includes("(changes)"))!.indexOf("(changes)"),
      lines.find((line) => line.includes("42"))!.indexOf("42"),
    );
    for (const width of [1, 10, 40, 100]) bounded(menu.render(width), width, 24);
  }
});

test("menu wraps long help text and reserves space for it", () => {
  const help = "Global saves your defaults for every project. Trusted project settings override these defaults in this project. Switching scope only changes where you save, not the values shown.";
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: String(index), label: `Field ${index}`, help }));
  const menu = new DialogMenu(host(), theme, "Settings", rows, () => {}, "19");
  const lines = menu.render(60);
  bounded(lines, 60, 24);
  assert.ok(lines.some((line) => line.includes("Field 19")));
  const text = lines.slice(0, -3).map(stripTerminalSequences)
    .map((line) => line.slice(1, -1).trim()).join(" ");
  assert.ok(text.includes(help), "the full help survives wrapping and framing");
  for (const height of [6, 12, 24]) {
    const shortMenu = new DialogMenu(host(height), theme, "Settings", rows, () => {}, "19");
    for (const width of [1, 10, 40, 100]) bounded(shortMenu.render(width), width, height);
  }
});

test("menu and input help preserve explicit newlines while sanitizing and wrapping", async () => {
  const help = "First option\nSecond option\r\nThird\x00 option\n" + "Long explanation ".repeat(8);
  const menu = new DialogMenu(
    host(),
    theme,
    "Settings",
    [{ id: "field", label: "Field", help }],
    () => {},
  );
  const check = (lines: string[]) => {
    bounded(lines, 60, 24);
    const plain = lines.map(stripTerminalSequences).map((line) => line.slice(1, -1).trim());
    for (const text of ["First option", "Second option", "Third  option"])
      assert.ok(plain.includes(text), `${text} has its own line`);
    assert.ok(lines.every((line) => !/[\n\r\x00]/.test(line)));
    assert.ok(plain.filter((line) => line.includes("Long explanation")).length > 1);
  };
  check(menu.render(60));
  const ctx = {
    ui: {
      custom: (factory: Function) => {
        const input = factory(host(), theme, {}, () => {});
        check(input.render(60));
        return Promise.resolve(undefined);
      },
    },
  } as unknown as ExtensionCommandContext;
  await dialogInput(ctx, "Field", "1", help);
});

test("multiline editor forwards focus, keeps cursor visible, applies with Ctrl+S, and cancels", () => {
  let applied: string | undefined;
  const editor = new DialogEditor(
    host(12),
    theme,
    "System prompt",
    Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"),
    (value) => {
      applied = value;
    },
  );
  editor.focused = true;
  assert.equal(editor.getEditor().focused, true);
  editor.handleInput(DOWN);
  editor.handleInput("\r");
  assert.equal(applied, undefined, "Enter inserts a newline rather than submitting");
  editor.handleInput("\x1b[F");
  for (const width of [1, 3, 10, 40, 100]) {
    const lines = editor.render(width);
    bounded(lines, width, 12);
    if (width >= 40)
      assert.ok(
        lines.some((line) => line.includes(CURSOR_MARKER)),
        "cursor survives cropping",
      );
  }
  editor.handleInput(CTRL_S);
  assert.equal(applied, editor.getEditor().getText());
  editor.handleInput(ESC);
  assert.equal(applied, undefined);
});

test("multiline editor strips control sequences but returns unchanged prefill verbatim", () => {
  let value: string | undefined;
  const initial = "hello\tworld\r\n\x1b]0;injected\x07second\x00line";
  const editor = new DialogEditor(host(), theme, "Prompt", initial, (result) => {
    value = result;
  });
  assert.ok(!editor.getEditor().getText().includes("\x1b"));
  assert.ok(!editor.render(80).join("\n").includes("injected"));
  editor.handleInput(CTRL_S);
  assert.equal(value, initial);
});

// --- DialogSession (driver) -------------------------------------------------

function sessionContext(onChild?: (component: any) => boolean) {
  const driver = createDialogDriver({ theme, timeoutMs: 3000 });
  if (onChild) driver.onChild = onChild;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: { custom: driver.custom, notify() {} },
  } as unknown as ExtensionCommandContext;
  return { driver, ctx };
}

test("DialogSession delegates focus and ignores keys after a child finishes", async () => {
  const mounted: any[] = [];
  let notify = () => {};
  const { driver, ctx } = sessionContext((component) => {
    mounted.push(component);
    notify();
    return true;
  });
  const wait = (index: number) =>
    mounted[index]
      ? Promise.resolve(mounted[index])
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`child ${index} not mounted`)), 2000);
          notify = () => {
            if (!mounted[index]) return;
            clearTimeout(timer);
            resolve(mounted[index]);
          };
        });

  const doneCalls: unknown[] = [];
  await withDialogSession(ctx, async (sessionCtx) => {
    const first = sessionCtx.ui.custom(
      (childHost, childTheme, _keys, done) =>
        new DialogEditor(childHost, childTheme, "Prompt", "hello", (value) => {
          doneCalls.push(value);
          done(value);
        }),
      DIALOG_OPTIONS,
    );
    const editor = (await wait(0)) as DialogEditor;
    const session = driver.session;
    assert.ok(session instanceof DialogSession);
    assert.equal(session.getComponent(), editor);
    session.focused = true;
    assert.equal(editor.focused, true);
    const rendered = session.render(80);
    assert.equal(rendered.length, dialogHeight(host()));
    assert.ok(rendered.some((line: string) => line.includes(CURSOR_MARKER)));
    editor.handleInput(ESC);
    assert.equal(await first, undefined);
    session.handleInput(CTRL_S);
    session.handleInput("x");
    assert.deepEqual(doneCalls, [undefined], "input after done is ignored until the next mount");

    const secondCalls: string[] = [];
    const second = sessionCtx.ui.custom(
      (_host, _theme, _keys, done) => ({
        handleInput(data: string) {
          secondCalls.push(data);
          if (data === "\r") done("second");
        },
        invalidate() {},
        render: () => ["next"],
      }),
      DIALOG_OPTIONS,
    );
    await wait(1);
    session.handleInput("\r");
    assert.deepEqual(secondCalls, ["\r"]);
    assert.equal(await second, "second");
  });
  assert.equal(driver.stats.outerOpens, 1);
  assert.equal(driver.stats.outerCompletions, 1);
  assert.equal(driver.stats.forcedRenders, 0);
});

test("withDialogSession shadows getter-only ui without mutating the original context", async () => {
  const { driver } = sessionContext(() => true);
  const notifications: string[] = [];
  const ui = { custom: driver.custom, notify: (message: string) => notifications.push(message) };
  let cwd = "/original";
  const ctx = Object.freeze({
    hasUI: true,
    mode: "tui",
    get ui() {
      return ui;
    },
    get cwd() {
      return cwd;
    },
  }) as unknown as ExtensionCommandContext;

  await withDialogSession(ctx, async (sessionCtx) => {
    assert.notEqual(sessionCtx.ui, ui);
    sessionCtx.ui.notify("scoped notification");
    assert.deepEqual(notifications, ["scoped notification"]);
    cwd = "/updated";
    assert.equal(sessionCtx.cwd, "/updated", "other context getters stay live");
    await withDialogSession(sessionCtx, async (nestedCtx) => {
      assert.equal(nestedCtx, sessionCtx, "nested sessions reuse the outer one");
      const result = await nestedCtx.ui.custom((_host, _theme, _keys, done) => {
        done("ok");
        return { invalidate() {}, render: () => ["child"] };
      }, DIALOG_OPTIONS);
      assert.equal(result, "ok");
    });
  });
  assert.equal(ctx.ui, ui);
  assert.equal(driver.stats.outerOpens, 1);
  assert.equal(driver.stats.outerCompletions, 1);
});

test("a failing child rejects without closing the session", async () => {
  const { driver, ctx } = sessionContext(() => true);
  let recovered = false;
  await withDialogSession(ctx, async (sessionCtx) => {
    await assert.rejects(
      () =>
        sessionCtx.ui.custom(() => {
          throw new Error("child");
        }, DIALOG_OPTIONS),
      /child/,
    );
    const result = await sessionCtx.ui.custom((_host, _theme, _keys, done) => {
      done("ok");
      return { invalidate() {}, render: () => ["recovered"] };
    }, DIALOG_OPTIONS);
    recovered = result === "ok";
  });
  assert.equal(recovered, true);
  assert.equal(driver.stats.outerOpens, 1);
  assert.equal(driver.stats.outerCompletions, 1);
});

// --- Real TUI renderers --------------------------------------------------------

class RecordingTerminal implements Terminal {
  columns = 100;
  rows = 24;
  kittyProtocolActive = false;
  writes: string[] = [];
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(lines: number): void {
    this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
  }
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {
    this.write("\x1b[2K");
  }
  clearFromCursor(): void {
    this.write("\x1b[J");
  }
  clearScreen(): void {
    this.write("\x1b[2J");
  }
  setTitle(): void {}
  setProgress(): void {}
}

/** Mimics pi's ctx.ui.custom: overlays are shown on the TUI; others take focus until done. */
function tuiContext(
  tui: TuiMainScreen | TuiAltScreen,
  extra: Record<string, unknown> = {},
  onPassthroughDone?: () => void,
) {
  const stats = { opened: 0, closed: 0 };
  let overlay: OverlayHandle | undefined;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ...extra,
    ui: {
      notify: () => {},
      ...(extra.ui as object),
      custom: (factory: Function, options: any) =>
        new Promise((resolve, reject) => {
          let finished = false;
          let component: any;
          if (options?.overlay) stats.opened++;
          const done = (value: unknown) => {
            if (finished) return;
            finished = true;
            if (options?.overlay) {
              stats.closed++;
              overlay?.hide();
              component?.dispose?.();
            } else onPassthroughDone?.();
            resolve(value);
          };
          Promise.resolve(factory(tui, theme, {}, done)).then((view) => {
            if (finished || !options?.overlay) return;
            component = view;
            overlay = tui.showOverlay(view, options.overlayOptions);
          }, reject);
        }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, stats, overlay: () => overlay };
}

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`${Renderer.name}: settings transitions keep one overlay mounted without full redraws`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-dialog-renderer-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const terminal = new RecordingTerminal();
    terminal.rows = 12;
    const tui = new Renderer(terminal);
    t.after(() => tui.stop());
    tui.addChild({ invalidate() {}, render: () => ["Conversation behind the settings dialog"] });
    tui.start();
    const notifications: string[] = [];
    const { ctx, stats, overlay } = tuiContext(tui, {
      cwd: root,
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifications.push(message) },
    });
    let applied = 0;
    const running = configureAgents(ctx, {
      store: new ConfigStore({ cwd: root, agentDir: root, includeProject: false }),
      agentDir: root,
      settings: { ...DEFAULT_MANAGER_SETTINGS },
      apply: () => applied++,
    });
    await settle();
    tui.renderNow();
    const bounds = overlay()?.getBounds();
    assert.ok(bounds);
    const redraws = tui.fullRedraws;
    terminal.writes = [];

    async function input(data: string): Promise<void> {
      terminal.input(data);
      // Render before Promise continuations mount the next view: completing a
      // field must not expose the conversation behind the dialog.
      assert.equal(tui.hasOverlay(), true);
      assert.equal(stats.closed, 0);
      tui.renderNow();
      assert.deepEqual(overlay()?.getBounds(), bounds);
      await settle();
      tui.renderNow();
      assert.equal(stats.opened, 1);
      assert.deepEqual(overlay()?.getBounds(), bounds);
      assert.equal(tui.fullRedraws, redraws);
      assert.ok(!terminal.writes.join("").includes("\x1b[2J"));
    }
    const replaceField = async (value: string) => {
      for (const key of ["\r", "\x05", "\x15", value, "\r"]) await input(key);
    };
    const selectRow = async (id: string) => {
      const session = tui.getFocusedComponent();
      assert.ok(session instanceof DialogSession);
      const menu = session.getComponent();
      assert.ok(menu instanceof DialogMenu);
      const target = menu.rows.findIndex((row) => row.id === id);
      for (let steps = 0; menu.getSelectedId() !== id && steps < 20; steps++) {
        const current = menu.rows.findIndex((row) => row.id === menu.getSelectedId());
        await input(current < target ? DOWN : "\x1b[A");
      }
      assert.equal(menu.getSelectedId(), id, `settings row ${id} is reachable`);
    };

    // Choose orchestration, then edit the numeric limits by their stable row ID.
    await input("\r");
    await input(DOWN);
    await input("\r");
    await selectRow("maxLevels");
    await replaceField("33");
    assert.ok(notifications.some((message) => message.includes("at most 32")));
    await replaceField("5");
    // The model chooser also reuses the overlay and preserves its bounds.
    await selectRow("modelSelection");
    await input("\r");
    await input(DOWN);
    await input("\r");
    await selectRow("maxLevels");
    // A canceled field editor, a scope toggle and the nested definitions
    // editor all remain inside the same outer overlay.
    await input("\r");
    await input(ESC);
    await selectRow("scope");
    await input("\r");
    await selectRow("types");
    await input("\r");
    await input(ESC);
    terminal.input(CTRL_S);
    await running;
    assert.deepEqual(stats, { opened: 1, closed: 1 });
    assert.equal(tui.hasOverlay(), false);
    assert.equal(applied, 1);
    assert.equal(
      loadManagerSettings({ cwd: root, agentDir: root, includeProject: false }).settings.maxLevels,
      5,
    );
    assert.equal(
      loadManagerSettings({ cwd: root, agentDir: root, includeProject: false }).settings.subagentMode,
      "orchestration",
    );
    assert.equal(
      loadManagerSettings({ cwd: root, agentDir: root, includeProject: false }).settings.modelSelection,
      "use-current",
    );
  });

  test(`${Renderer.name}: a non-overlay custom view restores session focus`, async (t) => {
    const terminal = new RecordingTerminal();
    const tui = new Renderer(terminal);
    t.after(() => tui.stop());
    const background = { invalidate() {}, render: () => ["conversation"], focused: false };
    tui.addChild(background);
    tui.setFocus(background);
    tui.start();
    // Pi restores its normal editor after a non-overlay custom view.
    const { ctx, stats } = tuiContext(tui, {}, () => tui.setFocus(background));
    const view = (_h: unknown, _t: unknown, _k: unknown, done: (value?: unknown) => void) => ({
      invalidate() {},
      render: () => ["view"],
      handleInput: () => done(),
    });
    let passThroughCompleted = false;
    let outer: unknown;
    const running = withDialogSession(ctx, async (sessionCtx) => {
      await sessionCtx.ui.custom(view, DIALOG_OPTIONS);
      await sessionCtx.ui.custom((_host, _theme, _keys, done) => {
        done(undefined);
        return { invalidate() {}, render: () => [] };
      });
      passThroughCompleted = true;
      await sessionCtx.ui.custom(view, DIALOG_OPTIONS);
    });
    await settle();
    outer = tui.getFocusedComponent();
    assert.ok(outer instanceof DialogSession, "the outer session owns focus");
    terminal.input("\r");
    await settle();
    assert.equal(passThroughCompleted, true);
    assert.equal(stats.opened, 1);
    assert.equal(tui.getFocusedComponent(), outer);
    assert.equal((outer as { focused?: boolean }).focused, true);
    terminal.input("\r");
    await running;
    assert.equal(tui.hasOverlay(), false);
  });

  for (const throws of [false, true]) {
    test(`${Renderer.name}: immediately ${throws ? "throwing" : "finishing"} workflows leave no overlay`, async (t) => {
      const tui = new Renderer(new RecordingTerminal());
      t.after(() => tui.stop());
      tui.start();
      const { ctx, stats } = tuiContext(tui);
      const running = withDialogSession(ctx, () => {
        if (throws) throw new Error("immediate failure");
        return Promise.resolve();
      });
      if (throws) await assert.rejects(running, /immediate failure/);
      else await running;
      await settle();
      assert.equal(tui.hasOverlay(), false);
      assert.equal(stats.closed, stats.opened);
    });
  }
}

