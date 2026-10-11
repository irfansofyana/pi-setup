import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { DIALOG_OPTIONS, dialogHeight, type DialogHost } from "../src/ui/dialog.ts";
import {
  ImportPicker,
  selectImportAgents,
  type ImportPickerItem,
} from "../src/ui/import-picker.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const DOWN = "\x1b[B",
  UP = "\x1b[A",
  PGDN = "\x1b[6~",
  PGUP = "\x1b[5~",
  HOME = "\x1b[H",
  END = "\x1b[F",
  CTRL_A = "\x01";

function host(rows = 24): DialogHost & { terminal: { rows: number } } {
  return { requestRender() {}, terminal: { rows } };
}

function agents(count: number): ImportPickerItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${i}`,
    label: `Agent-${String(i).padStart(2, "0")}`,
    detail: `/external/agents/agent-${i}/SKILL.md`,
  }));
}

function picker(items: ImportPickerItem[], terminal = host()) {
  const result: { chosen?: string[] | undefined } = {};
  const instance = new ImportPicker(terminal, theme, items, (ids) => {
    result.chosen = ids;
  });
  const press = (...keys: string[]) => keys.forEach((key) => instance.handleInput(key));
  const text = (width = 80) => instance.render(width).map(stripTerminalSequences).join("\n");
  return { picker: instance, result, press, text };
}

test("starts empty, toggles a subset, and submits it in source order", () => {
  const p = picker(agents(4));
  assert.deepEqual(p.picker.getSelectedIds(), []);
  let text = p.text();
  assert.match(text, /0 selected · 1\/4/);
  assert.match(text, /›\[ \] Agent-00/);
  assert.match(text, /\/external\/agents\/agent-0\/SKILL.md/);

  p.press(DOWN, DOWN, " ", UP, UP, " ", " ", " ");
  text = p.text();
  assert.match(text, /›\[x\] Agent-00/);
  assert.match(text, / \[ \] Agent-01/);
  assert.match(text, / \[x\] Agent-02/);
  assert.match(text, /2 selected/);
  p.press("\r");
  assert.deepEqual(p.result.chosen, ["agent-0", "agent-2"]);
});

test("enter with nothing selected skips, escape cancels, and an empty list is inert", () => {
  const skip = picker(agents(2));
  skip.press("x", "\r");
  assert.deepEqual(skip.result.chosen, []);

  const cancel = picker(agents(2));
  cancel.press(" ", "\x1b");
  assert.ok("chosen" in cancel.result);
  assert.equal(cancel.result.chosen, undefined);

  const none = picker([]);
  none.press(" ", CTRL_A, DOWN, END);
  assert.match(none.text(), /0 selected · 0\/0/);
  assert.match(none.text(), /No external agents to import/);
  none.press("\r");
  assert.deepEqual(none.result.chosen, []);
});

test("ctrl+a toggles every agent on and back off", () => {
  const items = agents(5);
  const p = picker(items);
  p.press(DOWN, " ", CTRL_A);
  assert.deepEqual(
    p.picker.getSelectedIds(),
    items.map((item) => item.id),
  );
  p.press(CTRL_A);
  assert.deepEqual(p.picker.getSelectedIds(), []);
  p.press(CTRL_A, "\r");
  assert.deepEqual(
    p.result.chosen,
    items.map((item) => item.id),
  );
});

test("navigation keys scroll a long list, keep selection, and stay within the frame", () => {
  const terminal = host(12);
  const items = agents(30);
  const p = picker(items, terminal);
  p.picker.render(80); // Page size is derived from the last render.
  p.press(DOWN, UP, UP);
  assert.equal(p.picker.getCursorIndex(), 0);
  p.press(PGDN);
  assert.ok(p.picker.getCursorIndex() > 1);
  p.press(PGUP);
  assert.equal(p.picker.getCursorIndex(), 0);
  p.press(" ", END, PGDN);
  assert.equal(p.picker.getCursorIndex(), items.length - 1);
  let text = p.text();
  assert.match(text, /Agent-29/);
  assert.match(text, /▲/);
  assert.equal(text.includes("Agent-00"), false);

  p.press(HOME);
  text = p.text();
  assert.match(text, /Agent-00/);
  assert.match(text, /▼/);
  assert.equal(text.includes("Agent-29"), false);
  assert.deepEqual(p.picker.getSelectedIds(), ["agent-0"]);
  assert.match(text, /Space toggle · Enter import \(empty skip\) · Esc cancel/);

  for (const rows of [1, 4, 10]) {
    terminal.terminal.rows = rows;
    for (const width of [0, 3, 30, 80]) {
      const lines = p.picker.render(width);
      assert.ok(lines.length <= dialogHeight(terminal));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  }
  const fitted = picker(agents(2)).text();
  assert.equal(fitted.includes("▲") || fitted.includes("▼"), false);
});

test("long details are capped to the frame width", () => {
  const detail = "path-0-" + "segment/".repeat(40) + "ENDTOKEN";
  const text = picker([{ id: "a", label: "Row", detail }]).text();
  assert.match(text, /path-0-/);
  assert.equal(text.includes("ENDTOKEN"), false);
});

test("sanitizes source text in labels and details", () => {
  const p = picker([
    {
      id: "bad",
      label: `Agent\x1b]0;bad\x07界\x1b[31mRed${CURSOR_MARKER}`,
      detail: `/tmp/\x1b]0;injected\x07path\x00name.md\r\nnext${CURSOR_MARKER}`,
    },
  ]);
  for (const width of [3, 80]) {
    const rendered = p.picker.render(width).join("\n");
    // Frame clipping may emit a trusted SGR reset; source escape sequences must not survive.
    assert.equal(stripTerminalSequences(rendered).includes("\x1b"), false);
    for (const banned of ["\x00", "injected", "]0;bad", CURSOR_MARKER])
      assert.equal(rendered.includes(banned), false);
  }
  assert.match(p.text(), /Agent界Red/);
  assert.match(p.text(), /\/tmp\/path name\.md\s+next/);
});

test("preserves trusted resets produced by frame clipping", () => {
  const coloredTheme = {
    fg: (_c: string, text: string) => `\x1b[2m${text}\x1b[22;39m`,
  } as Theme;
  const rendered = new ImportPicker(host(), coloredTheme, agents(2), () => {}).render(20);
  assert.ok(rendered.some((line) => line.includes("\x1b[0m")));
  assert.ok(rendered.every((line) => visibleWidth(line) <= 20));
});

test("selectImportAgents opens one checkbox overlay and returns its ids", async () => {
  let options: unknown;
  const ctx = {
    ui: {
      custom: async (
        factory: (h: DialogHost, th: Theme, k: unknown, done: (ids?: string[]) => void) => unknown,
        overlayOptions: unknown,
      ) => {
        options = overlayOptions;
        let result: string[] | undefined;
        const instance = factory(host(), theme, {}, (ids) => (result = ids));
        assert.ok(instance instanceof ImportPicker);
        for (const key of [DOWN, " ", "\r"]) instance.handleInput(key);
        return result;
      },
    },
  } as unknown as ExtensionContext;
  assert.deepEqual(await selectImportAgents(ctx, agents(3)), ["agent-1"]);
  assert.equal(options, DIALOG_OPTIONS);
});

