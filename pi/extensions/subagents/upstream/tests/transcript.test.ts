import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TranscriptChannel } from "../src/orch/transcript.ts";
import type { TranscriptSnapshot } from "../src/types.ts";

const assistant = (
  text: string,
  stopReason: AssistantMessage["stopReason"] = "pending",
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "test",
  model: "test",
  stopReason,
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

test("atomic mid-stream snapshots reconcile final messages without duplicate rows", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "parent", timestamp: 0 }];
  const channel = new TranscriptChannel(() => messages, 1);
  const partial = assistant("hello");
  channel.accept({ type: "message_start", message: partial });
  const updates: TranscriptSnapshot[] = [];
  const observation = channel.observe((snapshot) => updates.push(snapshot));
  assert.equal(observation.snapshot.assistant?.role, "assistant");
  assert.equal(observation.snapshot.inheritedCount, 1);
  assert.equal(observation.snapshot.messages.length, 1);
  partial.content = [{ type: "text", text: "mutated by SDK" }];
  assert.deepEqual((observation.snapshot.assistant as AssistantMessage).content, [
    { type: "text", text: "hello" },
  ]);
  assert.throws(() => (observation.snapshot.messages as AgentMessage[]).push(assistant("bad")));
  const final = assistant("hello world", "stop");
  messages.push(final);
  channel.accept({ type: "message_end", message: final });
  assert.equal(updates.at(-1)?.assistant, null);
  assert.equal(updates.at(-1)?.messages.length, 2);
  assert.ok(updates.at(-1)!.revision > observation.snapshot.revision);
  observation.unsubscribe();
  const count = updates.length;
  channel.accept({ type: "agent_settled" });
  assert.equal(updates.length, count);
  channel.dispose();
  assert.throws(() => channel.observe(() => {}), /disposed/);
});

test("parallel tools retain arguments and partial/final output until committed", () => {
  const messages: AgentMessage[] = [];
  const channel = new TranscriptChannel(() => messages, 0);
  channel.accept({
    type: "tool_execution_start",
    toolCallId: "a",
    toolName: "read",
    args: { path: "a" },
  });
  channel.accept({
    type: "tool_execution_start",
    toolCallId: "b",
    toolName: "read",
    args: { path: "b" },
  });
  channel.accept({
    type: "tool_execution_update",
    toolCallId: "a",
    toolName: "read",
    args: { path: "a" },
    partialResult: { content: [{ type: "text", text: "partial" }] },
  });
  const observation = channel.observe(() => {});
  assert.equal(observation.snapshot.tools.length, 2);
  assert.deepEqual(observation.snapshot.tools[0]?.result, {
    content: [{ type: "text", text: "partial" }],
  });
  channel.accept({
    type: "tool_execution_end",
    toolCallId: "a",
    toolName: "read",
    result: { content: [{ type: "text", text: "failed" }] },
    isError: true,
  });
  let latest = channel.observe(() => {}).snapshot;
  assert.equal(latest.tools[0]?.isError, true);
  assert.equal(latest.tools[0]?.state, "completed");
  const result: AgentMessage = {
    role: "toolResult",
    toolCallId: "a",
    toolName: "read",
    content: [{ type: "text", text: "failed" }],
    isError: true,
    timestamp: 1,
  };
  messages.push(result);
  channel.accept({ type: "message_end", message: result });
  latest = channel.observe(() => {}).snapshot;
  assert.deepEqual(
    latest.tools.map((tool) => tool.toolCallId),
    ["b"],
  );
  assert.equal(latest.messages.length, 1);
  channel.accept({ type: "agent_settled" });
  assert.equal(channel.observe(() => {}).snapshot.tools.length, 0);
  channel.dispose();
});

test("compaction reconciles replaced history and clears obsolete inherited prefix", () => {
  let messages: AgentMessage[] = [{ role: "user", content: "parent", timestamp: 0 }];
  const channel = new TranscriptChannel(() => messages, 1);
  messages = [{ role: "user", content: "compacted", timestamp: 1 }];
  channel.accept({
    type: "compaction_end",
    reason: "manual",
    result: { summary: "compacted", firstKeptEntryId: "id", tokensBefore: 1 },
    aborted: false,
    willRetry: false,
  });
  const snapshot = channel.observe(() => {}).snapshot;
  assert.equal(snapshot.inheritedCount, 0);
  assert.deepEqual(snapshot.messages, messages);
  channel.dispose();
});

test("broken renderers and noncloneable custom results never fail execution", () => {
  const channel = new TranscriptChannel(() => [], 0);
  channel.observe(() => {
    throw new Error("renderer failed");
  });
  assert.doesNotThrow(() =>
    channel.accept({ type: "tool_execution_start", toolCallId: "a", toolName: "custom", args: {} }),
  );
  assert.doesNotThrow(() =>
    channel.accept({
      type: "tool_execution_end",
      toolCallId: "a",
      toolName: "custom",
      result: { callback() {} },
      isError: false,
    }),
  );
  assert.ok(channel.observe(() => {}).snapshot.error);
  channel.dispose();
});

test("aborted compaction preserves inherited context and completed nested tools are bounded", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "parent", timestamp: 0 }];
  const channel = new TranscriptChannel(() => messages, 1);
  channel.accept({
    type: "compaction_end",
    reason: "manual",
    result: undefined,
    aborted: true,
    willRetry: false,
  });
  assert.equal(channel.observe(() => {}).snapshot.inheritedCount, 1);
  for (let i = 0; i < 200; i++) {
    channel.accept({
      type: "tool_execution_end",
      toolCallId: `nested/${i}`,
      parentToolCallId: "parent",
      toolName: "read",
      result: {},
      isError: false,
    });
  }
  assert.equal(channel.observe(() => {}).snapshot.tools.length, 128);
  channel.dispose();
});

test("duplicate listener registrations have independent unsubscribe handles", () => {
  const channel = new TranscriptChannel(() => [], 0);
  let calls = 0;
  const listener = () => calls++;
  const first = channel.observe(listener);
  const second = channel.observe(listener);
  channel.accept({ type: "agent_settled" });
  assert.equal(calls, 2);
  first.unsubscribe();
  channel.accept({ type: "agent_settled" });
  assert.equal(calls, 3);
  second.unsubscribe();
  channel.accept({ type: "agent_settled" });
  assert.equal(calls, 3);
  channel.dispose();
});

