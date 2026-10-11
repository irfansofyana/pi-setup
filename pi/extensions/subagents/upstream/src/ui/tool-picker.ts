import fuzzysort from "fuzzysort";
import {
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  SelectList,
  wrapTextWithAnsi,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { ToolFilteringMode } from "../prefs/settings.ts";
import {
  dialogHeight,
  dialogText,
  frameDialog,
  DIALOG_OPTIONS,
  type DialogHost,
} from "./dialog.ts";

export type SessionTool = Pick<
  ReturnType<ExtensionAPI["getAllTools"]>[number],
  "name" | "description"
>;
export interface ToolEditorOptions {
  getAllTools(): readonly SessionTool[];
  toolFiltering: ToolFilteringMode;
}
export const TOOL_EDITOR_CANCEL = Symbol("tool-editor-cancel");

export function toolPolicyNotice(
  field: "allow" | "block",
  policy: ToolFilteringMode,
): string | undefined {
  if (field === "allow" && policy !== "allowed") {
    return "Allow list is not used until Tool Filtering policy is changed to Allowed (except blocked).";
  }
  if (field === "block" && policy === "all") {
    return "Block list is not used until Tool Filtering policy is changed from All.";
  }
  return undefined;
}

const LAYOUT = { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 52 };
interface ToolItem extends SelectItem {
  group: string;
}
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
export function mcpServerOf(name: string): string | undefined {
  return MCP_TOOL.exec(name)?.[1];
}

export class ToolPickerComponent extends Container {
  private readonly searchInput = new Input({ placeholder: "Search tools" });
  private selectList = new SelectList([], 1, getSelectListTheme(), LAYOUT);
  private currentItems: ToolItem[] = [];
  private readonly tools: SessionTool[];
  private readonly byName: Map<string, SessionTool>;
  private draft: string[] | undefined;
  private query = "";
  private readonly expanded = new Set<string>();
  private _focused = false;

  constructor(
    private readonly options: {
      tui: DialogHost;
      theme: Theme;
      tools: readonly SessionTool[];
      field: "allow" | "block";
      toolFiltering: ToolFilteringMode;
      initialTools?: readonly string[];
      onDone(tools: string[] | undefined): void;
      onCancel(): void;
    },
  ) {
    super();
    this.byName = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.tools = [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.draft =
      options.initialTools === undefined ? undefined : [...new Set(options.initialTools)];
    this.addChild(this.searchInput);
    this.refresh();
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }
  getDraftTools(): readonly string[] | undefined {
    return this.draft;
  }
  getCurrentItems(): readonly SelectItem[] {
    return this.currentItems;
  }
  getSelectList(): SelectList {
    return this.selectList;
  }
  getSearchInput(): Input {
    return this.searchInput;
  }

  render(width: number): string[] {
    const { tui, theme, field, toolFiltering } = this.options;
    const height = dialogHeight(tui);
    const inner = Math.max(1, width - 4);
    const notice = toolPolicyNotice(field, toolFiltering);
    const header = [
      ...(notice ? wrapTextWithAnsi(theme.fg("warning", notice), inner) : []),
      theme.fg(
        "muted",
        this.draft === undefined
          ? "Unset (use default policy). Select tools to create a list."
          : `${this.draft.length} selected · selected tools first · type to search`,
      ),
      ...this.searchInput.render(inner),
    ];
    const selected = this.selectList.getSelectedItem()?.value;
    const displayRows: (ToolItem | string)[] = [];
    let previous: string | undefined;
    for (const item of this.currentItems) {
      if (item.group !== previous) {
        if (
          item.group === "Actions" &&
          !this.currentItems.some((row) => row.group === "Session tools · A–Z")
        ) {
          displayRows.push(
            this.tools.length
              ? "No unselected matching tools"
              : "No tools available in this session",
          );
        }
        displayRows.push(item.group);
      }
      previous = item.group;
      displayRows.push(item);
    }
    const budget = Math.max(1, height - 4 - header.length);
    const index = Math.max(
      0,
      displayRows.findIndex((row) => typeof row !== "string" && row.value === selected),
    );
    const start = Math.max(0, Math.min(index - budget + 1, displayRows.length - budget));
    const rows = displayRows.slice(start, start + budget).map((row) => {
      if (typeof row === "string") return theme.fg("muted", row);
      const text = `${row.value === selected ? "›" : " "} ${row.label}  ${theme.fg("muted", row.description ?? "")}`;
      return row.value === selected ? theme.fg("accent", text) : text;
    });
    return frameDialog(
      theme,
      width,
      height,
      field === "allow" ? "Allowed tools" : "Blocked tools",
      [...header, ...rows].map((line) => ` ${line}`),
      "↑↓ select · Enter toggle/action · ←→ collapse/expand MCP · Ctrl+S done · Esc cancel",
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("s"))) {
      this.finish();
      return;
    }
    const kb = getKeybindings();
    const current = this.selectList.getSelectedItem()?.value;
    const isRight = matchesKey(data, Key.right);
    const isLeft = matchesKey(data, Key.left);
    if ((isRight || isLeft) && current) {
      const server = current.startsWith("group:")
        ? current.slice("group:".length)
        : isLeft && current.startsWith("tool:")
          ? mcpServerOf(current.slice("tool:".length))
          : undefined;
      const key =
        server === undefined ? undefined : current.startsWith("group:") ? server : `mcp__${server}`;
      if (key !== undefined) {
        if (isRight && current.startsWith("group:")) this.expanded.add(key);
        else if (isLeft) this.expanded.delete(key);
        this.refresh(`group:${key}`);
        this.options.tui.requestRender();
        return;
      }
    }
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel")
    ) {
      this.selectList.handleInput(data);
    } else {
      this.searchInput.handleInput(data);
      const query = this.searchInput.getValue();
      if (query !== this.query) {
        this.query = query;
        this.refresh(undefined, true);
      }
    }
    this.options.tui.requestRender();
  }

  private finish(): void {
    this.options.onDone(this.draft === undefined ? undefined : [...this.draft]);
  }

  private refresh(selectedValue?: string, focusResult = false): void {
    const previousIndex = this.currentItems.findIndex(
      (row) => row.value === this.selectList.getSelectedItem()?.value,
    );
    const selected = new Set(this.draft ?? []);
    const matches = this.query.trim()
      ? fuzzysort
          .go(this.query.trim(), this.tools, {
            keys: ["name", "description"],
            limit: 0,
            threshold: 0,
          })
          .map((result) => result.obj)
      : this.tools;
    const toolItem = (name: string, checked: boolean): ToolItem => ({
      value: `tool:${name}`,
      label: `[${checked ? "x" : " "}] ${dialogText(name)}`,
      description: this.byName.has(name)
        ? dialogText(this.byName.get(name)!.description)
        : "unavailable in current session · preserved",
      group: checked ? "Selected tools" : "Session tools · A–Z",
    });
    const searching = this.query.trim().length > 0;
    const groups = new Map<string, string[]>();
    const flat: string[] = [];
    const addName = (name: string) => {
      const server = mcpServerOf(name);
      if (server === undefined) return flat.push(name);
      const key = `mcp__${server}`;
      const list = groups.get(key) ?? [];
      if (!list.includes(name)) list.push(name);
      groups.set(key, list);
    };
    for (const name of selected) if (mcpServerOf(name) === undefined) addName(name);
    const matchedNames = new Set(matches.map((tool) => tool.name));
    for (const tool of matches) if (!selected.has(tool.name)) addName(tool.name);
    // Group members: all session tools plus preserved draft names (so toggling affects the whole MCP).
    const members = new Map<string, string[]>();
    for (const name of [...this.tools.map((t) => t.name), ...selected]) {
      const server = mcpServerOf(name);
      if (server === undefined) continue;
      const list = members.get(`mcp__${server}`) ?? [];
      if (!list.includes(name)) list.push(name);
      members.set(`mcp__${server}`, list);
    }
    for (const name of selected) if (mcpServerOf(name) !== undefined && !searching) addName(name);
    for (const key of [...groups.keys()]) {
      // Show a group when not searching, or when any member matches the search.
      if (searching && !members.get(key)!.some((n) => matchedNames.has(n))) groups.delete(key);
    }
    if (!searching) for (const key of members.keys()) if (!groups.has(key)) groups.set(key, []);
    const flatSelected = flat.filter((n) => selected.has(n));
    const flatUnselected = flat.filter((n) => !selected.has(n));
    const rows: { sort: string; items: ToolItem[] }[] = flatUnselected.map((n) => ({
      sort: n,
      items: [toolItem(n, false)],
    }));
    for (const key of groups.keys()) {
      const all = members.get(key)!.sort((a, b) => a.localeCompare(b));
      const on = all.filter((n) => selected.has(n)).length;
      const open = searching || this.expanded.has(key);
      const mark = on === 0 ? " " : on === all.length ? "x" : "-";
      const items: ToolItem[] = [
        {
          value: `group:${key}`,
          label: `${open ? "▾" : "▸"} [${mark}] ${dialogText(key)}`,
          description: `${on}/${all.length} tools · ${open ? "← collapse" : "→ expand"}`,
          group: "Session tools · A–Z",
        },
      ];
      if (open) {
        for (const n of all) {
          if (searching && !matchedNames.has(n)) continue;
          const item = toolItem(n, selected.has(n));
          item.label = `    ${item.label}`;
          item.group = "Session tools · A–Z";
          items.push(item);
        }
      }
      rows.push({ sort: key, items });
    }
    rows.sort((x, y) => x.sort.localeCompare(y.sort));
    this.currentItems = [
      ...flatSelected.map((name) => toolItem(name, true)),
      ...rows.flatMap((row) => row.items),
      {
        value: "action:done",
        label: "Done",
        description: "Apply this list to the agent draft",
        group: "Actions",
      },
      {
        value: "action:empty",
        label: "Empty list",
        description: "Set an explicit empty list",
        group: "Actions",
      },
      {
        value: "action:unset",
        label: "Unset (use default policy)",
        description: "Remove the explicit list",
        group: "Actions",
      },
      {
        value: "action:cancel",
        label: "Cancel",
        description: "Discard tool list changes",
        group: "Actions",
      },
    ];
    const list = new SelectList(
      this.currentItems,
      Math.min(this.currentItems.length, 10),
      getSelectListTheme(),
      LAYOUT,
    );
    const preferred = focusResult
      ? this.currentItems.findIndex((row) => row.group === "Session tools · A–Z")
      : this.currentItems.findIndex((row) => row.value === selectedValue);
    list.setSelectedIndex(
      preferred >= 0
        ? preferred
        : focusResult
          ? 0
          : Math.max(0, Math.min(previousIndex, this.currentItems.length - 1)),
    );
    list.onSelect = (item) => {
      if (item.value === "action:done") this.finish();
      else if (item.value === "action:cancel") this.options.onCancel();
      else {
        if (item.value.startsWith("group:")) {
          const key = item.value.slice("group:".length);
          const names = [
            ...new Set([...this.tools.map((t) => t.name), ...(this.draft ?? [])]),
          ].filter((n) => mcpServerOf(n) !== undefined && `mcp__${mcpServerOf(n)}` === key);
          const allOn = names.every((n) => this.draft?.includes(n));
          const rest = (this.draft ?? []).filter((n) => !names.includes(n));
          this.draft = allOn ? rest : [...rest, ...names];
        } else if (item.value === "action:unset") this.draft = undefined;
        else if (item.value === "action:empty") this.draft = [];
        else {
          const name = item.value.slice("tool:".length);
          this.draft ??= [];
          const index = this.draft.indexOf(name);
          if (index >= 0) this.draft.splice(index, 1);
          else this.draft.push(name);
        }
        this.refresh(item.value);
        this.options.tui.requestRender();
      }
    };
    list.onCancel = () => this.options.onCancel();
    list.onSelectionChange = () => this.options.tui.requestRender();
    this.selectList = list;
    if (this.children[1]) this.children[1] = list;
    else this.addChild(list);
  }
}

export async function editToolSelection(
  ctx: ExtensionCommandContext,
  field: "allow" | "block",
  current: readonly string[] | undefined,
  options: ToolEditorOptions,
): Promise<readonly string[] | undefined | typeof TOOL_EDITOR_CANCEL> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify("Tool selection requires interactive TUI mode; draft unchanged.", "warning");
    return TOOL_EDITOR_CANCEL;
  }
  return ctx.ui.custom<readonly string[] | undefined | typeof TOOL_EDITOR_CANCEL>(
    (tui, theme, _keys, done) =>
      new ToolPickerComponent({
        tui,
        theme,
        tools: options.getAllTools(),
        field,
        toolFiltering: options.toolFiltering,
        initialTools: current,
        onDone: (tools) => done(tools),
        onCancel: () => done(TOOL_EDITOR_CANCEL),
      }),
    DIALOG_OPTIONS,
  );
}

