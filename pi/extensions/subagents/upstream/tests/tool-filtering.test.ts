import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

const answer = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const worker =
  "---\nname: worker\ndescription: Tool filtering worker\ntools:\n  allow: [read, agent_update]\n  block: [read, agent_update]\n---\nDo the work.\n";

test(
  "Tool Filtering reload configures new child sessions but preserves live retained sessions",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: { worker },
        managerSettings: { toolFiltering: "allowed" },
        onRequest: answer,
      },
      async ({ directory, cwd, open, tool, requests, errors }) => {
        const session = await open(SessionManager.create(cwd));
        const spawn = (path: string) =>
          tool<ThreadView>(session, "agent_spawn", { path, type: "worker", task: "Work" });
        assert.equal((await spawn("strict")).state, "completed");
        assert.deepEqual(requests.at(-1)!.toolNames, []);
        const rootTools = session.getActiveToolNames();
        const reload = async (toolFiltering: "allowed" | "all-except-blocked" | "all") => {
          await writeFile(
            join(directory, "subagent-manager", "settings.json"),
            JSON.stringify({ toolFiltering }),
          );
          await session.prompt("/agents reload");
          assert.deepEqual(
            session.getActiveToolNames(),
            rootTools,
            "child filtering does not change root tools",
          );
        };
        await reload("all-except-blocked");
        assert.equal((await spawn("except")).state, "completed");
        const exceptTools = requests.at(-1)!.toolNames;
        assert.ok(exceptTools.includes("bash"));
        assert.ok(exceptTools.includes("agent_spawn"));
        assert.ok(exceptTools.includes("agent_wait"));
        assert.ok(!exceptTools.includes("read"));
        assert.ok(!exceptTools.includes("agent_update"));
        await reload("all");
        assert.equal((await spawn("wide")).state, "completed");
        const allTools = requests.at(-1)!.toolNames;
        assert.ok(allTools.includes("read"));
        assert.ok(allTools.includes("agent_update"));
        assert.deepEqual([...allTools].sort(), [...exceptTools, "read", "agent_update"].sort());
        await tool(session, "agent_steer", { path: "strict", message: "Continue" });
        assert.equal(
          (await tool<ThreadView>(session, "agent_wait", { path: "strict" })).state,
          "completed",
        );
        assert.deepEqual(
          requests.at(-1)!.toolNames,
          [],
          "retained strict session keeps its startup set",
        );
        await reload("allowed");
        await tool(session, "agent_steer", { path: "wide", message: "Continue" });
        assert.equal(
          (await tool<ThreadView>(session, "agent_wait", { path: "wide" })).state,
          "completed",
        );
        assert.deepEqual(
          requests.at(-1)!.toolNames,
          allTools,
          "retained broad session keeps its startup set",
        );
        assert.equal((await spawn("strict-again")).state, "completed");
        assert.deepEqual(requests.at(-1)!.toolNames, []);
        assert.deepEqual(errors, []);
      },
    );
  },
);

