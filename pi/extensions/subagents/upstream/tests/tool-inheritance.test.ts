import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  createCodemodeExtension,
  createToolSearchExtension,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

function reply(name?: string, args: JsonObject = {}): AssistantMessage {
  return {
    role: "assistant",
    content: name
      ? [{ type: "toolCall", id: `call-${name}`, name, arguments: args }]
      : [{ type: "text", text: "done" }],
    provider: "integration-test", model: "offline", api: "openai-completions",
    stopReason: name ? "toolUse" : "stop", timestamp: Date.now(),
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

for (const mode of ["all", "all-except-blocked", "allowed"] as const) {
  test(`root extension/MCP tools and child-local codemode honor ${mode}`, { timeout: 30000 }, async () => {
    const calls: string[] = [];
    const checkedByRoot: string[] = [];
    let preparationCount = 0;
    let spawnSignal: AbortSignal | undefined;
    const external: ExtensionFactory = (pi) => {
      for (const [name, exposure] of [
        ["extension_echo", "direct"],
        ["mcp__test__lookup", "deferred"],
        ["mcp__test__blocked", "codemode"],
        ["mcp__test__denied", "deferred"],
        ["hidden_secret", "hidden"],
      ] as const) {
        pi.registerTool({
          name, label: name, description: `Test ${name}`, exposure,
          namespace: name.startsWith("mcp__") ? { name: "mcp__test", instructions: "Test namespace instructions" } : undefined,
          annotations: { readOnlyHint: true },
          parameters: Type.Object({ value: Type.Optional(Type.String()) }),
          outputSchema: Type.Object({ name: Type.String(), value: Type.String(), isError: Type.Optional(Type.Boolean()) }),
          prepareArguments: name === "extension_echo" ? (args) => {
            preparationCount++;
            const value = args as { value: string };
            return { ...value, value: `${value.value}-prepared` };
          } : undefined,
          async execute(_id, args, signal) {
            assert.ok(signal && !signal.aborted, "bridge uses child signal");
            assert.notEqual(signal, spawnSignal, "bridge does not reuse spawning call's signal");
            calls.push(name);
            if (args.value === "structured-error") return {
              content: [{ type: "text", text: "Lookup failed" }], details: {}, isError: true,
              structuredContent: { name, value: "structured-error", isError: true },
            };
            return {
              content: [{ type: "text", text: name }], details: {},
              structuredContent: { name, value: args.value ?? "ok", isError: false },
            };
          },
        });
      }
      pi.on("tool_call", (event, ctx) => {
        if (event.toolName === "agent_spawn") spawnSignal = ctx.signal;
        if (event.toolName.startsWith("mcp__") || event.toolName === "extension_echo") {
          checkedByRoot.push(event.toolName);
          if (event.toolName === "mcp__test__denied") return { block: true, reason: "Root permission denied" };
        }
      });
    };
    const broad = mode !== "allowed";
    const script = `
const names = ALL_TOOLS.map(t => t.name);
if (names.includes("hidden_secret")) throw new Error("hidden tool leaked");
if (names.includes("mcp__test__blocked") !== ${mode === "all"}) throw new Error("block policy leaked");
if (names.includes("mcp__test__lookup") !== ${broad}) throw new Error("allow policy leaked");
const echo = await tools.extension_echo({value: "child-value"});
if (echo.value !== "child-value-prepared") throw new Error("structured result or argument preparation lost");
${broad ? `
const namespace = describeNamespace("mcp__test");
text(namespace);
text(searchTools("lookup"));
const found = await tools.mcp__test__lookup({value: "lookup-value"});
if (found.value !== "lookup-value") throw new Error("MCP call failed");
const error = await tools.mcp__test__lookup({value: "structured-error"});
if (!error.isError || error.value !== "structured-error") throw new Error("structured error lost");
let denied = false;
try { await tools.mcp__test__denied({}); } catch (e) { denied = String(e).includes("Root permission denied"); }
if (!denied) throw new Error("root permission hook bypassed");` : ""}
text("CHILD_TOOL_PARITY_OK");`;
    await withOfflineHarness({
      managerSettings: { toolFiltering: mode },
      agentFiles: { worker: "---\nname: worker\ndescription: Tool inheritance\ntools:\n  allow: [codemode, extension_echo]\n  block: [mcp__test__blocked]\n---\nTest tools.\n" },
      extensionFactories: [external, createCodemodeExtension(), createToolSearchExtension()],
      onRequest(request) {
        if (!request.path) return request.pathCall === 1
          ? reply("agent_spawn", { path: "probe", type: "worker", task: "Test", wait: true }) : reply();
        if (request.pathCall === 1) {
          assert.ok(request.toolNames.includes("codemode"));
          assert.ok(request.toolNames.includes("extension_echo"));
          assert.ok(!request.toolNames.includes("mcp__test__lookup"), "deferred tools stay out of model declarations");
          assert.ok(!request.toolNames.includes("hidden_secret"));
          return reply("codemode", { code: script });
        }
        assert.match(request.messagesText, /CHILD_TOOL_PARITY_OK/);
        assert.doesNotMatch(request.messagesText, /"isError":true/);
        return reply();
      },
    }, async ({ cwd, open, requests, errors }) => {
      const session = await open(SessionManager.create(cwd));
      session.setActiveToolsByName([...session.getActiveToolNames(), "codemode", "tool_search"]);
      await session.prompt("Check child tool inheritance");
      assert.ok(requests.some((request) => request.path === "/root/probe" && request.pathCall === 2));
      assert.equal(preparationCount, 1);
      assert.deepEqual(calls, broad ? ["extension_echo", "mcp__test__lookup", "mcp__test__lookup"] : ["extension_echo"]);
      assert.deepEqual(checkedByRoot, broad ? ["extension_echo", "mcp__test__lookup", "mcp__test__lookup", "mcp__test__denied"] : ["extension_echo"]);
      assert.deepEqual(errors, []);
    });
  });
}

test("detached children and grandchildren inherit tools while unsafe model-only forwarding fails closed", { timeout: 30000 }, async () => {
  const seen: string[] = [];
  await withOfflineHarness({
    managerSettings: { toolFiltering: "all" },
    agentFiles: { worker: "---\nname: worker\ndescription: Detached tool inheritance\n---\nTest tools.\n" },
    extensionFactories: [
      createCodemodeExtension(),
      (pi) => {
        pi.registerTool({
          name: "external_ping", label: "Ping", description: "Inherited direct tool",
          parameters: Type.Object({}),
          async execute() {
            seen.push("ping");
            return { content: [{ type: "text", text: "PING_OK" }], details: {} };
          },
        });
        pi.registerTool({
          name: "model_only_context", label: "Context", description: "Check local context",
          exposure: "model-only", parameters: Type.Object({}),
          async execute() {
            assert.fail("Model-only root implementation must never bypass permission hooks");
          },
        });
      },
    ],
    onRequest(request) {
      if (!request.path) return request.pathCall === 1
        ? reply("agent_spawn", { path: "detached", type: "worker", task: "Test", wait: false }) : reply();
      assert.ok(request.toolNames.includes("model_only_context"));
      if (request.path === "/root/detached") {
        if (request.pathCall === 1) return reply("agent_spawn", { path: "nested", type: "worker", task: "Test", wait: true });
        assert.match(request.messagesText, /"path":"\/root\/detached\/nested"/);
        return reply();
      }
      if (request.pathCall === 1) return reply("external_ping");
      if (request.pathCall === 2) {
        assert.match(request.messagesText, /PING_OK/);
        return reply("model_only_context");
      }
      if (request.pathCall === 3) {
        assert.match(request.messagesText, /Cannot safely inherit model-only tool model_only_context/);
        return reply("agent_update", { message: "grandchild-local-update" });
      }
      assert.match(request.messagesText, /"path":"\/root\/detached\/nested"/);
      return reply();
    },
  }, async ({ cwd, open, tool, errors }) => {
    const session = await open(SessionManager.create(cwd));
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode", "model_only_context"]);
    await session.prompt("Check detached inheritance");
    const result = await tool<{ state: string }>(session, "agent_wait", { path: "detached", timeoutMs: 5000 });
    assert.equal(result.state, "completed");
    assert.deepEqual(seen, ["ping"]);
    assert.deepEqual(errors, []);
  });
});

