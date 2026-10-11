import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MANAGER_SETTINGS } from "./upstream/src/prefs/settings.ts";
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function fixture() {
  const module = await import("./parent-delivery.ts").catch(() => undefined);
  assert.equal(typeof module?.createParentDelivery, "function");
  const settings = { ...DEFAULT_MANAGER_SETTINGS }, sent: any[] = [];
  let idle = true, outstanding = 0;
  const ctx: any = { sessionManager: { getSessionId: () => "root-1" }, isIdle: () => idle, ui: { notify() {} } };
  const delivery = module!.createParentDelivery({ sendMessage(message: any, options: any) { sent.push({ message, options }); } } as any,
    { settings: () => settings, context: () => ctx, outstanding: () => outstanding, runKey: thread => thread.path + ":run-1" });
  return { settings, sent, ctx, delivery, busy(value: boolean) { idle = !value; }, outstanding(value: number) { outstanding = value; } };
}
const event = (path: string, extra: any = {}) => ({ kind: "settled", recipient: "/root", async: true,
  thread: { path, state: "completed", status: "Done", output: "Result data", updatedAt: 1 }, ...extra } as any);

test("detached settlements coalesce into one hidden parent wake, without duplicate delivery", async () => {
  const f = await fixture();
  f.delivery.event(event("/root/a")); f.delivery.event(event("/root/b")); f.delivery.event(event("/root/a"));
  await tick();
  assert.equal(f.sent.filter(item => item.options.triggerTurn).length, 1);
  assert.equal(f.sent.filter(item => item.message.customType === "pi-subagent:update").length, 2);
  assert.ok(f.sent.every(item => item.message.display === false));
  assert.match(f.sent.at(-1).message.content, /agent_output/);
  f.delivery.close();
});
test("busy parents defer delivery; Off suppresses both queued notification and wake", async () => {
  const f = await fixture(); f.busy(true);
  f.delivery.event(event("/root/a")); await tick(); assert.equal(f.sent.length, 0);
  f.busy(false); f.settings.subagentMode = "off"; f.delivery.flush(); await tick(); assert.equal(f.sent.length, 0);
  f.settings.subagentMode = "opportunistic"; f.delivery.flush(); await tick();
  assert.equal(f.sent.filter(item => item.options.triggerTurn).length, 1);
  f.delivery.close();
});
test("Final Recap waits for all asynchronous agents, then starts one main-thread summary", async () => {
  const f = await fixture(); f.settings.finalRecap = true; f.outstanding(1);
  f.delivery.event(event("/root/a")); await tick();
  assert.equal(f.sent.filter(item => item.options.triggerTurn).length, 0);
  f.outstanding(0); f.delivery.event(event("/root/b")); await tick();
  const turns = f.sent.filter(item => item.options.triggerTurn);
  assert.equal(turns.length, 1); assert.equal(turns[0].message.customType, "pi-subagent:summary");
  assert.match(turns[0].message.content, /Do not spawn or resume/);
  assert.match(turns[0].message.content, /\/root\/a/); assert.match(turns[0].message.content, /\/root\/b/);
  f.delivery.close();
});
test("closing a generation cancels scheduled wakes and discards late events", async () => {
  const f = await fixture(); f.delivery.event(event("/root/a")); f.delivery.close();
  f.delivery.event(event("/root/b")); await tick();
  assert.equal(f.sent.filter(item => item.options.triggerTurn).length, 0);
  assert.equal(f.sent.filter(item => item.message.content.includes("/root/b")).length, 0);
});

test("the last detached descendant settlement releases an already-pending root recap",async()=>{
  const f=await fixture();f.settings.finalRecap=true;f.outstanding(1);
  f.delivery.event(event("/root/coordinator"));await tick();
  assert.equal(f.sent.filter(item=>item.options.triggerTurn).length,0);
  f.outstanding(0);f.delivery.event(event("/root/coordinator/child",{recipient:"/root/coordinator"}));await tick();
  assert.equal(f.sent.filter(item=>item.options.triggerTurn).length,1);
  assert.equal(f.sent.at(-1).message.customType,"pi-subagent:summary");
  assert.equal(f.sent.filter(item=>item.message.customType==="pi-subagent:update").length,1,"descendant evidence is not forwarded to the wrong parent");
  f.delivery.close();
});
