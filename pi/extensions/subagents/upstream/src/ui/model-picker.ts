import fuzzysort, { type SnapshotKeys } from "fuzzysort";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getSelectListTheme,
  type ExtensionCommandContext,
  type ScopedModel,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  SelectList,
  stripTerminalSequences,
  truncateToWidth,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { modelIdentity } from "../prefs/models.ts";
import { dialogHeight, frameDialog, DIALOG_OPTIONS } from "./dialog.ts";

const MODEL_EDITOR_LAYOUT = {
  minPrimaryColumnWidth: 24,
  maxPrimaryColumnWidth: 52,
} as const;

const PICKER_TITLE = "Preferred models";
const SELECTED_GROUP = "Selected models · ordered fallback";
const ACTIONS_GROUP = "Actions";

export const MODEL_EDITOR_CANCEL = Symbol("model-editor-cancel");

type AvailableModel = Pick<Model<Api>, "provider" | "id" | "name">;

interface ModelSelectItem extends SelectItem {
  group: string;
}

interface OrderedModelEditorComponentOptions {
  tui: { requestRender(force?: boolean): void; terminal?: { rows: number } };
  theme: Theme;
  availableModels: readonly AvailableModel[];
  scopedModels: readonly ScopedModel[];
  initialModels?: readonly string[];
  modelSuggestions?: readonly string[];
  onDone(models: string[]): void;
  onCancel(): void;
}

function sanitizeModelText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function renderModelIdentity(identity: string): string {
  return sanitizeModelText(identity);
}

function modelSearchText(text: string): string {
  // Providers spell the same version differently (sonnet-5.5 vs sonnet-5-5).
  // Strip separators rather than splitting them into repeated numeric terms;
  // raw identities and labels remain untouched.
  return sanitizeModelText(text).replace(/[._:/-]+/g, "");
}

function sortModels(models: readonly AvailableModel[]): AvailableModel[] {
  const unique = new Map<string, AvailableModel>();
  for (const model of models) unique.set(modelIdentity(model), model);
  return [...unique.values()].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.id.localeCompare(b.id) ||
      sanitizeModelText(a.name).localeCompare(sanitizeModelText(b.name)),
  );
}

function describeModel(model: AvailableModel, scopedIdentities: ReadonlySet<string>): string {
  const annotation = scopedIdentities.has(modelIdentity(model))
    ? "scoped in this session"
    : "portable preference · not scoped in this session";
  const name = sanitizeModelText(model.name);
  return [name, annotation].filter(Boolean).join(" · ");
}

export class OrderedModelEditorComponent extends Container {
  private readonly tui: {
    requestRender(force?: boolean): void;
    terminal?: { rows: number };
  };
  private readonly theme: Theme;
  private readonly allModels: readonly AvailableModel[];
  private readonly modelSearch: SnapshotKeys<AvailableModel>;
  private readonly suggestedScores: ReadonlyMap<string, number>;
  private readonly modelsByIdentity = new Map<string, AvailableModel>();
  private readonly scopedIdentities: ReadonlySet<string>;
  private readonly onDone: (models: string[]) => void;
  private readonly onCancel: () => void;
  private readonly titleText = new Text();
  private readonly subtitleText = new Text();
  private readonly footerText = new Text();
  private readonly searchInput = new Input({ placeholder: "Search models" });
  private draft: string[];
  private pickerQuery = "";
  private currentItems: ModelSelectItem[] = [];
  private selectList = new SelectList([], 1, getSelectListTheme(), MODEL_EDITOR_LAYOUT);
  private _focused = false;

  constructor(options: OrderedModelEditorComponentOptions) {
    super();
    this.tui = options.tui;
    this.theme = options.theme;
    this.allModels = sortModels(options.availableModels);
    // The registry is fixed for this dialog; prepare searchable fields once.
    // Scope annotations deliberately aren't searchable model metadata.
    this.modelSearch = fuzzysort.snapshot(this.allModels, {
      keys: [
        (model) => modelSearchText(modelIdentity(model)),
        (model) => modelSearchText(model.name),
      ],
    });
    this.suggestedScores = this.searchScores(options.modelSuggestions ?? []);
    this.onDone = options.onDone;
    this.onCancel = options.onCancel;
    for (const model of this.allModels) this.modelsByIdentity.set(modelIdentity(model), model);
    this.scopedIdentities = new Set(
      options.scopedModels.map((entry) => modelIdentity(entry.model)),
    );
    this.draft = [...new Set(options.initialModels ?? [])];
    this.titleText.setText(this.theme.fg("accent", PICKER_TITLE));
    this.subtitleText.setText(
      this.theme.fg(
        "muted",
        this.withScopeWarning(
          this.suggestedScores.size
            ? "Selected first; suggested matches scoped first, then other models; the rest A–Z. Type to search."
            : "Selected first. Search by provider/id or model name; other models A–Z.",
        ),
      ),
    );
    this.footerText.setText(
      this.theme.fg("dim", "↑↓ select · Enter toggle · Ctrl+↑↓ reorder · Ctrl+S done · Esc cancel"),
    );
    this.addChild(this.searchInput);
    this.refreshPickerList();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  getMode(): "picker" {
    return "picker";
  }

  getDraftModels(): readonly string[] {
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
    const height = dialogHeight(this.tui);
    const inner = Math.max(1, width - 4);
    const header = [
      truncateToWidth(
        this.subtitleText
          .render(1000)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" "),
        inner,
        "",
      ),
      ...this.searchInput.render(inner),
    ];
    const budget = Math.max(1, height - 4 - header.length);
    const selected = this.selectList.getSelectedItem()?.value;
    // Headings are visual rows only: keyboard navigation selects models, not groups.
    const displayRows: (ModelSelectItem | string)[] = [];
    let previousGroup: string | undefined;
    const hasResults = this.currentItems.some(
      (item) => item.group !== SELECTED_GROUP && item.group !== ACTIONS_GROUP,
    );
    for (const item of this.currentItems) {
      if (item.group !== previousGroup) {
        if (item.group === ACTIONS_GROUP && !hasResults) displayRows.push("No matching models");
        displayRows.push(item.group);
      }
      previousGroup = item.group;
      displayRows.push(item);
    }
    const index = Math.max(
      0,
      displayRows.findIndex((row) => typeof row !== "string" && row.value === selected),
    );
    const start = Math.max(0, Math.min(index - budget + 1, displayRows.length - budget));
    // Only format visible rows; a registry can contain thousands of models.
    const rows = displayRows.slice(start, start + budget).map((row) => {
      if (typeof row === "string") return this.theme.fg("muted", row);
      const text = `${row.value === selected ? "›" : " "} ${row.label}  ${this.theme.fg("muted", row.description ?? "")}`;
      return row.value === selected ? this.theme.fg("accent", text) : text;
    });
    return frameDialog(
      this.theme,
      width,
      height,
      this.titleText.render(1000).join(" ").trim(),
      [...header, ...rows].map((line) => ` ${line}`),
      this.footerText
        .render(1000)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    );
  }

  handleInput(keyData: string): void {
    if (matchesKey(keyData, Key.ctrl("s"))) {
      this.onDone([...this.draft]);
      return;
    }
    const earlier = matchesKey(keyData, Key.ctrl("up"));
    const later = matchesKey(keyData, Key.ctrl("down"));
    if (earlier || later) {
      const selected = this.selectList.getSelectedItem()?.value;
      const index = selected === undefined ? -1 : this.draft.indexOf(selected);
      const next = index + (earlier ? -1 : 1);
      // Consume reorder keys even on unselected models or at a list boundary.
      if (index >= 0 && next >= 0 && next < this.draft.length) {
        [this.draft[index], this.draft[next]] = [this.draft[next], this.draft[index]];
        this.refreshPickerList(selected);
        this.tui.requestRender();
      }
      return;
    }
    const kb = getKeybindings();
    const isNav =
      kb.matches(keyData, "tui.select.up") ||
      kb.matches(keyData, "tui.select.down") ||
      kb.matches(keyData, "tui.select.confirm") ||
      kb.matches(keyData, "tui.select.cancel");
    if (isNav) {
      this.selectList.handleInput(keyData);
    } else {
      this.searchInput.handleInput(keyData);
      const nextQuery = this.searchInput.getValue();
      if (nextQuery !== this.pickerQuery) {
        this.pickerQuery = nextQuery;
        // Keep selected preferences visible, but focus the first search result
        // so typing a query and pressing Enter still adds the matching model.
        this.refreshPickerList(undefined, true);
      }
    }
    this.tui.requestRender();
  }

  private refreshPickerList(selectedValue?: string, focusSearchResult = false): void {
    const previousIndex = this.currentItems.findIndex(
      (item) => item.value === this.selectList.getSelectedItem()?.value,
    );
    this.currentItems = [
      ...this.draft.map((identity, index) => ({
        value: identity,
        label: `[x] ${index + 1}. ${renderModelIdentity(identity)}`,
        description: this.describeDraftIdentity(identity),
        group: SELECTED_GROUP,
      })),
      ...this.getPickerItems(),
      {
        value: "action:done",
        label: "Done",
        description: "Commit this ordered model preference list",
        group: ACTIONS_GROUP,
      },
      {
        value: "action:clear",
        label: "Use inherited default",
        description: "Clear explicit preferences and inherit the default model",
        group: ACTIONS_GROUP,
      },
      {
        value: "action:cancel",
        label: "Cancel",
        description: "Discard unsaved model preference changes",
        group: ACTIONS_GROUP,
      },
    ];
    const list = new SelectList(
      this.currentItems,
      Math.min(this.currentItems.length, 10),
      getSelectListTheme(),
      MODEL_EDITOR_LAYOUT,
    );
    const preferredIndex = focusSearchResult
      ? this.currentItems.findIndex(
          (item) => item.group !== SELECTED_GROUP && item.group !== ACTIONS_GROUP,
        )
      : this.currentItems.findIndex((item) => item.value === selectedValue);
    list.setSelectedIndex(
      preferredIndex >= 0
        ? preferredIndex
        : focusSearchResult
          ? 0
          : Math.max(0, Math.min(previousIndex, this.currentItems.length - 1)),
    );
    list.onSelect = (item) => {
      if (this.currentItems.find((row) => row.value === item.value)?.group === ACTIONS_GROUP) {
        if (item.value === "action:done") this.onDone([...this.draft]);
        else if (item.value === "action:cancel") this.onCancel();
        else {
          this.draft = [];
          this.refreshPickerList("action:done");
          this.tui.requestRender();
        }
        return;
      }
      const index = this.draft.indexOf(item.value);
      if (index >= 0) this.draft.splice(index, 1);
      else this.draft.push(item.value);
      this.refreshPickerList(item.value);
      this.tui.requestRender();
    };
    list.onSelectionChange = () => this.tui.requestRender();
    list.onCancel = () => this.onCancel();
    this.selectList = list;
    if (this.children[1]) this.children[1] = list;
    else this.addChild(list);
  }

  private searchScores(queries: readonly string[]): Map<string, number> {
    const scores = new Map<string, number>();
    const uniqueQueries = new Set(
      queries.map((query) => modelSearchText(query).trim()).filter(Boolean),
    );
    for (const query of uniqueQueries) {
      // Both defaults are restrictive (10 results, score >= .5); collect every
      // fuzzy match so suggestions aren't silently capped or omitted.
      for (const result of fuzzysort.go(query, this.modelSearch, {
        limit: 0,
        threshold: 0,
      })) {
        const identity = modelIdentity(result.obj);
        scores.set(identity, Math.max(scores.get(identity) ?? 0, result.score));
      }
    }
    return scores;
  }

  private getPickerItems(): ModelSelectItem[] {
    const excluded = new Set(this.draft);
    const query = this.pickerQuery.trim();
    const queryScores = query ? this.searchScores([query]) : undefined;
    const scoped: AvailableModel[] = [];
    const other: AvailableModel[] = [];
    const remaining: AvailableModel[] = [];
    for (const model of this.allModels) {
      const identity = modelIdentity(model);
      if (excluded.has(identity) || (queryScores && !queryScores.has(identity))) continue;
      if (this.suggestedScores.has(identity)) {
        (this.scopedIdentities.has(identity) ? scoped : other).push(model);
      } else {
        remaining.push(model);
      }
    }
    const bySuggestionScore = (a: AvailableModel, b: AvailableModel) =>
      this.suggestedScores.get(modelIdentity(b))! - this.suggestedScores.get(modelIdentity(a))!;
    // Stable score sorting preserves alphabetical order for ties. The last
    // tier retains the registry's alphabetical order, irrespective of scope.
    scoped.sort(bySuggestionScore);
    other.sort(bySuggestionScore);
    const items = (models: AvailableModel[], group: string): ModelSelectItem[] =>
      models.map((model) => ({
        value: modelIdentity(model),
        label: `[ ] ${renderModelIdentity(modelIdentity(model))}`,
        description: describeModel(model, this.scopedIdentities),
        group,
      }));
    return [
      ...items(scoped, "Suggested matches · scoped models"),
      ...items(other, "Suggested matches · other models"),
      ...items(
        remaining,
        scoped.length || other.length ? "All other models · A–Z" : "All models · A–Z",
      ),
    ];
  }

  private describeDraftIdentity(identity: string): string {
    const model = this.modelsByIdentity.get(identity);
    if (!model) return "unavailable in current model registry";
    return describeModel(model, this.scopedIdentities);
  }

  private withScopeWarning(text: string): string {
    if (this.scopedIdentities.size === 0) {
      return `No scoped models: Pick First (scoped) cannot run explicit preferences. Configure /scoped-models or change Model Picking. ${text}`;
    }
    return text;
  }
}

export async function editModelPreferences(
  ctx: ExtensionCommandContext,
  currentModels?: readonly string[],
  modelSuggestions?: readonly string[],
): Promise<readonly string[] | typeof MODEL_EDITOR_CANCEL> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Ordered model preferences require interactive TUI mode; draft unchanged.",
        "warning",
      );
    }
    return MODEL_EDITOR_CANCEL;
  }
  const availableModels = ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
  }));
  return ctx.ui.custom<readonly string[] | typeof MODEL_EDITOR_CANCEL>(
    (tui, theme, _keys, done) =>
      new OrderedModelEditorComponent({
        tui,
        theme,
        availableModels,
        scopedModels: ctx.scopedModels,
        initialModels: currentModels,
        modelSuggestions,
        onDone: (models) => done(models),
        onCancel: () => done(MODEL_EDITOR_CANCEL),
      }),
    DIALOG_OPTIONS,
  );
}

