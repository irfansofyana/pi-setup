import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRegistry } from "./registry.ts";
import { createDialogDriver } from "./upstream/tests/helpers/dialogDriver.ts";
import { ImportPicker } from "./upstream/src/ui/import-picker.ts";

test("setup defaults use minimal widget without creating settings", async t => {
  const f = await fixture(t, []);
  assert.equal(f.ui.settings.widgetMode, "minimal");
  await assert.rejects(access(join(f.root, "subagent-manager", "settings.json")));
});

const theme: any = { fg: (_color: string, text: string) => text, colors: new Proxy({}, { get: () => ({ kind: "rgb", r: 0, g: 170, b: 0 }) }), style: (text: string) => text };
async function fixture(t: any, choices: (string | undefined)[]) {
  const module = await import("./manager-ui.ts").catch(() => undefined);
  assert.equal(typeof module?.createManagerUI, "function", "upstream UI bridge is available");
  const root = await mkdtemp(join(tmpdir(), "manager-ui-")); t.after(() => rm(root, { recursive: true, force: true }));
  const driver = createDialogDriver({ theme, choices, unified: true });
  const notices: string[] = [], applied: any[] = [];
  const ctx: any = { cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => false,
    ui: { custom: driver.custom, notify: (text: string) => notices.push(text), setWidget() {}, setStatus() {} }, modelRegistry: { getAvailable: () => [] } };
  const store = createAgentRegistry({ cwd: root, agentDir: root, includeProject: false });
  const ui = module!.createManagerUI({ agentDir: root, cwd: root, store, caps: { concurrency: 1, threads: 4, levels: 2 }, apply: (settings: any) => applied.push(settings) });
  return { root, driver, notices, applied, ctx, store, ui };
}

test("actual upstream settings dialog saves widget preferences in the selected profile", async t => {
  const f = await fixture(t, ["widgetMode", "minimal", "save"]);
  assert.equal(await f.ui.command("settings", f.ctx), true);
  const saved = JSON.parse(await readFile(join(f.root, "subagent-manager", "settings.json"), "utf8"));
  assert.equal(saved.widgetMode, "minimal"); assert.equal(saved.maxConcurrent, 1);
  assert.equal(f.applied.at(-1).widgetMode, "minimal"); assert.equal(f.driver.stats.outerOpens, 1);
});

test("unsupported settings fail before saving rather than claiming to apply", async t => {
  const f = await fixture(t, ["maxConcurrent", "2", "save", "cancel"]);
  await f.ui.command("settings", f.ctx);
  await assert.rejects(access(join(f.root, "subagent-manager", "settings.json")));
  assert.equal(f.applied.length, 0); assert.ok(f.notices.some(text => /deployment|ceiling/.test(text)));
});

test("actual upstream type editor creates a custom agent in the user profile", async t => {
  const f = await fixture(t, ["Create new type", "name", "worker", "systemPrompt", "Bounded general work", "Save", "Global", undefined]);
  await f.ui.command("types", f.ctx);
  assert.equal(f.store.get("worker").systemPrompt.trim(), "Bounded general work");
  assert.equal(f.store.get("worker").source, "user");
  assert.match(await readFile(join(f.root, "subagent-manager", "agents", "worker.md"), "utf8"), /name: worker/);
});

test("reload refreshes definitions while retained type snapshots stay detached", async t => {
  const f = await fixture(t, []), old = f.store.get("scout");
  f.store.save({ name: "worker", description: "Custom", systemPrompt: "bounded" }, "user");
  assert.equal(await f.ui.command("reload", f.ctx), true);
  assert.equal(f.store.get("worker").name, "worker"); assert.equal(old.name, "scout");
  assert.equal(await f.ui.command("not-a-command", f.ctx), false);
});

test("bulk reaping requires confirmation and passes only the confirmed candidate snapshot", async t => {
  const f=await fixture(t,["cancel","confirm"]), reaped:string[][]=[];
  const module=await import("./manager-ui.ts");
  const ui=module.createManagerUI({agentDir:f.root,cwd:f.root,store:f.store,caps:{concurrency:1,threads:4,levels:2},apply(){},
    reap:{candidates:()=>["/root/completed"],async close(paths:string[]){reaped.push(paths);return paths;}}}as any);
  await ui.command("reap",f.ctx);assert.deepEqual(reaped,[]);
  await ui.command("reap",f.ctx);assert.deepEqual(reaped,[["/root/completed"]]);
});

test("import uses the actual checkbox picker and asks the parent to migrate only selected private-profile definitions", async t => {
  const f = await fixture(t, []), sent: { text: string; delivery: unknown }[] = [];
  const external = await mkdtemp(join(tmpdir(), "unselected-import-"));
  const previous = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
  process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = external;
  t.after(async()=>{if(previous===undefined)delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS=previous;await rm(external,{recursive:true,force:true});});
  await writeFile(join(external,"outside.md"),"---\nname: outside\ndescription: Inherited external profile\n---\nDo not scan this inherited directory.\n");
  await mkdir(join(f.root, "agents"));
  await writeFile(join(f.root, "agents", "legacy.md"), "---\nname: legacy\ndescription: Prior role\n---\nRead selected files only.\n");
  f.driver.onChild = component => {
    if (!(component instanceof ImportPicker)) return false;
    component.handleInput("\x01"); component.handleInput("\r"); return true;
  };
  const { createManagerUI } = await import("./manager-ui.ts");
  const ui = createManagerUI({ agentDir: f.root, cwd: f.root, store: f.store,
    caps: { concurrency: 1, threads: 4, levels: 2 }, apply() {}, importHomeDir: f.root,
    pi: { sendUserMessage(text: string, delivery: unknown) { sent.push({ text, delivery }); } } as any } as any);
  assert.equal(await ui.command("import", f.ctx), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Import ONLY the agents I selected/);
  assert.match(sent[0].text, /legacy\.md/);
  assert.doesNotMatch(sent[0].text, /outside\.md/,"private previews ignore inherited extra-directory environment configuration");
  assert.match(sent[0].text, /Reviewed setup capabilities/);
  assert.deepEqual(sent[0].delivery, { deliverAs: "followUp" });
  assert.match(await readFile(join(f.root, "agents", "legacy.md"), "utf8"), /Read selected files only/);
  await assert.rejects(access(join(f.root, "subagent-manager", "agents", "legacy.md")));
});

test("import cancels without starting a parent turn or writing definitions", async t => {
  const f = await fixture(t, []), sent: string[] = [];
  await mkdir(join(f.root, "agents"));
  await writeFile(join(f.root, "agents", "legacy.md"), "---\nname: legacy\n---\nRead only\n");
  f.driver.onChild = component => {
    if (!(component instanceof ImportPicker)) return false;
    component.handleInput("\x1b"); return true;
  };
  const { createManagerUI } = await import("./manager-ui.ts");
  const ui = createManagerUI({ agentDir: f.root, cwd: f.root, store: f.store,
    caps: { concurrency: 1, threads: 4, levels: 2 }, apply() {}, importHomeDir: f.root,
    pi: { sendUserMessage(text: string) { sent.push(text); } } as any } as any);
  assert.equal(await ui.command("import", f.ctx), true);
  assert.deepEqual(sent, []);
  await assert.rejects(access(join(f.root, "subagent-manager", "agents", "legacy.md")));
});
