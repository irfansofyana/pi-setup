import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getModelPreferences,
  selectPreferredModel,
  ModelPreferenceError,
} from "../src/prefs/models.ts";
import { agentTools } from "../src/orch/tools.ts";
import type { AgentType } from "../src/types.ts";

const eligible = (...ids: string[]) =>
  ids.map((identity) => {
    const [provider, ...rest] = identity.split("/");
    return { model: { provider: provider!, id: rest.join("/") } };
  });

test("getModelPreferences accepts omitted, legacy and canonical forms and copies input", () => {
  assert.equal(getModelPreferences({}), undefined);
  assert.deepEqual(getModelPreferences({ model: "p/model/with/slashes" }), [
    "p/model/with/slashes",
  ]);
  const input = { models: ["p/first", "p/second"] };
  const preferences = getModelPreferences(input)!;
  assert.deepEqual(preferences, ["p/first", "p/second"]);
  preferences.reverse();
  assert.deepEqual(input.models, ["p/first", "p/second"]);
});

test("getModelPreferences rejects ambiguous or malformed values", () => {
  for (const type of [
    { model: "p/legacy", models: ["p/current"] },
    { models: null },
    { models: "p/model" },
    { models: [] },
    { models: ["p/model", "p/model"] },
    { models: ["bad"] },
  ]) {
    assert.throws(() => getModelPreferences(type), JSON.stringify(type));
  }
});

test("selectPreferredModel uses preference order and returns undefined without preferences", () => {
  const type = {
    name: "r",
    models: ["p/missing", "p/second", "p/first"],
    modelSuggestions: ["p/first"],
  };
  assert.equal(selectPreferredModel(type, eligible("p/first", "p/second")), "p/second");
  assert.equal(selectPreferredModel(type, eligible("p/first", "p/second"), false), "p/second");
  assert.equal(selectPreferredModel({ name: "w" }, eligible("p/first")), undefined);
  assert.equal(selectPreferredModel({ name: "w" }, [], false), undefined);
});

test("selectPreferredModel errors name the agent, preferences and available models per filtering mode", () => {
  const type = { name: "researcher", models: ["p/preferred", "p/fallback"] };
  assert.throws(
    () => selectPreferredModel(type, eligible("p/available", "o/choice")),
    /researcher[\s\S]*p\/preferred[\s\S]*p\/fallback[\s\S]*p\/available[\s\S]*o\/choice[\s\S]*\/scoped-models/,
  );
  assert.throws(() => selectPreferredModel(type, []), /\(none\)[\s\S]*\/scoped-models/);
  assert.throws(
    () => selectPreferredModel(type, eligible("p/available"), false),
    (error: unknown) => {
      assert.match(String(error), /Available models: \[p\/available\]/);
      assert.doesNotMatch(String(error), /scoped/);
      return true;
    },
  );
});

test("agent_types exposes only names, descriptions and resolved settings in compact text", async () => {
  const definition = (fields: Partial<AgentType>): AgentType => ({
    name: "worker",
    description: "Worker",
    systemPrompt: "Work",
    ...fields,
  });
  const types = [
    definition({
      models: ["p/second", "p/first"],
      modelSuggestions: ["Sonnet"],
      color: "accent",
      icon: "*",
      thinkingLevel: "high",
    }),
    definition({ name: "legacy", model: "p/legacy" }),
    definition({ name: "suggested", modelSuggestions: ["Claude Opus"] }),
  ];
  const tool = agentTools(
    () => {
      throw new Error("Listing types must not require a running manager");
    },
    "/root",
    () => types,
    (type) => ({
      model: type.models?.[0] ?? type.model ?? "p/inherited",
      thinkingLevel: type.thinkingLevel ?? "low",
    }),
  ).find((entry) => entry.name === "agent_types")!;
  const before = structuredClone(types);
  const output = await tool.execute("list-types", {}, undefined, undefined, {} as never);
  assert.deepEqual(output.details, [
    { name: "worker", description: "Worker", model: "p/second", thinkingLevel: "high" },
    { name: "legacy", description: "Worker", model: "p/legacy", thinkingLevel: "low" },
    { name: "suggested", description: "Worker", model: "p/inherited", thinkingLevel: "low" },
  ]);
  assert.deepEqual(output.content, [
    {
      type: "text",
      text: [
        "worker (p/second, thinking: high): Worker",
        "legacy (p/legacy, thinking: low): Worker",
        "suggested (p/inherited, thinking: low): Worker",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(types, before);
  types[0]!.description = "Updated description";
  const updated = await tool.execute("reload", {}, undefined, undefined, {} as never);
  assert.match((updated.content[0] as { text: string }).text, /Updated description/);
});

test("agent_types keeps unavailable entries without failing the whole listing and handles no types", async () => {
  let types: AgentType[] = [
    { name: "broken", description: "Needs configuration", systemPrompt: "Work" },
    { name: "ready", description: "Can work", systemPrompt: "Work" },
  ];
  const tool = agentTools(
    () => {
      throw new Error("Discovery must not initialize threads");
    },
    "/root",
    () => types,
    (type) => {
      if (type.name === "broken")
        throw new ModelPreferenceError(
          "Verbose diagnostics with preference lists and all available models",
          true,
        );
      return { model: "p/ready", thinkingLevel: "off" };
    },
  ).find((entry) => entry.name === "agent_types")!;
  const output = await tool.execute("list", {}, undefined, undefined, {} as never);
  assert.deepEqual(output.details, [
    {
      name: "broken",
      description: "Needs configuration",
      error:
        "No preferred model is available in /scoped-models; update the scope or this type's models.",
    },
    { name: "ready", description: "Can work", model: "p/ready", thinkingLevel: "off" },
  ]);
  assert.match(
    (output.content[0] as { text: string }).text,
    /broken \(unavailable\)[\s\S]*ready \(p\/ready, thinking: off\)/,
  );
  types = [];
  const empty = await tool.execute("empty", {}, undefined, undefined, {} as never);
  assert.deepEqual(empty.details, []);
  assert.deepEqual(empty.content, [{ type: "text", text: "No agent types available." }]);
});

