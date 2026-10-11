import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, rgbColor } from "@earendil-works/pi-tui";
import { AGENT_COLORS } from "../src/prefs/config.ts";
import piSubagent from "../src/index.ts";
import { DEFAULT_MANAGER_SETTINGS, loadManagerSettings } from "../src/prefs/settings.ts";
import { subagentPrompt } from "../src/orch/prompt.ts";
import { IMPORT_REQUEST_PREFIX, importWasOffered, markImportOffered } from "../src/prefs/agent-import.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

async function withCommands(
  body: (fixture: {
    command: any;
    ctx: ExtensionCommandContext;
    hooks: Map<string, Function>;
    renders: string[][];
    replies: (string | undefined)[];
    cwd: string;
    notifications: string[];
    tools: Map<string, any>;
    widgets: unknown[];
  }) => Promise<void>,
  options: { initialMode?: "off" | "orchestration" } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-command-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  if (options.initialMode) {
    mkdirSync(join(cwd, "subagent-manager"), { recursive: true });
    writeFileSync(join(cwd, "subagent-manager", "settings.json"), JSON.stringify({ subagentMode: options.initialMode }));
  } else markImportOffered(cwd); // Enabled command tests do not scan external agent directories.
  const sessionManager = SessionManager.inMemory(cwd);
  const hooks = new Map<string, Function>();
  const renders: string[][] = [];
  const replies: (string | undefined)[] = [];
  const notifications: string[] = [];
  const widgets: unknown[] = [];
  const driver = createDialogDriver({
    theme: {
      fg: (_token: string, text: string) => text,
      colors: Object.fromEntries(AGENT_COLORS.map((color) => [color, rgbColor(238, 238, 238)])),
      style: (text: string) => text,
    } as unknown as Theme,
    width: 100,
    choices: replies,
    unified: true,
    onOpen(options) {
      assert.equal((options as { overlay?: boolean } | undefined)?.overlay, true);
    },
    onFrame(_component, lines) {
      renders.push(lines);
    },
  });
  let command: any;
  const tools = new Map<string, any>();
  const pi = {
    getCommands: () => [],
    events: { emit() {} },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand: (name: string, definition: any) => {
      assert.equal(name, "agents");
      command = definition;
    },
    on: (name: string, handler: Function) => hooks.set(name, handler),
    appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    sessionManager,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => false,
    ui: {
      theme: driver.theme,
      setStatus() {},
      setWidget(_key: string, widget: unknown) { widgets.push(widget); },
      notify: (text: string) => notifications.push(text),
      custom: driver.custom,
    },
  } as unknown as ExtensionCommandContext;
  try {
    piSubagent(pi);
    await hooks.get("session_start")!({}, ctx);
    await body({ command, ctx, hooks, renders, replies, cwd, notifications, tools, widgets });
  } finally {
    await hooks.get("session_shutdown")?.({}, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(cwd, { recursive: true, force: true });
  }
}

const SUBCOMMANDS = ["tree", "settings", "types", "import", "reload", "reap"].map((value) => ({
  value,
  label: value,
}));

function seedThreads(ctx: ExtensionCommandContext, paths: string[]) {
  (ctx.sessionManager as SessionManager).appendCustomEntry("pi-subagent:registry:v1", {
    version: 1,
    rootSessionId: ctx.sessionManager.getSessionId(),
    threads: paths.map((path) => ({
      view: {
        path,
        parent: path.slice(0, path.lastIndexOf("/")),
        owner: path,
        type: "worker",
        state: "completed",
        task: "task",
        status: "done",
        createdAt: 1,
      },
      definition: { name: "worker", description: "test", systemPrompt: "child prompt" },
      inherited: [],
    })),
  });
}

test("agents command defaults to settings and saved settings persist and reach the system prompt", async () => {
  await withCommands(async ({ command, ctx, hooks, renders, replies, cwd }) => {
    replies.push("maxLevels", "5", "modelSelection", "pick-first-available", "save");
    await command.handler("", ctx);
    assert.match(renders[0]!.join("\n"), /Agents settings/);
    const { settings } = loadManagerSettings({ cwd, agentDir: cwd, includeProject: false });
    assert.equal(settings.maxLevels, 5);
    assert.equal(settings.modelSelection, "pick-first-available");
    const result = await hooks.get("before_agent_start")!(
      { prompt: "User request", systemPrompt: "Main" },
      ctx,
    );
    assert.equal(result.systemPrompt, `Main\n\n${subagentPrompt(settings)}`);
  });
});

test("root turn lifecycle collapses the settled preview without losing the agent tree", async () => {
  await withCommands(async ({ command, ctx, hooks, widgets, renders }) => {
    await hooks.get("agent_start")!({}, ctx);
    seedThreads(ctx, ["/root/done"]);
    await hooks.get("session_tree")!({}, ctx);
    const preview = () => {
      if (widgets.at(-1) === undefined) return [];
      const component = (widgets.at(-1) as Function)({ requestRender() {} });
      const lines = component.render(100) as string[];
      component.dispose();
      return lines;
    };
    assert.match(preview().join("\n"), /Agents[\s\S]*\/root\/done/);
    await hooks.get("agent_end")!({}, ctx);
    assert.equal(preview().length, 1);
    assert.match(preview()[0]!, /0 running, 1 completed/);

    await command.handler("tree", ctx);
    assert.ok(renders.some((lines) => lines.join("\n").includes("/root/done")));
    assert.equal(preview().length, 1);

    await hooks.get("agent_start")!({}, ctx);
    assert.deepEqual(preview(), [], "new tasks do not display retained completions");
    await command.handler("tree", ctx);
    assert.ok(renders.at(-1)!.join("\n").includes("/root/done"));
    assert.deepEqual(preview(), [], "manual inspection does not revive agents");
    await hooks.get("agent_end")!({}, ctx);
    assert.deepEqual(preview(), []);
    await hooks.get("session_tree")!({}, ctx);
    assert.deepEqual(preview(), [], "tree rebuilds do not revive hidden agents");
    // A replacement session must not inherit the previous root turn's UI state.
    await hooks.get("session_start")!({ reason: "resume" }, ctx);
    assert.match(preview().join("\n"), /Agents/);
  });
});

test("off startup is silent: no onboarding, visible widget, or tool exposure", async () => {
  await withCommands(async ({ hooks, ctx, tools, renders, notifications, widgets, cwd }) => {
    assert.equal(importWasOffered(cwd), false);
    assert.deepEqual(renders, []);
    assert.deepEqual(notifications, []);
    assert.ok(widgets.every((widget) => widget === undefined));
    assert.ok([...tools.values()].every((tool) => tool.exposure === "hidden"));
    assert.equal(await hooks.get("before_agent_start")!({ systemPrompt: "Main", prompt: "Task" }, ctx), undefined);
  }, { initialMode: "off" });
});

test("orchestration skips first-run import and explains the mode required for manual import", async () => {
  await withCommands(async ({ command, ctx, renders, notifications, cwd }) => {
    assert.equal(importWasOffered(cwd), false);
    assert.deepEqual(renders, []);
    await command.handler("import", ctx);
    assert.deepEqual(renders, []);
    assert.match(notifications.at(-1)!, /Agent import requires Opportunistic mode/);
  }, { initialMode: "orchestration" });
});

test("saving mode changes updates tools and prompt immediately", async () => {
  await withCommands(async ({ command, ctx, hooks, replies, tools, cwd }) => {
    for (const mode of ["off", "orchestration", "opportunistic"] as const) {
      replies.push("subagentMode", mode, "save");
      await command.handler("settings", ctx);
      for (const tool of tools.values())
        assert.equal(tool.exposure, mode === "off" ? "hidden" : "direct");
      const event = await hooks.get("before_agent_start")!({ systemPrompt: "Main", prompt: "Work" }, ctx);
      if (mode === "off") assert.equal(event, undefined);
      else assert.equal(event.systemPrompt, `Main\n\n${subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode: mode })}`);
      assert.equal(loadManagerSettings({ cwd, agentDir: cwd, includeProject: false }).settings.subagentMode, mode);
    }
  });
});

test("off does not acknowledge migration or inject guidance", async () => {
  await withCommands(async ({ command, ctx, hooks, replies, cwd }) => {
    replies.push("subagentMode", "off", "save");
    await command.handler("settings", ctx);
    rmSync(join(cwd, "subagent-manager", ".import-offered"));
    assert.equal(await hooks.get("before_agent_start")!({ systemPrompt: "Main", prompt: `${IMPORT_REQUEST_PREFIX}manual request` }, ctx), undefined);
    assert.equal(importWasOffered(cwd), false);
  });
});

test("dialog subcommands decline RPC mode without opening a dialog", async () => {
  await withCommands(async ({ command, ctx, renders, notifications }) => {
    (ctx as { mode: string }).mode = "rpc";
    for (const args of ["", "settings", "tree"]) await command.handler(args, ctx);
    assert.equal(notifications.filter((text) => text.includes("TUI mode")).length, 3);
    await command.handler("import", ctx);
    assert.match(notifications.at(-1)!, /Agent import requires TUI mode/);
    assert.equal(renders.length, 0);
  });
});

test("only an accepted migration turn acknowledges first-run onboarding", async () => {
  await withCommands(async ({ hooks, ctx, cwd }) => {
    rmSync(join(cwd, "subagent-manager", ".import-offered"));
    const start = (prompt: string) =>
      hooks.get("before_agent_start")!({ prompt, systemPrompt: "Main" }, ctx);
    await start("Ordinary request");
    assert.equal(importWasOffered(cwd), false);
    await start(`${IMPORT_REQUEST_PREFIX}\nMigration data`);
    assert.equal(importWasOffered(cwd), true);
  });
});

test("subcommand completions are fuzzy and unknown subcommands report usage", async () => {
  await withCommands(async ({ command, ctx, notifications }) => {
    const complete = (prefix: string) => command.getArgumentCompletions(prefix);
    assert.deepEqual(complete(""), SUBCOMMANDS);
    assert.deepEqual(complete("   "), SUBCOMMANDS);
    assert.equal(complete("sta"), null);
    assert.deepEqual(complete("TyPeS"), [{ value: "types", label: "types" }]);
    assert.deepEqual(complete("   tpe"), [{ value: "types", label: "types" }]);
    for (const prefix of ["thread", "status ", "types foo", "settings 5", "tree /missing"])
      assert.equal(complete(prefix), null, prefix);
    await command.handler("nope", ctx);
    assert.match(notifications.at(-1)!, /tree/);
    assert.doesNotMatch(notifications.at(-1)!, /status/);
    assert.doesNotMatch(notifications.at(-1)!, /thread/);
    await command.handler("thread /root/alpha", ctx);
    assert.match(notifications.at(-1)!, /Usage:.*tree/);
  });
});

test("tree opens overlays and status is rejected, and tree completes thread paths", async () => {
  await withCommands(async ({ command, ctx, hooks, renders, notifications }) => {
    seedThreads(ctx, ["/root/alpha", "/root/zeta"]);
    await hooks.get("session_tree")!({}, ctx);
    const alpha = [{ value: "tree /root/alpha", label: "/root/alpha" }];
    assert.deepEqual(command.getArgumentCompletions("tree "), [
      ...alpha,
      { value: "tree /root/zeta", label: "/root/zeta" },
    ]);
    assert.deepEqual(command.getArgumentCompletions("  TREE /root/al"), alpha);
    assert.deepEqual(command.getArgumentCompletions("tree alpha"), alpha);
    assert.deepEqual(command.getArgumentCompletions("tree"), [{ value: "tree", label: "tree" }]);

    await command.handler("status", ctx);
    assert.match(notifications.at(-1)!, /Usage:/);
    assert.equal(renders.length, 0);
    notifications.length = 0;
    await command.handler("tree", ctx);
    assert.match(renders.at(-1)!.join("\n"), /Agents tree/);
    await command.handler("tree /root/zeta", ctx);
    assert.ok(renders.at(-1)!.some((line) => /›.*\/root\/zeta/.test(line)));
    assert.doesNotMatch(notifications.at(-1) ?? "", /Usage:/);
  });
});

test("CombinedAutocompleteProvider completes /agents then its subcommands", async () => {
  await withCommands(async ({ command, ctx, hooks, cwd }) => {
    seedThreads(ctx, ["/root/alpha"]);
    await hooks.get("session_tree")!({}, ctx);
    const provider = new CombinedAutocompleteProvider(
      [
        {
          name: "agents",
          description: command.description,
          getArgumentCompletions: (prefix: string) => command.getArgumentCompletions(prefix),
        },
      ],
      cwd,
      null,
    );
    const signal = new AbortController().signal;
    const apply = async (line: string, value: string) => {
      const suggestions = await provider.getSuggestions([line], 0, line.length, { signal });
      const item = suggestions?.items.find((entry) => entry.value === value);
      assert.ok(item, `missing completion ${value} for ${JSON.stringify(line)}`);
      return provider.applyCompletion([line], 0, line.length, item, suggestions!.prefix).lines[0];
    };

    assert.equal(await apply("/ag", "agents"), "/agents ");
    const subcommands = await provider.getSuggestions(["/agents "], 0, 8, { signal });
    assert.deepEqual(
      subcommands?.items.map((item) => item.value),
      SUBCOMMANDS.map((item) => item.value),
    );
    assert.equal(await apply("/agents  tr", "tree"), "/agents tree");
    assert.equal(
      await apply("/agents  tree /root/al", "tree /root/alpha"),
      "/agents tree /root/alpha",
    );
  });
});

test("saving widget mode refreshes immediately and reload reads the persisted choice", async () => {
  await withCommands(async ({ command, ctx, hooks, replies, cwd, widgets }) => {
    seedThreads(ctx, ["/root/alpha", "/root/zeta"]);
    await hooks.get("session_tree")!({}, ctx);
    const renderWidget = () => {
      const factory = widgets.at(-1) as (tui: { requestRender(): void }) => {
        render(width: number): string[];
        dispose(): void;
      };
      assert.equal(typeof factory, "function");
      const widget = factory({ requestRender() {} });
      try {
        return widget.render(100);
      } finally {
        widget.dispose();
      }
    };
    assert.ok(renderWidget().length > 1, "Full is the default");
    for (const mode of ["minimal", "full"] as const) {
      const before = widgets.length;
      replies.push("widgetMode", mode, "save");
      await command.handler("settings", ctx);
      assert.ok(widgets.length > before, "Save and apply refreshes the widget");
      const lines = renderWidget();
      if (mode === "minimal") {
        assert.equal(lines.length, 1);
        assert.match(lines[0]!, /0 running.*2 completed.*↑0.*↓0/);
        assert.doesNotMatch(lines.join("\n"), /Press ←/);
      } else assert.ok(lines.length > 1);
      assert.equal(loadManagerSettings({ cwd, agentDir: cwd, includeProject: false }).settings.widgetMode, mode);
    }
    const { settings } = loadManagerSettings({ cwd, agentDir: cwd, includeProject: false });
    writeFileSync(join(cwd, "subagent-manager", "settings.json"), JSON.stringify({ ...settings, widgetMode: "minimal" }));
    await command.handler("reload", ctx);
    assert.equal(renderWidget().length, 1, "Reload applies a choice changed on disk");
    await hooks.get("session_tree")!({}, ctx);
    assert.equal(renderWidget().length, 1, "Session attachment reloads the choice");
  });
});

test("agents reap persists removals, refreshes the widget, and completes by name", async () => {
  await withCommands(async ({ command, ctx, hooks, notifications, widgets, replies, renders }) => {
    seedThreads(ctx, ["/root/old", "/root/old/child"]);
    await hooks.get("session_tree")!({}, ctx);
    assert.deepEqual(command.getArgumentCompletions("reap"), [{ value: "reap", label: "reap" }]);
    const before = widgets.length;
    replies.push("confirm");
    await command.handler("reap", ctx);
    assert.match(notifications.at(-1)!, /Reaped 2 completed agent/);
    assert.match(renders.flat().join("\n"), /2 completed agents will be reaped/);
    assert.match(renders.flat().join("\n"), /You will not be able to resume them anymore/);
    assert.ok(widgets.length > before);
    assert.equal(command.getArgumentCompletions("tree /root/old"), null);
    await hooks.get("session_tree")!({}, ctx);
    await command.handler("reap", ctx);
    assert.match(notifications.at(-1)!, /No completed agents eligible/);
  });
});

test("agents reap cancel and dismiss preserve completed sessions", async () => {
  await withCommands(async ({ command, ctx, hooks, replies, renders, notifications }) => {
    seedThreads(ctx, ["/root/old"]);
    await hooks.get("session_tree")!({}, ctx);
    for (const reply of ["cancel", undefined]) {
      replies.push(reply);
      await command.handler("reap", ctx);
      assert.match(renders.flat().join("\n"), /1 completed agent will be reaped/);
      assert.deepEqual(command.getArgumentCompletions("tree /root/old"), [
        { value: "tree /root/old", label: "/root/old" },
      ]);
      assert.equal(notifications.some((message) => message.startsWith("Reaped")), false);
      await hooks.get("session_tree")!({}, ctx);
    }
  });
});

test("agents reap without completed agents opens no confirmation", async () => {
  await withCommands(async ({ command, ctx, notifications, renders }) => {
    await command.handler("reap", ctx);
    assert.match(notifications.at(-1)!, /No completed agents eligible/);
    assert.equal(renders.length, 0);
  });
});

test("agents reap refuses to bypass confirmation outside the TUI", async () => {
  await withCommands(async ({ command, ctx, hooks, renders }) => {
    seedThreads(ctx, ["/root/old"]);
    await hooks.get("session_tree")!({}, ctx);
    ctx.mode = "rpc";
    await command.handler("reap", ctx);
    assert.equal(renders.length, 0);
    assert.ok(command.getArgumentCompletions("tree /root/old"));
  });
});

