import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { auditMcpConfigs, BrowserController, CONNECTION_NOTICE, MCP_VERSION, SERVER_NAME, SETUP_PROMPT, TOOL_PREFIX, serverConfig, type BrowserHost } from "./controller.ts";
import { registerBrowser } from "./extension.ts";
import { BrowserPreferences } from "./preferences.ts";

function host() {
  const registrations: Array<{ name: string; config: unknown }> = [];
  const removals: string[] = [];
  const tools: Array<{ name: string; exposure?: string }> = [];
  const active = new Map<string, unknown>();
  const api: BrowserHost = {
    register: (name, config) => { registrations.push({ name, config }); active.set(name, config); },
    unregister: (name) => { removals.push(name); active.delete(name); },
    tools: () => tools,
    servers: () => [...active].map(([name, config]) => ({ name, config })),
  };
  return { api, registrations, removals, tools, active };
}

async function configFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agent);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  return { agent, cwd, personal: join(agent, "mcp.json"), project: join(cwd, ".pi", "mcp.json") };
}

test("pinned autoConnect config never launches/copies a profile or enables telemetry", () => {
  const config = serverConfig("darwin");
  assert.equal(config.command, "npx");
  assert.deepEqual(config.args, ["-y", `chrome-devtools-mcp@${MCP_VERSION}`, "--autoConnect", "--no-usage-statistics", "--no-performance-crux"]);
  assert.equal(MCP_VERSION, "1.11.0");
  assert.equal(config.exposure, "codemode");
  assert.match(CONNECTION_NOTICE, /tab closing, network inspection, performance and emulation/);
  assert.equal(config.toolExposure, undefined, "standard tools including close_page must not be filtered");
  assert.ok(!config.args?.some((arg) => /category|slim|exclude/i.test(arg)), "keep the pinned server's standard tool inventory");
  assert.doesNotMatch(JSON.stringify(config), /--user-data-dir|--isolated|--headless|--browser-url|--executable-path|@latest/);
  assert.deepEqual(serverConfig("win32").args?.slice(0, 4), ["/d", "/s", "/c", "npx"]);
  assert.equal(serverConfig("win32").command, "cmd.exe");
});

test("audit accepts absent/unrelated files and disabled separate browser entries", async (t) => {
  const f = await configFixture(t);
  await auditMcpConfigs(f.agent, f.cwd);
  await writeFile(f.personal, JSON.stringify({ unknown: true, mcpServers: { other: { command: "other" }, chrome: { command: "npx", args: ["chrome-devtools-mcp@latest"], enabled: false } } }));
  await auditMcpConfigs(f.agent, f.cwd);
});

test("project override re-enabling personal Chrome blocks before confirmation", async (t) => {
  const f = await configFixture(t);
  await writeFile(f.personal, JSON.stringify({ mcpServers: { chrome: { command: "npx", args: ["chrome-devtools-mcp@1.11.0"], enabled: false } } }));
  await writeFile(f.project, JSON.stringify({ mcpServers: { chrome: { enabled: true } } }));
  const h = host();
  let confirmations = 0;
  const b = new BrowserController(h.api, (cwd) => auditMcpConfigs(f.agent, cwd), "linux");
  await assert.rejects(b.connect(f.cwd, async () => { confirmations++; return true; }), /Existing Chrome DevTools MCP/);
  assert.equal(confirmations, 0);
  assert.equal(h.registrations.length, 0);
});

test("project re-enablement introduced during consent blocks registration", async (t) => {
  const f = await configFixture(t);
  await writeFile(f.personal, JSON.stringify({ mcpServers: { chrome: { command: "npx", args: ["chrome-devtools-mcp@1.11.0"], enabled: false } } }));
  const h = host();
  const b = new BrowserController(h.api, (cwd) => auditMcpConfigs(f.agent, cwd), "linux");
  await assert.rejects(b.connect(f.cwd, async () => {
    await writeFile(f.project, JSON.stringify({ mcpServers: { chrome: { enabled: true, exposure: "codemode" } } }));
    return true;
  }), /Existing Chrome DevTools MCP/);
  assert.equal(h.registrations.length, 0);
});

test("partial exposure override does not enable Chrome; project disabling cannot hide a personal conflict", async (t) => {
  const f = await configFixture(t);
  const chrome = { command: "npx", args: ["chrome-devtools-mcp@1.11.0"], enabled: false };
  await writeFile(f.personal, JSON.stringify({ mcpServers: { chrome } }));
  await writeFile(f.project, JSON.stringify({ mcpServers: { chrome: { exposure: "direct" } } }));
  await auditMcpConfigs(f.agent, f.cwd);
  await writeFile(f.project, JSON.stringify({ mcpServers: { chrome: { command: "other", enabled: true } } }));
  await auditMcpConfigs(f.agent, f.cwd);
  await writeFile(f.personal, JSON.stringify({ mcpServers: { chrome: { ...chrome, enabled: true } } }));
  await writeFile(f.project, JSON.stringify({ mcpServers: { chrome: { enabled: false } } }));
  await assert.rejects(auditMcpConfigs(f.agent, f.cwd), /personal MCP configuration/);
});

test("audit blocks duplicates and normalized reserved overrides without leaking config", async (t) => {
  const f = await configFixture(t);
  for (const entry of [
    { chrome: { command: "npx", args: ["chrome-devtools-mcp@1.11.0"] } },
    { chrome: { command: "/bin/chrome-devtools-mcp" } },
    { [SERVER_NAME]: { enabled: false } },
    { pi_setup_browser: { exposure: "hidden" } },
  ]) {
    await writeFile(f.project, JSON.stringify({ mcpServers: entry, private: "test-sensitive-marker" }));
    await assert.rejects(auditMcpConfigs(f.agent, f.cwd), (error: Error) => {
      assert.doesNotMatch(error.message, /test-sensitive-marker/);
      assert.match(error.message, /project/);
      return true;
    });
  }
});

test("audit fails closed on malformed or unreadable configuration", async (t) => {
  const f = await configFixture(t);
  for (const source of ["{bad", "[]", '{"mcpServers":null}', '{"mcpServers":[]}']) {
    await writeFile(f.personal, source);
    await assert.rejects(auditMcpConfigs(f.agent, f.cwd), /parse|Invalid/);
  }
  await rm(f.personal);
  await mkdir(f.personal);
  await assert.rejects(auditMcpConfigs(f.agent, f.cwd), /Cannot audit/);
});

test("lifecycle is explicit, session-only and never confuses discovery with attachment", async () => {
  const h = host();
  let audits = 0;
  const b = new BrowserController(h.api, async () => { audits++; }, "linux");
  assert.equal(b.status().state, "inactive");
  assert.equal(h.registrations.length, 0);
  await b.connect("/project", async () => true);
  assert.equal(audits, 2);
  assert.equal(b.status().state, "registered");
  h.tools.push({ name: `${TOOL_PREFIX}list_pages` }, { name: `${TOOL_PREFIX}close_page`, exposure: "hidden" }, { name: "mcp__other__read" });
  assert.equal(b.status().state, "tools_available");
  assert.equal(b.status().availableToolCount, 1);
  assert.equal(b.status().browserAttachment, "unverified");
  assert.match(b.status().profile, /not independently verified/);
  await assert.rejects(b.connect("/project", async () => true), /already registered/);
  b.disconnect(); b.disconnect();
  assert.deepEqual(h.removals, [SERVER_NAME]);
  assert.equal(b.status().state, "inactive");
  assert.equal(b.status().availableToolCount, 0);
});

test("stateful registry clears reserved registration across disconnect and reconnect", async () => {
  const h = host();
  const b = new BrowserController(h.api, async () => {}, "linux");
  await b.connect("/project", async () => true);
  assert.equal(h.api.servers()[0].name, SERVER_NAME);
  b.disconnect();
  assert.equal(h.api.servers().length, 0);
  await b.connect("/project", async () => true);
  assert.equal(h.active.size, 1);
  assert.equal(h.registrations.length, 2);
  b.disconnect();
  assert.equal(h.active.size, 0);
});

test("denied consent does not register; connection can be retried", async () => {
  const h = host();
  const b = new BrowserController(h.api, async () => {}, "linux");
  await assert.rejects(b.connect("/project", async () => false), /cancelled/);
  assert.equal(h.registrations.length, 0);
  assert.equal(b.status().state, "inactive");
  await b.connect("/project", async () => true);
  assert.equal(h.registrations.length, 1);
});

test("concurrent connection and shutdown during dialog cannot register late", async () => {
  const h = host();
  const b = new BrowserController(h.api, async () => {}, "linux");
  let release!: (approved: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => { release = resolve; });
  let dialogStarted = false;
  const first = b.connect("/project", () => { dialogStarted = true; return confirmation; });
  assert.equal(b.status().state, "connection_pending");
  await assert.rejects(b.connect("/project", async () => true), /pending/);
  assert.equal(dialogStarted, true);
  b.disconnect();
  release(true);
  await assert.rejects(first, /lifecycle change/);
  assert.equal(h.registrations.length, 0);
  assert.equal(b.status().state, "inactive");
});

test("drift introduced during confirmation fails before registration", async (t) => {
  const f = await configFixture(t);
  const h = host();
  const b = new BrowserController(h.api, (cwd) => auditMcpConfigs(f.agent, cwd), "linux");
  await assert.rejects(b.connect(f.cwd, async () => {
    await writeFile(f.personal, JSON.stringify({ mcpServers: { [SERVER_NAME]: { enabled: false } } }));
    return true;
  }), /Reserved/);
  assert.equal(h.registrations.length, 0);
});

test("registered extension browser sources also block duplicates", async () => {
  const h = host();
  h.api.servers = () => [{ name: "custom-chrome", config: { command: "npx", args: ["chrome-devtools-mcp@latest"] } }];
  const b = new BrowserController(h.api, async () => {}, "linux");
  await assert.rejects(b.connect("/project", async () => true), /extension MCP registry/);
  assert.equal(h.registrations.length, 0);
});

test("native failures are sanitized and failed removal does not report disconnected", async () => {
  const h = host();
  const b = new BrowserController(h.api, async () => {}, "linux");
  h.api.register = () => { throw new Error("test-sensitive-marker"); };
  await assert.rejects(b.connect("/project", async () => true), { message: "Native MCP registration failed. Inspect /mcp; no browser identity was verified." });
  assert.equal(b.status().state, "inactive");
  h.api.register = () => {};
  await b.connect("/project", async () => true);
  h.api.unregister = () => { throw new Error("test-sensitive-marker"); };
  assert.throws(() => b.disconnect(), /do not assume browser access has ended/);
  assert.equal(b.status().state, "registered");
  h.api.unregister = (name) => { h.removals.push(name); };
  b.disconnect();
  assert.equal(b.status().state, "inactive");
  assert.deepEqual(h.removals, [SERVER_NAME]);
});

test("shutdown during initial audit never reads the disposed registry", async () => {
  const h = host();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let registryReads = 0;
  h.api.servers = () => { registryReads++; throw new Error("disposed registry"); };
  const b = new BrowserController(h.api, () => gate, "linux");
  const connection = b.connect("/project", async () => true);
  b.disconnect(); release();
  await assert.rejects(connection, /lifecycle change/);
  assert.equal(registryReads, 0);
  assert.equal(h.registrations.length, 0);
});

test("shutdown during second audit stops before registry access or registration", async () => {
  const h = host();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let audits = 0, registryReads = 0;
  h.api.servers = () => { registryReads++; return []; };
  const b = new BrowserController(h.api, async () => {
    if (++audits === 2) { entered(); await gate; }
  }, "linux");
  const connection = b.connect("/project", async () => true);
  await started;
  b.disconnect(); release();
  await assert.rejects(connection, /lifecycle change/);
  assert.equal(registryReads, 1);
  assert.equal(h.registrations.length, 0);
});

test("registry drift during confirmation blocks duplicate and retry remains possible", async () => {
  const h = host();
  let conflict = false;
  h.api.servers = () => conflict ? [{ name: "another", config: { command: "chrome-devtools-mcp" } }] : [];
  const b = new BrowserController(h.api, async () => {}, "linux");
  await assert.rejects(b.connect("/project", async () => { conflict = true; return true; }), /extension MCP registry/);
  assert.equal(h.registrations.length, 0);
  conflict = false;
  await b.connect("/project", async () => true);
  b.disconnect();
  await b.connect("/project", async () => true);
  assert.equal(h.registrations.length, 2);
  assert.equal(h.removals.length, 1);
});

test("only an explicit boolean approval can register", async () => {
  const h = host();
  const b = new BrowserController(h.api, async () => {}, "linux");
  for (const result of [undefined, null, "yes", "false", 1]) {
    await assert.rejects(b.connect("/project", async () => result as never), /cancelled/);
  }
  assert.equal(h.registrations.length, 0);
  await b.connect("/project", async () => true);
  assert.equal(h.registrations.length, 1);
});

function extensionFixture(agent: string, cwd: string) {
  const h = host();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => void | Promise<void>>();
  const messages: unknown[] = [];
  const notices: string[] = [];
  let hasUI = true, idle = true, approved = true, confirmations = 0;
  let confirmationError: Error | undefined;
  let confirmationHook: (() => Promise<boolean>) | undefined;
  const api = {
    registerMcpServer: h.api.register,
    unregisterMcpServer: h.api.unregister,
    getAllTools: h.api.tools,
    getMcpServers: h.api.servers,
    registerCommand: (name: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, definition),
    registerTool: (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(definition.name, definition),
    on: (name: string, handler: (event?: unknown, ctx?: unknown) => void | Promise<void>) => events.set(name, handler),
    sendUserMessage: (message: string) => messages.push(message),
  };
  const ctx = {
    cwd,
    get hasUI() { return hasUI; },
    isIdle: () => idle,
    ui: { notify: (text: string) => notices.push(text), confirm: async () => { confirmations++; if (confirmationError) throw confirmationError; return confirmationHook ? await confirmationHook() : approved; } },
  };
  registerBrowser(api as unknown as ExtensionAPI, () => agent);
  const command = (action: string) => commands.get("browser")!.handler(action, ctx as unknown as ExtensionCommandContext);
  return { ...h, commands, tools, events, messages, notices, command,
    start: () => events.get("session_start")!({}, ctx),
    setUI: (value: boolean) => { hasUI = value; },
    setIdle: (value: boolean) => { idle = value; },
    setApproved: (value: boolean) => { approved = value; },
    setConfirmationError: (error: Error | undefined) => { confirmationError = error; },
    setConfirmationHook: (hook: () => Promise<boolean>) => { confirmationHook = hook; },
    confirmations: () => confirmations,
  };
}

test("extension load/status/setup do not connect or mutate config; only status custom tool", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  assert.equal(e.registrations.length, 0);
  assert.deepEqual([...e.tools.keys()], ["browser_status"]);
  assert.equal(e.tools.get("browser_status")!.exposure, "codemode");
  await e.command("status");
  await e.command("setup");
  assert.deepEqual(e.messages, [SETUP_PROMPT]);
  assert.match(SETUP_PROMPT, /read-only/);
  assert.match(SETUP_PROMPT, /Do not connect/);
  assert.equal(e.registrations.length, 0);
  assert.equal(e.confirmations(), 0);
});

test("status tool remains read-only and unexpected confirmation errors are sanitized", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  const status = await e.tools.get("browser_status")!.execute("test-status", {}, undefined, undefined, {} as never);
  assert.match(JSON.stringify(status.content), /inactive/);
  assert.equal(e.confirmations(), 0);
  assert.equal(e.registrations.length, 0);
  e.setConfirmationError(new Error("test-sensitive-marker"));
  await e.command("enable");
  assert.match(e.notices.at(-1)!, /Browser lifecycle operation failed/);
  assert.doesNotMatch(e.notices.join("\n"), /test-sensitive-marker/);
  assert.equal(e.registrations.length, 0);
  e.setConfirmationError(undefined);
  await e.command("enable");
  assert.equal(e.registrations.length, 1);
});

test("extension shutdown during consent prevents late registration", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  let entered!: () => void, approve!: (value: boolean) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const approval = new Promise<boolean>((resolve) => { approve = resolve; });
  e.setConfirmationHook(() => { entered(); return approval; });
  const connection = e.command("enable");
  await started;
  e.events.get("session_shutdown")!();
  approve(true);
  await connection;
  assert.equal(e.registrations.length, 0);
  assert.equal(e.active.size, 0);
  assert.ok(!e.notices.some((notice) => /registered for this session|Remembered access enabled/.test(notice)), "disposed contexts must not report success");
});

test("only four commands are advertised and removed arguments never change access", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  const completions = await e.commands.get("browser")!.getArgumentCompletions!("");
  assert.deepEqual(completions?.map((item) => item.value), ["setup", "enable", "disable", "status"]);
  for (const argument of ["connect", "disconnect"]) {
    await e.command(argument);
    assert.match(e.notices.at(-1)!, /command was removed.*No changes made/);
  }
  assert.equal(e.confirmations(), 0);
  assert.equal(e.registrations.length, 0);
  assert.equal((await new BrowserPreferences(f.agent).read()).exists, false);
  await e.command("enable");
  for (const argument of ["connect", "disconnect"]) await e.command(argument);
  assert.equal(e.registrations.length, 1);
  assert.equal(e.removals.length, 0);
  assert.equal((await new BrowserPreferences(f.agent).read()).enabled, true);
});

test("fresh session startup stays off and never creates preferences", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  await e.start();
  assert.equal(e.registrations.length, 0);
  assert.equal(e.confirmations(), 0);
  await assert.rejects(access(new BrowserPreferences(f.agent).directory), { code: "ENOENT" });
});

test("remembered opt-in enrolls once and restores tools in another session without Pi confirmation", async (t) => {
  const f = await configFixture(t);
  const first = extensionFixture(f.agent, f.cwd);
  await first.command("enable");
  assert.equal(first.confirmations(), 1);
  assert.equal(first.registrations.length, 1);
  const store = new BrowserPreferences(f.agent);
  assert.equal((await store.read()).enabled, true);
  first.events.get("session_shutdown")!();
  const next = extensionFixture(f.agent, f.cwd);
  await next.start();
  assert.equal(next.confirmations(), 0);
  assert.equal(next.registrations.length, 1);
  next.events.get("session_shutdown")!();
  assert.equal(next.active.size, 0);
  assert.equal((await store.read()).enabled, true, "session shutdown retains remembered opt-in");
  const resumed = extensionFixture(f.agent, f.cwd);
  await resumed.start();
  assert.equal(resumed.registrations.length, 1);
  await resumed.command("disable");
  assert.equal(resumed.active.size, 0);
  assert.equal((await store.read()).enabled, false);
  const disabled = extensionFixture(f.agent, f.cwd);
  await disabled.start();
  assert.equal(disabled.registrations.length, 0);
});

test("enable is idempotent and never duplicates an existing registration", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  await e.command("enable");
  assert.equal(e.registrations.length, 1);
  assert.equal(e.confirmations(), 1);
  await e.command("enable");
  assert.equal(e.registrations.length, 1);
  assert.equal(e.confirmations(), 1, "idempotent enable reuses approved preference");
});

test("remembered startup blocks duplicates and stays off in noninteractive sessions", async (t) => {
  const f = await configFixture(t);
  const store = new BrowserPreferences(f.agent);
  await store.setEnabled(await store.read(), true);
  await writeFile(f.personal, JSON.stringify({ mcpServers: { chrome: { command: "chrome-devtools-mcp" } } }));
  const e = extensionFixture(f.agent, f.cwd);
  await e.start();
  assert.equal(e.registrations.length, 0);
  assert.equal(e.confirmations(), 0);
  assert.match(e.notices.at(-1)!, /startup blocked.*Existing Chrome DevTools MCP/);
  assert.equal((await store.read()).enabled, true);
  await rm(f.personal);
  const unattended = extensionFixture(f.agent, f.cwd);
  unattended.setUI(false);
  await unattended.start();
  assert.equal(unattended.registrations.length, 0);
  await unattended.command("status");
  assert.match(unattended.notices.at(-1)!, /interactive_required/);
});

test("denied or interrupted enrollment writes no preference and starts no server", async (t) => {
  const f = await configFixture(t);
  const denied = extensionFixture(f.agent, f.cwd);
  denied.setApproved(false);
  await denied.command("enable");
  assert.equal((await new BrowserPreferences(f.agent).read()).exists, false);
  assert.equal(denied.registrations.length, 0);
  const e = extensionFixture(f.agent, f.cwd);
  let entered!: () => void, approve!: (value: boolean) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const approval = new Promise<boolean>((resolve) => { approve = resolve; });
  e.setConfirmationHook(() => { entered(); return approval; });
  const enabling = e.command("enable");
  await started;
  e.events.get("session_shutdown")!();
  approve(true); await enabling;
  assert.equal((await new BrowserPreferences(f.agent).read()).exists, false);
  assert.equal(e.registrations.length, 0);
});

test("preference drift during enrollment is preserved rather than overwritten", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  const store = new BrowserPreferences(f.agent);
  const external = '{"enabled":false,"custom":"external"}';
  e.setConfirmationHook(async () => { await mkdir(store.directory); await writeFile(store.path, external); return true; });
  await e.command("enable");
  assert.equal(await readFile(store.path, "utf8"), external);
  assert.equal(e.registrations.length, 0);
  assert.match(e.notices.at(-1)!, /changed since review/);
});

test("startup cancellation cannot register late; invalid settings do not expose contents", async (t) => {
  const f = await configFixture(t);
  const store = new BrowserPreferences(f.agent);
  await store.setEnabled(await store.read(), true);
  const e = extensionFixture(f.agent, f.cwd);
  const starting = e.start();
  e.events.get("session_shutdown")!();
  await starting;
  assert.equal(e.registrations.length, 0);
  const bad = extensionFixture(f.agent, f.cwd);
  await bad.start();
  assert.equal(bad.registrations.length, 1);
  const malformed = '{"private":"test-sensitive-marker",';
  await writeFile(store.path, malformed);
  await bad.command("status");
  assert.doesNotMatch(bad.notices.join("\n"), /test-sensitive-marker/);
  await bad.command("enable");
  assert.equal(bad.registrations.length, 1, "invalid preferences must not create another registration");
  const blocked = extensionFixture(f.agent, f.cwd);
  await blocked.start();
  assert.equal(blocked.registrations.length, 0);
  await bad.command("disable");
  assert.equal(bad.active.size, 0);
  assert.equal(await readFile(store.path, "utf8"), malformed);
  assert.match(bad.notices.at(-1)!, /Current session registration removed/);
});

test("project preference files cannot enable global remembered access", async (t) => {
  const f = await configFixture(t);
  const projectStore = new BrowserPreferences(join(f.cwd, ".pi"));
  await projectStore.setEnabled(await projectStore.read(), true);
  const e = extensionFixture(f.agent, f.cwd);
  await e.start();
  assert.equal(e.registrations.length, 0);
  assert.equal((await new BrowserPreferences(f.agent).read()).exists, false);
});

test("disable failure still pauses current session and does not claim global revocation", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  await e.command("enable");
  const store = new BrowserPreferences(f.agent);
  await mkdir(join(store.directory, ".config.lock"));
  await e.command("disable");
  assert.equal(e.active.size, 0);
  assert.equal((await store.read()).enabled, true);
  assert.match(e.notices.at(-1)!, /Current session registration removed.*busy or locked/);
  assert.doesNotMatch(e.notices.at(-1)!, /Remembered access disabled/);
});

test("enrollment source conflicts are audited before saving remembered consent", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  e.active.set("another-browser", { command: "chrome-devtools-mcp" });
  await e.command("enable");
  assert.equal(e.confirmations(), 0);
  assert.equal(e.registrations.length, 0);
  assert.equal((await new BrowserPreferences(f.agent).read()).exists, false);
});

test("status exposes only preference metadata, never unknown config values", async (t) => {
  const f = await configFixture(t);
  const store = new BrowserPreferences(f.agent);
  await mkdir(store.directory);
  await writeFile(store.path, JSON.stringify({ enabled: true, custom: { value: "test-sensitive-marker" } }));
  const e = extensionFixture(f.agent, f.cwd);
  const result = await e.tools.get("browser_status")!.execute("status", {}, undefined, undefined, {} as never);
  assert.doesNotMatch(JSON.stringify(result), /test-sensitive-marker|\"custom\"|\"raw\"/);
  assert.match(JSON.stringify(result), /rememberedAccess/);
  assert.equal(e.registrations.length, 0);
});

test("unsupported hosts remain inert and explain native lifecycle requirement", async () => {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const notices: string[] = [];
  const api = {
    registerCommand: (_name: string, definition: typeof command) => { command = definition; },
    registerTool: () => {}, on: () => {}, getAllTools: () => [],
  };
  registerBrowser(api as unknown as ExtensionAPI, () => { throw new Error("must not inspect config"); });
  await command.handler("enable", { ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext);
  assert.match(notices.at(-1)!, /lacks native MCP/);
});

test("commands require idle interactive opt-in and clean up only owned server", async (t) => {
  const f = await configFixture(t);
  const e = extensionFixture(f.agent, f.cwd);
  e.setUI(false); await e.command("enable");
  assert.match(e.notices.at(-1)!, /interactive confirmation/);
  e.setUI(true); e.setIdle(false); await e.command("enable");
  assert.match(e.notices.at(-1)!, /current run/);
  e.setIdle(true); e.setApproved(false); await e.command("enable");
  assert.equal(e.registrations.length, 0);
  e.setApproved(true); await e.command("enable");
  assert.equal(e.registrations.length, 1);
  await e.command("disable");
  e.events.get("session_shutdown")!();
  assert.deepEqual(e.removals, [SERVER_NAME]);
  await e.command("not-an-action");
  assert.match(e.notices.at(-1)!, /Usage:/);
});
