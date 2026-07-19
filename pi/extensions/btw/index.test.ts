import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConversationContext,
  buildHistoryContext,
  buildStreamOptions,
  buildUserPrompt,
  normalizeConfig,
  parseModelReference,
  type BtwTurn,
} from "./index.ts";

test("parseModelReference splits provider and model id at first slash", () => {
  assert.deepEqual(parseModelReference("openrouter/openai/gpt-5-mini"), {
    provider: "openrouter",
    modelId: "openai/gpt-5-mini",
  });
  assert.equal(parseModelReference("bad model"), undefined);
  assert.equal(parseModelReference("missing-slash"), undefined);
});

test("normalizeConfig clamps numeric fields and drops invalid optional settings", () => {
  assert.deepEqual(normalizeConfig({
    model: "openrouter/openai/gpt-5-mini",
    thinkingLevel: "low",
    maxContextChars: 999_999,
    maxHistoryTurns: -1,
  }), {
    model: "openrouter/openai/gpt-5-mini",
    thinkingLevel: "low",
    maxContextChars: 200_000,
    maxHistoryTurns: 0,
  });

  assert.deepEqual(normalizeConfig({ model: "bad", thinkingLevel: "huge" }), {
    maxContextChars: 40_000,
    maxHistoryTurns: 8,
  });
});

test("buildConversationContext keeps recent message text within char budget", () => {
  const context = buildConversationContext([
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "second" }] } },
    { type: "custom", data: { ignored: true } },
  ], 18);

  assert.equal(context, "assistant: second");
});

test("buildConversationContext includes compaction and branch summaries", () => {
  const context = buildConversationContext([
    { type: "compaction", summary: "Earlier work changed auth.ts and added tests." },
    { type: "branch_summary", summary: "Abandoned branch tried fetch-based auth." },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "continue" }] } },
  ], 10_000);

  assert.match(context, /compaction_summary: Earlier work changed auth\.ts/);
  assert.match(context, /branch_summary: Abandoned branch tried fetch-based auth/);
  assert.match(context, /user: continue/);
});

test("buildConversationContext handles already-built session context messages", () => {
  const context = buildConversationContext([
    { role: "compactionSummary", summary: "Prior summary from buildSessionContext." },
    { role: "assistant", content: [{ type: "text", text: "fresh answer" }] },
  ], 10_000);

  assert.match(context, /compaction_summary: Prior summary from buildSessionContext/);
  assert.match(context, /assistant: fresh answer/);
});

test("buildConversationContext skips excluded bash executions", () => {
  const context = buildConversationContext([
    { role: "bashExecution", command: "cat secret.txt", output: "SECRET", excludeFromContext: true },
    { role: "bashExecution", command: "npm test", output: "ok", excludeFromContext: false },
  ], 10_000);

  assert.doesNotMatch(context, /SECRET/);
  assert.doesNotMatch(context, /cat secret\.txt/);
  assert.match(context, /npm test/);
  assert.match(context, /ok/);
});

test("buildHistoryContext preserves latest side-thread turns", () => {
  const history: BtwTurn[] = [
    { question: "q1", answer: "a1", timestamp: 1 },
    { question: "q2", answer: "a2", timestamp: 2 },
  ];

  assert.equal(buildHistoryContext(history, 1), "Side turn 1\nUser: q2\nAssistant: a2");
});

test("buildUserPrompt includes main context, optional history, and question", () => {
  const prompt = buildUserPrompt("why?", "user: fix auth", "Side turn 1\nUser: q\nAssistant: a");
  assert.match(prompt, /## Main Session Context/);
  assert.match(prompt, /## Previous \/btw Side Thread/);
  assert.match(prompt, /## Side Question\n\nwhy\?/);
});

test("buildStreamOptions omits off reasoning", () => {
  const options = buildStreamOptions({ apiKey: "key" }, undefined, "off") as { reasoning?: string };
  assert.equal(options.reasoning, undefined);
});

test("buildStreamOptions passes enabled reasoning levels", () => {
  const options = buildStreamOptions({ apiKey: "key" }, undefined, "low") as { reasoning?: string };
  assert.equal(options.reasoning, "low");
});
