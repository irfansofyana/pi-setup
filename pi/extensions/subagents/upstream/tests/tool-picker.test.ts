import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  editToolSelection,
  TOOL_EDITOR_CANCEL,
  ToolPickerComponent,
  toolPolicyNotice,
  type SessionTool,
} from "../src/ui/tool-picker.ts";
import type { ToolFilteringMode } from "../src/prefs/settings.ts";

initTheme();
function create(
  options: {
    tools?: readonly SessionTool[];
    initial?: string[];
    field?: "allow" | "block";
    policy?: ToolFilteringMode;
    rows?: number;
  } = {},
) {
  const done: (string[] | undefined)[] = [];
  let cancelled = 0;
  const component = new ToolPickerComponent({
    tui: { requestRender() {}, terminal: { rows: options.rows ?? 24 } },
    theme: { fg: (_color: string, text: string) => text } as Theme,
    tools: options.tools ?? [
      { name: "read", description: "Read files" },
      { name: "bash", description: "Run shell commands" },
      { name: "mcp_example_search", description: "Search example server" },
    ],
    field: options.field ?? "allow",
    toolFiltering: options.policy ?? "allowed",
    initialTools: options.initial,
    onDone: (value) => done.push(value),
    onCancel: () => cancelled++,
  });
  return { component, done, cancelled: () => cancelled };
}
function activate(component: ToolPickerComponent, value: string) {
  const items = component.getCurrentItems();
  const index = items.findIndex((item) => item.value === value);
  assert.ok(index >= 0, `Missing ${value}`);
  component.getSelectList().setSelectedIndex(index);
  component.handleInput("\r");
}

test("tool picker searches names and descriptions and toggles checked rows without closing", () => {
  const { component, done } = create();
  component.focused = true;
  assert.equal(component.getSearchInput().focused, true);
  assert.deepEqual(
    component
      .getCurrentItems()
      .filter((item) => item.value.startsWith("tool:"))
      .map((item) => item.value),
    ["tool:bash", "tool:mcp_example_search", "tool:read"],
  );
  for (const char of "shell") component.handleInput(char);
  assert.equal(component.getSelectList().getSelectedItem()?.value, "tool:bash");
  component.handleInput("\r");
  assert.deepEqual(component.getDraftTools(), ["bash"]);
  assert.deepEqual(done, []);
  assert.match(component.getCurrentItems()[0]!.label, /\[x\] bash/);
  for (let i = 0; i < 5; i++) component.handleInput("\x7f");
  for (const char of "mcp_example") component.handleInput(char);
  component.handleInput("\r");
  activate(component, "tool:bash");
  component.handleInput("\x13");
  assert.deepEqual(done, [["mcp_example_search"]]);
});

test("saved unavailable entries remain checked across search and save; names cannot collide with actions", () => {
  const { component, done } = create({
    initial: ["unavailable", "unavailable", "action:done"],
    tools: [{ name: "action:done", description: "Real tool" }],
  });
  assert.match(component.getCurrentItems()[0]!.description!, /unavailable.*preserved/);
  for (const char of "no match") component.handleInput(char);
  activate(component, "action:done");
  assert.deepEqual(done, [["unavailable", "action:done"]]);
  const other = create({ initial: ["unavailable"], tools: [] });
  activate(other.component, "tool:unavailable");
  activate(other.component, "action:done");
  assert.deepEqual(other.done, [[]]);
});

test("unset, explicit empty, Done, Ctrl+S and cancellation retain their distinct meanings", () => {
  const unset = create();
  unset.component.handleInput("\x13");
  assert.deepEqual(unset.done, [undefined]);
  const empty = create({ initial: ["read"] });
  activate(empty.component, "action:empty");
  assert.deepEqual(empty.done, []);
  activate(empty.component, "action:done");
  assert.deepEqual(empty.done, [[]]);
  const cleared = create({ initial: [] });
  activate(cleared.component, "action:unset");
  cleared.component.handleInput("\x13");
  assert.deepEqual(cleared.done, [undefined]);
  for (const viaAction of [false, true]) {
    const cancelled = create({ initial: ["read"] });
    activate(cancelled.component, "tool:bash");
    if (viaAction) activate(cancelled.component, "action:cancel");
    else cancelled.component.handleInput("\x1b");
    assert.equal(cancelled.cancelled(), 1);
    assert.deepEqual(cancelled.done, []);
  }
});

test("notices appear at the top exactly when the current policy ignores the list", () => {
  for (const field of ["allow", "block"] as const) {
    for (const policy of ["allowed", "all-except-blocked", "all"] as const) {
      const expected = field === "allow" ? policy !== "allowed" : policy === "all";
      const { component } = create({ field, policy });
      assert.equal(!!toolPolicyNotice(field, policy), expected);
      const lines = component.render(100).map(stripTerminalSequences);
      if (expected) assert.match(lines[1]!, /list is not used until Tool Filtering/);
      else assert.doesNotMatch(lines.join("\n"), /not used until/);
      assert.ok(lines.every((line) => visibleWidth(line) <= 100));
    }
  }
});

test("empty/no-match and hostile text render safely within resized bounds", () => {
  const empty = create({ tools: [] });
  assert.match(empty.component.render(100).join("\n"), /No tools available/);
  const { component, done } = create({
    tools: [
      {
        name: "\x1b]0;owned\x07danger",
        description: "\x1b[31mred\x1b[0m\nnext",
      },
    ],
    rows: 16,
  });
  for (const width of [2, 20, 40, 100]) {
    const lines = component.render(width);
    assert.ok(lines.length <= 14);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line))));
  }
  activate(component, "tool:\x1b]0;owned\x07danger");
  component.handleInput("\x13");
  assert.deepEqual(done, [["\x1b]0;owned\x07danger"]]);
  for (const char of "nonexistent") component.handleInput(char);
  assert.match(component.render(100).join("\n"), /No unselected matching tools/);
});

test("editor obtains all tools freshly, including inactive session tools, and guards RPC", async () => {
  const done: unknown[] = [];
  let fetched = 0;
  const options = {
    getAllTools: () => {
      fetched++;
      return [{ name: `inactive_${fetched}`, description: "Registered but inactive" }];
    },
    toolFiltering: "all" as const,
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async (factory: Function) => {
        let result: unknown;
        const component = factory(
          { requestRender() {} },
          { fg: (_color: string, text: string) => text },
          {},
          (value: unknown) => {
            result = value;
          },
        );
        assert.match(component.render(100)[1], /not used/);
        activate(component, `tool:inactive_${fetched}`);
        component.handleInput("\x13");
        done.push(result);
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  await editToolSelection(ctx, "block", undefined, options);
  await editToolSelection(ctx, "allow", undefined, options);
  assert.equal(fetched, 2);
  assert.deepEqual(done, [["inactive_1"], ["inactive_2"]]);
  const notices: string[] = [];
  const rpc = {
    mode: "rpc",
    hasUI: true,
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionCommandContext;
  assert.equal(await editToolSelection(rpc, "allow", [], options), TOOL_EDITOR_CANCEL);
  assert.equal(fetched, 2);
  assert.match(notices[0]!, /draft unchanged/);
});

test("mcp tools group under a collapsed aggregate row with expand/collapse and toggle-all", () => {
  const { component } = create({
    tools: [
      { name: "read", description: "Read" },
      { name: "mcp__fs__ls", description: "ls" },
      { name: "mcp__fs__cat", description: "cat" },
    ],
    initial: ["mcp__fs__ls"],
  });
  const values = () => component.getCurrentItems().map((i) => i.value);
  assert.deepEqual(
    values().filter((v) => !v.startsWith("action:")),
    ["group:mcp__fs", "tool:read"],
  );
  assert.match(
    component.getCurrentItems().find((i) => i.value === "group:mcp__fs")!.label,
    /\[-\] mcp__fs/,
  );
  const select = (v: string) => component.getSelectList().setSelectedIndex(values().indexOf(v));
  select("group:mcp__fs");
  component.handleInput("\x1b[C");
  assert.ok(values().includes("tool:mcp__fs__cat"));
  component.handleInput("\x1b[D");
  assert.ok(!values().includes("tool:mcp__fs__cat"));
  select("group:mcp__fs");
  component.handleInput("\r");
  assert.deepEqual([...component.getDraftTools()!].sort(), ["mcp__fs__cat", "mcp__fs__ls"]);
  select("group:mcp__fs");
  component.handleInput("\r");
  assert.deepEqual(component.getDraftTools(), []);
});

