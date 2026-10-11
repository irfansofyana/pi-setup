import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MANAGER_SETTINGS } from "./upstream/src/prefs/settings.ts";
import { CostFooterController } from "./upstream/src/ui/cost-footer.ts";

test("event cost mode falls back to a status key without replacing the integrated Signature footer",()=>{
  const statuses=new Map<string,unknown>(),events:any[]=[];let replaced=0;
  const controller=new CostFooterController({getCommands:()=>[],events:{emit:(name:string,payload:unknown)=>events.push({name,payload})}}as any,
    ()=>0.125,()=>false,()=>"pi-footer-event","status");
  const ctx:any={hasUI:true,mode:"tui",ui:{setStatus:(key:string,value:unknown)=>statuses.set(key,value),setFooter:()=>{replaced++;}}};
  controller.refresh(ctx);
  assert.equal(events[0].payload.value,"$0.1250");assert.equal(statuses.get("subagent_cost"),"$0.1250");assert.equal(replaced,0);
  controller.clear();controller.reset(ctx);
  assert.equal(statuses.get("subagent_cost"),undefined);assert.equal(replaced,0);
});

test("upstream fleet widgets use cooperative shortcuts without replacing the theme editor", async () => {
  const module = await import("./manager-presentation.ts").catch(() => undefined);
  assert.equal(typeof module?.createManagerPresentation, "function");
  const settings = { ...DEFAULT_MANAGER_SETTINGS };
  const shortcuts = new Map<string, any>(), widgets = new Map<string, any>();
  let replaced = 0, opened = 0;
  const threads: any[] = [{ path: "/root/task", parent: "/root", owner: "/root", type: "worker", task: "Read the assigned files", state: "running", status: "Working", createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(), inputTokens: 2, outputTokens: 1 }];
  const ctx: any = { mode: "tui", hasUI: true, ui: {
    theme: { fg: (_: string, value: string) => value, colors: new Proxy({}, { get: () => ({ kind: "rgb", r: 0, g: 170, b: 0 }) }), style: (text: string) => text },
    setWidget(name: string, value: any) { widgets.set(name, value); },
    setEditorComponent() { replaced++; },
  } };
  const ui = module!.createManagerPresentation({ registerShortcut(key: string, options: any) { shortcuts.set(key, options); } } as any,
    { settings: () => settings, threads: () => threads, openTree: async () => { opened++; } });
  ui.refresh(ctx, false);
  const render = () => {
    const component = widgets.get("pi-subagent")({ requestRender() {} });
    try { return component.render(140).join("\n"); } finally { component.dispose(); }
  };
  assert.match(render(), /task/);
  assert.doesNotMatch(render(), /← browser|Press ←|→ collapse/);
  assert.match(widgets.get("native-subagents-navigation").join("\n"), /Ctrl\+Shift\+A/);
  await shortcuts.get("ctrl+shift+a").handler(ctx);
  assert.equal(opened, 1); assert.equal(replaced, 0);
  await shortcuts.get("ctrl+shift+c").handler(ctx);
  assert.doesNotMatch(render(), /task/, "collapse renders the actual upstream minimal summary");
  settings.subagentMode = "off";
  ui.refresh(ctx, false);
  await shortcuts.get("ctrl+shift+a").handler(ctx);
  assert.equal(opened, 1);
  assert.equal(widgets.get("pi-subagent"), undefined);
  assert.equal(widgets.get("native-subagents-navigation"), undefined);
});
