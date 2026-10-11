import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ScopedModel, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { OrderedModelEditorComponent } from "../src/ui/model-picker.ts";

initTheme();

const DOWN = "\u001B[B";
const ENTER = "\r";
const CTRL_UP = "\u001B[1;5A";
const CTRL_DOWN = "\u001B[1;5B";
const CTRL_S = "\u0013";
const ESC = "\u001B";

function availableModel(provider: string, id: string, name = id) {
  return { provider, id, name };
}

function createComponent(options?: {
  initialModels?: readonly string[];
  modelSuggestions?: readonly string[];
  availableModels?: readonly ReturnType<typeof availableModel>[];
  scopedModels?: readonly string[];
  terminalRows?: number;
}) {
  const done: string[][] = [];
  let cancelled = 0;
  const models = options?.availableModels ?? [
    availableModel("anthropic", "claude-3.7-sonnet", "Claude 3.7 Sonnet"),
    availableModel("google", "gemini-2.5-pro", "Gemini 2.5 Pro"),
    availableModel("local", "llama3.3", "Llama 3.3"),
    availableModel("openai", "gpt-4.1", "GPT-4.1"),
  ];
  const component = new OrderedModelEditorComponent({
    tui: {
      requestRender: () => {},
      terminal: { rows: options?.terminalRows ?? 24 },
    },
    theme: { fg: (_color: string, text: string) => text } as unknown as Theme,
    availableModels: models,
    scopedModels: (options?.scopedModels ?? []).map((identity) => {
      const model = models.find((entry) => `${entry.provider}/${entry.id}` === identity);
      assert.ok(model, `Missing scoped model ${identity}`);
      return { model } as unknown as ScopedModel;
    }),
    initialModels: options?.initialModels,
    modelSuggestions: options?.modelSuggestions,
    onDone: (value) => done.push([...value]),
    onCancel: () => {
      cancelled += 1;
    },
  });
  return {
    component,
    done,
    getCancelled: () => cancelled,
  };
}

function press(component: OrderedModelEditorComponent, ...keys: string[]) {
  for (const key of keys) component.handleInput(key);
}

function moveSelectionToValue(component: OrderedModelEditorComponent, value: string) {
  const items = component.getCurrentItems();
  const targetIndex = items.findIndex((item) => item.value === value);
  assert.notEqual(targetIndex, -1, `Missing option: ${value}`);
  for (let remaining = items.length + 1; remaining > 0; remaining--) {
    if (component.getSelectList().getSelectedItem()?.value === value) return;
    press(component, DOWN);
  }
  assert.fail(`Could not focus option: ${value}`);
}

function activateValue(component: OrderedModelEditorComponent, value: string) {
  moveSelectionToValue(component, value);
  press(component, ENTER);
}

function modelItems(component: OrderedModelEditorComponent) {
  return component.getCurrentItems().filter((item) => !item.value.startsWith("action:"));
}

test("ordered model editor searches, annotates scope, and toggles without leaving the picker", () => {
  const { component, done } = createComponent({
    initialModels: [],
    scopedModels: ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1"],
  });

  component.focused = true;
  assert.equal(component.getMode(), "picker");
  assert.equal(component.getSearchInput()?.focused, true);

  press(component, ..."claude");
  assert.equal(component.getSelectList().getSelectedItem()?.value, "anthropic/claude-3.7-sonnet");
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), ["anthropic/claude-3.7-sonnet"]);
  assert.equal(component.getMode(), "picker");
  press(component, ...Array(6).fill("\u007f"));
  const pickerItems = modelItems(component);
  assert.equal(
    pickerItems.filter((item) => item.value === "anthropic/claude-3.7-sonnet").length,
    1,
  );
  assert.match(pickerItems[0]!.label, /\[x\] 1\./);
  assert.match(
    pickerItems.find((item) => item.value === "local/llama3.3")?.description ?? "",
    /portable preference/,
  );
  assert.match(
    pickerItems.find((item) => item.value === "openai/gpt-4.1")?.description ?? "",
    /scoped in this session/,
  );

  press(component, ..."llama");
  assert.equal(component.getSelectList().getSelectedItem()?.value, "local/llama3.3");
  press(component, ENTER);
  activateValue(component, "action:done");

  assert.deepEqual(done, [["anthropic/claude-3.7-sonnet", "local/llama3.3"]]);
});

test("suggested fuzzy matches are ranked scoped first, then unscoped, with an alphabetical remainder", () => {
  const { component } = createComponent({
    availableModels: [
      availableModel("z", "other"),
      availableModel("b", "sonnet-4", "Sonnet 4"),
      availableModel("a", "gpt-mini", "GPT Mini"),
      availableModel("a", "aardvark"),
      availableModel("c", "snnt", "Snnt"),
      availableModel("a", "sonnet-4", "Sonnet 4"),
      availableModel("a", "sonnet-4", "Sonnet 4"),
    ],
    scopedModels: ["a/sonnet-4", "c/snnt", "z/other"],
    // Abbreviation matching is deliberately not a substring search. Overlapping
    // suggestions and registry duplicates must not create duplicate rows.
    modelSuggestions: ["snnt", "GPT", "snnt", " ", "GPT Mini"],
  });
  assert.deepEqual(
    modelItems(component).map((item) => item.value),
    ["c/snnt", "a/sonnet-4", "a/gpt-mini", "b/sonnet-4", "a/aardvark", "z/other"],
  );
  const rendered = component.render(200).join("\n");
  assert.match(rendered, /Suggested matches · scoped models/);
  assert.match(rendered, /Suggested matches · other models/);
  assert.match(rendered, /All other models · A–Z/);
  // Headers aren't selectable; the second down arrow crosses a group boundary.
  press(component, DOWN, DOWN);
  assert.equal(component.getSelectList().getSelectedItem()?.value, "a/gpt-mini");
});

test("bundled suggestions match version separator variants without changing raw identities", () => {
  const { component } = createComponent({
    availableModels: [
      availableModel("openrouter", "anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"),
      availableModel("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5"),
      availableModel("amazon-bedrock", "us.anthropic.claude-sonnet-5-5-v1:0", "Claude Sonnet 5.5"),
      availableModel("anthropic", "claude-sonnet-5-4", "Claude Sonnet 5.4"),
      availableModel("a", "aardvark"),
    ],
    scopedModels: ["anthropic/claude-sonnet-5-5"],
    modelSuggestions: ["sonnet-5.5"],
  });
  assert.deepEqual(
    modelItems(component).map((item) => item.value),
    [
      "anthropic/claude-sonnet-5-5",
      "amazon-bedrock/us.anthropic.claude-sonnet-5-5-v1:0",
      "openrouter/anthropic/claude-sonnet-5.5",
      "a/aardvark",
      "anthropic/claude-sonnet-5-4",
    ],
  );
  press(component, ..."sonnet-5.5");
  assert.equal(modelItems(component).length, 3);
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), ["anthropic/claude-sonnet-5-5"]);
});

test("suggestions search display names and provider/id, retaining every match beyond ten", () => {
  const models = Array.from({ length: 25 }, (_, index) =>
    availableModel("provider", `opaque-${String(index).padStart(2, "0")}`, "Claude Sonnet"),
  );
  const { component } = createComponent({
    availableModels: [...models, availableModel("z", "other")],
    scopedModels: ["provider/opaque-24"],
    modelSuggestions: ["cld snt", "PROVIDER/OPAQUE"],
  });
  const values = modelItems(component).map((item) => item.value);
  assert.equal(values.length, 26);
  assert.equal(values[0], "provider/opaque-24");
  assert.deepEqual(
    values.slice(1, 25),
    models.slice(0, 24).map((model) => `provider/${model.id}`),
  );
  assert.equal(values.at(-1), "z/other");
});

test("typing fuzzy-filters the suggestion tiers; clearing restores them and annotations aren't searched", () => {
  const { component } = createComponent({
    modelSuggestions: ["Gemini", "GPT"],
    scopedModels: ["openai/gpt-4.1"],
  });
  const initial = modelItems(component).map((item) => item.value);
  assert.equal(initial[0], "openai/gpt-4.1");
  assert.equal(initial[1], "google/gemini-2.5-pro");
  press(component, ..."gmnp");
  assert.deepEqual(
    modelItems(component).map((item) => item.value),
    ["google/gemini-2.5-pro"],
  );
  press(component, ...Array(4).fill("\u007f"));
  assert.deepEqual(
    modelItems(component).map((item) => item.value),
    initial,
  );
  press(component, ..."portable preference");
  assert.equal(modelItems(component).length, 0);
  assert.match(component.render(100).join("\n"), /No matching models/);
});

test("missing or unmatched suggestions preserve alphabetical browsing, even with scoped models", () => {
  for (const modelSuggestions of [undefined, [], [" ", "zzzzzz"]]) {
    const { component } = createComponent({
      modelSuggestions,
      scopedModels: ["openai/gpt-4.1"],
    });
    assert.deepEqual(
      modelItems(component).map((item) => item.value),
      ["anthropic/claude-3.7-sonnet", "google/gemini-2.5-pro", "local/llama3.3", "openai/gpt-4.1"],
    );
    assert.doesNotMatch(component.render(200).join("\n"), /Suggested matches ·/);
  }
});

test("selected models come first in preference order without duplicates in suggestion tiers", () => {
  const { component } = createComponent({
    initialModels: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
    modelSuggestions: ["GPT", "Claude", "Gemini"],
    scopedModels: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
  });
  assert.equal(component.getMode(), "picker");
  assert.deepEqual(
    modelItems(component).map((item) => item.value),
    ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet", "google/gemini-2.5-pro", "local/llama3.3"],
  );
  assert.match(modelItems(component)[0]!.label, /\[x\] 1\./);
  assert.match(modelItems(component)[1]!.label, /\[x\] 2\./);
  const rendered = component.render(200).join("\n");
  assert.ok(rendered.indexOf("Selected models ·") < rendered.indexOf("Suggested matches ·"));
  // Enter on a selected row immediately unselects it and returns it to results.
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), ["anthropic/claude-3.7-sonnet"]);
  assert.deepEqual(
    modelItems(component).map((item) => item.value),
    ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1", "google/gemini-2.5-pro", "local/llama3.3"],
  );
  assert.match(modelItems(component)[1]!.label, /\[ \]/);
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1"]);
});

test("group headings keep selected models and footer visible on short terminals", () => {
  const models = Array.from({ length: 30 }, (_, index) =>
    availableModel("local", `model-${String(index).padStart(2, "0")}`),
  );
  const { component } = createComponent({
    terminalRows: 12,
    availableModels: models,
    modelSuggestions: ["model-0"],
    scopedModels: ["local/model-09"],
  });
  for (const value of ["local/model-09", "local/model-00", "local/model-29"]) {
    moveSelectionToValue(component, value);
    for (const width of [3, 18, 40, 80]) {
      const lines = component.render(width);
      assert.ok(lines.length <= 10);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      if (width >= 80) {
        assert.match(lines.join("\n"), new RegExp(`› \\[ \\] ${value}`));
        assert.match(lines.join("\n"), /Ctrl\+↑↓ reorder.*Esc cancel/);
        assert.match(stripTerminalSequences(lines.at(-1)!), /^╰.*╯$/);
      }
    }
  }
});

test("ordered model editor warns and annotates portable preferences when scope is empty", () => {
  const picker = createComponent({
    initialModels: [],
    scopedModels: [],
  }).component;
  assert.match(
    picker.render(200).join("\n"),
    /No scoped models: Pick First \(scoped\) cannot run explicit preferences\. Configure \/scoped-models or change Model Picking\./,
  );
  assert.match(
    picker.getCurrentItems().find((item) => item.value === "openai/gpt-4.1")?.description ?? "",
    /portable preference · not scoped in this session/,
  );

  const menu = createComponent({
    initialModels: ["openai/gpt-4.1"],
    scopedModels: [],
  }).component;
  assert.match(
    menu.render(200).join("\n"),
    /No scoped models: Pick First \(scoped\) cannot run explicit preferences\. Configure \/scoped-models or change Model Picking\./,
  );
  assert.match(
    menu.getCurrentItems().find((item) => item.value === "openai/gpt-4.1")?.description ?? "",
    /portable preference · not scoped in this session/,
  );
});

test("ordered model editor keeps raw identities while sanitizing picker labels", () => {
  const provider = "openai\u0007";
  const id = "gpt-4.1\u0000beta";
  const rawIdentity = `${provider}/${id}`;
  const { component, done } = createComponent({
    initialModels: [],
    availableModels: [availableModel(provider, id, "Unsafe\u001b[31m Name")],
    scopedModels: [],
  });

  press(component, ..."openai");
  const item = component.getCurrentItems()[0];
  assert.equal(item?.value, rawIdentity);
  assert.ok(item);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(item.label));
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), [rawIdentity]);
  activateValue(component, "action:done");
  assert.deepEqual(done, [[rawIdentity]]);
});

test("Ctrl up/down reorder selected models, preserve selection, and stop at boundaries", () => {
  const { component, done } = createComponent({
    initialModels: ["custom/missing", "openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
    scopedModels: ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1"],
  });
  assert.match(
    modelItems(component)[0]!.description ?? "",
    /unavailable in current model registry/,
  );
  press(component, CTRL_UP);
  assert.equal(component.getSelectList().getSelectedItem()?.value, "custom/missing");
  press(component, CTRL_DOWN);
  assert.deepEqual(component.getDraftModels(), [
    "openai/gpt-4.1",
    "custom/missing",
    "anthropic/claude-3.7-sonnet",
  ]);
  assert.equal(component.getSelectList().getSelectedItem()?.value, "custom/missing");
  assert.match(component.getSelectList().getSelectedItem()!.label, /\[x\] 2\./);
  press(component, CTRL_UP);
  assert.deepEqual(component.getDraftModels(), [
    "custom/missing",
    "openai/gpt-4.1",
    "anthropic/claude-3.7-sonnet",
  ]);
  moveSelectionToValue(component, "anthropic/claude-3.7-sonnet");
  press(component, CTRL_DOWN);
  assert.equal(component.getSelectList().getSelectedItem()?.value, "anthropic/claude-3.7-sonnet");
  moveSelectionToValue(component, "google/gemini-2.5-pro");
  press(component, CTRL_UP, CTRL_DOWN);
  assert.deepEqual(component.getDraftModels(), [
    "custom/missing",
    "openai/gpt-4.1",
    "anthropic/claude-3.7-sonnet",
  ]);
  assert.equal(component.getSelectList().getSelectedItem()?.value, "google/gemini-2.5-pro");
  assert.equal(component.getSearchInput().getValue(), "");
  activateValue(component, "custom/missing");
  assert.deepEqual(component.getDraftModels(), ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"]);
  assert.ok(!modelItems(component).some((item) => item.value === "custom/missing"));
  activateValue(component, "action:clear");
  assert.deepEqual(component.getDraftModels(), []);
  press(component, CTRL_S);
  assert.deepEqual(done, [[]]);
});

test("search keeps selected models above results and allows reorder while filtering", () => {
  const { component, done } = createComponent({
    initialModels: ["openai/gpt-4.1", "custom/missing"],
  });
  press(component, ..."gemini");
  assert.deepEqual(
    modelItems(component).map((item) => item.value),
    ["openai/gpt-4.1", "custom/missing", "google/gemini-2.5-pro"],
  );
  assert.equal(component.getSelectList().getSelectedItem()?.value, "google/gemini-2.5-pro");
  moveSelectionToValue(component, "openai/gpt-4.1");
  press(component, CTRL_DOWN);
  assert.deepEqual(component.getDraftModels(), ["custom/missing", "openai/gpt-4.1"]);
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), ["custom/missing"]);
  assert.equal(component.getSearchInput().getValue(), "gemini");
  activateValue(component, "google/gemini-2.5-pro");
  assert.deepEqual(component.getDraftModels(), ["custom/missing", "google/gemini-2.5-pro"]);
  press(component, CTRL_S);
  assert.deepEqual(done, [["custom/missing", "google/gemini-2.5-pro"]]);
});

test("Escape cancels without committing toggles or reordering", () => {
  const { component, done, getCancelled } = createComponent({
    initialModels: ["openai/gpt-4.1"],
  });
  activateValue(component, "google/gemini-2.5-pro");
  press(component, CTRL_UP, ..."gemini", ESC);
  assert.equal(getCancelled(), 1);
  assert.deepEqual(done, []);
});

test("model dialogs keep selected rows, borders and footer visible on short terminals", () => {
  const models = Array.from({ length: 30 }, (_, i) => availableModel("local", `model-${i}`));
  const { component } = createComponent({
    terminalRows: 12,
    availableModels: models,
    initialModels: models.map((model) => `local/${model.id}`),
  });
  moveSelectionToValue(component, "local/model-29");
  for (const width of [3, 18, 40, 80]) {
    const lines = component.render(width);
    assert.ok(lines.length <= 10);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width >= 80) {
      assert.match(lines.join("\n"), /model-29/);
      assert.match(lines.join("\n"), /Esc cancel/);
      assert.match(stripTerminalSequences(lines.at(-1)!), /^╰.*╯$/);
    }
  }
  press(component, CTRL_UP);
  assert.equal(component.getSelectList().getSelectedItem()?.value, "local/model-29");
  component.focused = true;
  const lines = component.render(80);
  assert.ok(lines.length <= 10);
  assert.match(lines.join("\n"), /Ctrl\+↑↓ reorder.*Esc cancel/);
  assert.match(stripTerminalSequences(lines.at(-1)!), /^╰.*╯$/);
});

