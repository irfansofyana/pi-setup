import assert from "node:assert/strict";
import test from "node:test";

import { AUTO_CAPTURE_TYPE } from "./auto-capture.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { createManagedSkillsExtension } from "./extension.ts";

type Handler = (event: any, context: any) => Promise<any> | any;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: Array<{ message: any; options: any }> = [];
  return {
    handlers,
    tools,
    commands,
    sent,
    api: {
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      sendMessage(message: any, options: any) {
        sent.push({ message: { ...message, role: "custom", timestamp: Date.now() }, options });
      },
    },
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/example",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { notify() {}, confirm: async () => true },
    reload: async () => undefined,
    ...overrides,
  };
}

test("runtime registers configured tools and passes effective discovery limit", async () => {
  const pi = fakePi();
  let discoveryLimit = 0;
  createManagedSkillsExtension({
    readConfig: () => ({ config: { ...DEFAULT_CONFIG, maxSkillBytes: 80_000 } }),
    discoverSkills: async (_root, maxBytes) => {
      discoveryLimit = maxBytes;
      return [];
    },
  })(pi.api as any);

  assert.deepEqual([...pi.tools.keys()].sort(), ["learn", "manage_skill"]);
  await pi.handlers.get("resources_discover")?.({}, context());
  assert.equal(discoveryLimit, 80_000);
});

test("prompt guidance omits learn when the tool is disabled", async () => {
  const pi = fakePi();
  createManagedSkillsExtension({
    readConfig: () => ({ config: { ...DEFAULT_CONFIG, learnEnabled: false, autoCapture: true } }),
  })(pi.api as any);

  const result = await pi.handlers.get("before_agent_start")?.({ systemPrompt: "base", systemPromptOptions: { skills: [] } }, context());
  assert.doesNotMatch(result.systemPrompt, /call `learn`/);
  assert.match(result.systemPrompt, /`manage_skill`/);
  assert.deepEqual([...pi.tools.keys()], ["manage_skill"]);
});

test("authored skill collisions reject both create and update", async () => {
  const pi = fakePi();
  let writes = 0;
  createManagedSkillsExtension({
    readConfig: () => ({ config: DEFAULT_CONFIG }),
    writeSkill: async () => {
      writes += 1;
      return { name: "authored", path: "/tmp/authored/SKILL.md" };
    },
  })(pi.api as any);
  await pi.handlers.get("before_agent_start")?.({
    systemPrompt: "base",
    systemPromptOptions: { skills: [{ name: "authored", filePath: "/tmp/user-skills/authored/SKILL.md" }] },
  }, context());

  const tool = pi.tools.get("manage_skill");
  for (const action of ["create", "update"]) {
    const result = await tool.execute("call", { action, name: "authored", description: "d", body: "body" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /authored skill/);
  }
  assert.equal(writes, 0);
});

test("capture dispatch waits for settled idle and suppresses its own chain", async () => {
  const pi = fakePi();
  createManagedSkillsExtension({
    readConfig: () => ({ config: { ...DEFAULT_CONFIG, autoContinue: true, minToolCalls: 2 } }),
  })(pi.api as any);
  const ctx = context();

  await pi.handlers.get("agent_start")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("agent_end")?.({ messages: [] }, ctx);
  assert.equal(pi.sent.length, 0);

  await pi.handlers.get("agent_settled")?.({}, context({ hasPendingMessages: () => true }));
  assert.equal(pi.sent.length, 0);
  await pi.handlers.get("agent_settled")?.({}, ctx);
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.role, "custom");
  assert.equal(pi.sent[0].message.customType, AUTO_CAPTURE_TYPE);
  assert.deepEqual(pi.sent[0].options, { deliverAs: "followUp", triggerTurn: true });

  await pi.handlers.get("agent_end")?.({ messages: [{ role: "custom", customType: AUTO_CAPTURE_TYPE }] }, ctx);
  await pi.handlers.get("agent_end")?.({ messages: [] }, ctx);
  await pi.handlers.get("agent_settled")?.({}, ctx);
  assert.equal(pi.sent.length, 1);
});

test("managed list uses the configured byte limit", async () => {
  const pi = fakePi();
  let listLimit = 0;
  createManagedSkillsExtension({
    readConfig: () => ({ config: { ...DEFAULT_CONFIG, maxSkillBytes: 72_000 } }),
    listSkills: async (_root, maxBytes) => {
      listLimit = maxBytes;
      return [];
    },
  })(pi.api as any);

  await pi.tools.get("manage_skill").execute("call", { action: "list" });
  assert.equal(listLimit, 72_000);
});

test("invalid config fails closed and status surfaces its diagnostic", async () => {
  const pi = fakePi();
  const notices: Array<{ message: string; level?: string }> = [];
  createManagedSkillsExtension({
    readConfig: () => ({
      config: { ...DEFAULT_CONFIG, enabled: false, learnEnabled: false, autoCapture: false, autoContinue: false },
      diagnostic: "Invalid managed-skills config: expected JSON object",
    }),
  })(pi.api as any);

  assert.deepEqual([...pi.tools.keys()], []);
  await pi.commands.get("managed-skills").handler("status", context({
    ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
  }));
  assert.equal(notices[0].level, "warning");
  assert.match(notices[0].message, /expected JSON object/);
});

test("learn reports the partial outcome when skill persistence fails", async () => {
  const pi = fakePi();
  createManagedSkillsExtension({
    readConfig: () => ({ config: DEFAULT_CONFIG }),
    retainLesson: async () => ({ bankId: "coding-agent" }),
    writeSkill: async () => { throw new Error("disk full"); },
  })(pi.api as any);

  await assert.rejects(() => pi.tools.get("learn").execute(
    "call",
    {
      memory: "durable lesson",
      skill: { action: "create", name: "demo", description: "d", body: "body" },
    },
    undefined,
    undefined,
    context(),
  ), /Lesson queued for Hindsight \(coding-agent\), but the managed skill could not be written: disk full/);
});

test("queued user work after a capture marker remains eligible", async () => {
  const pi = fakePi();
  createManagedSkillsExtension({
    readConfig: () => ({ config: { ...DEFAULT_CONFIG, autoContinue: true, minToolCalls: 2 } }),
  })(pi.api as any);
  const ctx = context();

  await pi.handlers.get("agent_start")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("agent_end")?.({ messages: [] }, ctx);
  await pi.handlers.get("agent_settled")?.({}, ctx);
  assert.equal(pi.sent.length, 1);

  await pi.handlers.get("agent_start")?.({}, ctx);
  await pi.handlers.get("message_start")?.({ message: { role: "custom", customType: AUTO_CAPTURE_TYPE } }, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("message_start")?.({ message: { role: "user", content: "queued work" } }, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("agent_end")?.({
    messages: [{ role: "custom", customType: AUTO_CAPTURE_TYPE }, { role: "user", content: "queued work" }],
  }, ctx);
  await pi.handlers.get("agent_settled")?.({}, ctx);

  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[1].message.details.toolCalls, 2);
});

test("post-capture user work remains active across continuation agent_start events", async () => {
  const pi = fakePi();
  createManagedSkillsExtension({
    readConfig: () => ({ config: { ...DEFAULT_CONFIG, autoContinue: true, minToolCalls: 2 } }),
  })(pi.api as any);
  const ctx = context();

  await pi.handlers.get("agent_start")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("agent_end")?.({ messages: [] }, ctx);
  await pi.handlers.get("agent_settled")?.({}, ctx);
  assert.equal(pi.sent.length, 1);

  await pi.handlers.get("agent_start")?.({}, ctx);
  await pi.handlers.get("message_start")?.({ message: { role: "custom", customType: AUTO_CAPTURE_TYPE } }, ctx);
  await pi.handlers.get("message_start")?.({ message: { role: "user", content: "queued work" } }, ctx);
  await pi.handlers.get("agent_end")?.({
    messages: [{ role: "custom", customType: AUTO_CAPTURE_TYPE }, { role: "user", content: "queued work" }],
  }, ctx);

  await pi.handlers.get("agent_start")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("tool_execution_end")?.({}, ctx);
  await pi.handlers.get("agent_end")?.({ messages: [] }, ctx);
  await pi.handlers.get("agent_settled")?.({}, ctx);

  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[1].message.details.toolCalls, 2);
});
