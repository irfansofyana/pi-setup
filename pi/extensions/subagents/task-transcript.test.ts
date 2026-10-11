import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TranscriptSnapshot } from "./upstream/src/types.ts";
import { projectTaskMessages, wrapTaskMessages } from "./task-transcript.ts";

const snapshot = (messages: unknown[], assistant: unknown = null): TranscriptSnapshot => ({
  generation: 0, revision: 1, inheritedCount: 0, tools: [], messages: messages as any, assistant: assistant as any,
});

test("task projection keeps user and assistant text without thoughts, errors or tool payloads", () => {
  const value = snapshot([
    { role: "user", content: "Please inspect\nthese files\x1b]0;hidden-title\x07" },
    { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THOUGHT" }, { type: "text", text: "Safe response" }, { type: "toolCall", arguments: "PRIVATE_ARGUMENTS" }] },
    { role: "toolResult", content: [{ type: "text", text: "PRIVATE_RESULT" }] },
    { role: "assistant", stopReason: "error", errorMessage: "PRIVATE_ERROR", content: [{ type: "text", text: "PRIVATE_ERROR_BODY" }] },
  ]);
  const text = wrapTaskMessages(projectTaskMessages(value), 24).map(line => line.text).join("\n");
  assert.match(text, /You/); assert.match(text, /Please inspect\nthese files/);
  assert.match(text, /Agent/); assert.match(text, /Safe response/);
  assert.match(text, /Provider error/); assert.doesNotMatch(text, /PRIVATE_|hidden-title|\x1b/);
});

test("wrapped message row identities survive appended messages and streaming text", () => {
  const user = { role: "user", timestamp: 1, content: "Find the navigation handlers" };
  const old = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "First stable line\nSecond line" }] };
  const before = wrapTaskMessages(projectTaskMessages(snapshot([user], old)), 18);
  const after = wrapTaskMessages(projectTaskMessages(snapshot([user, old], { role: "assistant", timestamp: 3, content: [{ type: "text", text: "New live message" }] })), 18);
  for (const row of before) assert.ok(after.some(next => next.key === row.key && next.text === row.text));
  assert.ok(after.every(line => visibleWidth(line.text) <= 18));
});

test("word wrapping retains source anchors across skipped spaces and repeated words", () => {
  const message = { key: "message", role: "Agent" as const, text: "same  same   tail", offset: 7, omitted: false };
  const rows = wrapTaskMessages([message], 6).filter(line => line.tone === "text");
  assert.deepEqual(rows.map(({ key, text }) => ({ key, text })), [
    { key: "message:7", text: "same" },
    { key: "message:13", text: "same" },
    { key: "message:20", text: "tail" },
  ]);
  const streamed = wrapTaskMessages([{ ...message, text: `${message.text} grows` }], 6);
  for (const row of rows) assert.ok(streamed.some(next => next.key === row.key && next.text === row.text));
});

test("wrapping preserves wide and combining graphemes with UTF-16 source anchors", () => {
  const rows = wrapTaskMessages([{ key: "message", role: "Agent", text: "界界e\u0301😀界", offset: 0, omitted: false }], 4);
  assert.deepEqual(rows.filter(line => line.tone === "text").map(({ key, text }) => ({ key, text })), [
    { key: "message:0", text: "界界" },
    { key: "message:2", text: "e\u0301😀" },
    { key: "message:6", text: "界" },
  ]);
  assert.ok(rows.every(line => visibleWidth(line.text) <= 4));
});

test("single-column wrapping clips oversized graphemes without duplicate anchors", () => {
  const message = { key: "message", role: "Agent" as const, text: "界😀x\n\ntail", offset: 0, omitted: true };
  const rows = wrapTaskMessages([message], 1);
  assert.ok(rows.every(line => visibleWidth(line.text) <= 1));
  assert.equal(new Set(rows.map(line => line.key)).size, rows.length);
  assert.deepEqual(rows.filter(line => line.tone === "text" && line.text).map(line => line.text), ["x", "t", "a", "i", "l"]);
  assert.deepEqual(wrapTaskMessages([message], 0), []);
});

test("same-role messages with equal timestamps retain separate scroll anchors", () => {
  const projection = projectTaskMessages(snapshot([
    { role: "user", timestamp: 1, content: "First message" },
    { role: "user", timestamp: 1, content: "Second message" },
  ]));
  assert.notEqual(projection[0].key, projection[1].key);
});

test("task projection and wrapping retain bounded recent content with visible truncation", () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ role: "user", timestamp: index, content: `${index}:` + "x".repeat(20_000) }));
  const projection = projectTaskMessages(snapshot(messages));
  assert.ok(projection.length <= 24);
  assert.ok(projection.reduce((sum, item) => sum + item.text.length, 0) <= 48_000);
  const rows = wrapTaskMessages(projection, 40);
  assert.match(rows.map(row => row.text).join("\n"), /Earlier text omitted/);
  assert.ok(rows.every(line => visibleWidth(line.text) <= 40));
});
