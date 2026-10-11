import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalPath, inheritContext, isDescendant, parentPath } from "../src/orch/paths.ts";

test("canonical ancestry is structural, not prefix matching or URL normalization", () => {
  assert.equal(
    canonicalPath("coding-researcher", "/root/worker"),
    "/root/worker/coding-researcher",
  );
  assert.equal(parentPath("/a/b/c"), "/a/b");
  assert.equal(parentPath("/k"), null);
  assert.equal(isDescendant("/root/ab", "/root/a"), false);
  for (const path of [
    "",
    "/root/../worker",
    "/root//worker",
    "/root/worker/",
    "/root/%61",
    " /root/a",
    "/root/a?b",
    "/root/a\\b",
  ])
    assert.throws(() => canonicalPath(path));
});

test("context snapshots strip unfinished/orphaned tool exchanges and clone messages", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
  const assistant = (text: string, calls: [string, string][], stopReason = "toolUse") =>
    ({
      role: "assistant",
      content: [
        { type: "text", text },
        ...calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
      ],
      api: "openai-responses",
      provider: "openai",
      model: "model",
      usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason,
      timestamp: 1,
    }) as AgentMessage;
  const result = (toolCallId: string, text: string) =>
    ({
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    }) as AgentMessage;
  const messages = [
    { role: "system", content: "parent prompt", timestamp: 1 },
    { role: "user", content: "parent context", timestamp: 1 },
    { role: "custom", customType: "note", content: "keep custom", display: false, timestamp: 1 },
    { role: "bashExecution", command: "echo", output: "keep shell", exitCode: 0, timestamp: 1 },
    assistant("Checking", [
      ["repeat", "read"],
      ["pending", "agent_spawn"],
    ]),
    result("repeat", "first result"),
    result("repeat", "duplicate orphan result"),
    result("orphan", ""),
    assistant("Retrying", [["repeat", "read"]]),
    result("repeat", "second result"),
    assistant("Still waiting", [["repeat", "read"]]),
    assistant("Broken", [["ignored", "read"]], "error"),
    result("ignored", "ignored result"),
  ] as unknown as AgentMessage[];

  const inherited = inheritContext(messages) as any[];
  const summary = inherited.map((message) =>
    message.role === "assistant"
      ? [message.stopReason, ...message.content.map((block: any) => block.id ?? block.text)]
      : message.role === "toolResult"
        ? message.content[0].text
        : message.role,
  );
  assert.deepEqual(summary, [
    "user",
    "custom",
    "bashExecution",
    ["toolUse", "Checking", "repeat"],
    "first result",
    ["toolUse", "Retrying", "repeat"],
    "second result",
    ["stop", "Still waiting"],
  ]);
  inherited[1].content = "child mutation";
  inherited[3].content[0].text = "changed";
  assert.equal((messages[2] as any).content, "keep custom");
  assert.equal((messages[4] as any).content[0].text, "Checking");
});

