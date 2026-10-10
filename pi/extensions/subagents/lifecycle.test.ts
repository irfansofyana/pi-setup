import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { NativeBackend } from "./backend.ts";
test("handled input cannot reuse a prior successful assistant message as this run's completion",async()=>{
 let emit:any;const session={messages:[{role:"assistant",stopReason:"stop",content:[{type:"text",text:"old answer"}]}],subscribe(listener:any){emit=listener;return()=>{};},async prompt(){emit({type:"agent_settled"});},async waitForIdle(){},dispose(){},clearQueue(){},async abort(){}};
 const backend=new NativeBackend(session as any);try{assert.deepEqual(await backend.run("handled input",()=>{}),{outcome:"failed",complete:false});}finally{await backend.dispose();}
});
test("agent_end/retry/compaction are not settlement, and duplicate settled events publish only once",async()=>{
 let emit:any,release:any;const barrier=new Promise<void>(resolve=>release=resolve),messages:any[]=[];
 const session={messages,subscribe(listener:any){emit=listener;return()=>{};},async prompt(){emit({type:"agent_end"});emit({type:"auto_retry_start"});emit({type:"auto_compaction_start"});await barrier;const message={role:"assistant",stopReason:"stop",content:[{type:"text",text:"final"}]};messages.push(message);emit({type:"message_end",message});emit({type:"agent_settled"});emit({type:"agent_settled"});},async waitForIdle(){},dispose(){},clearQueue(){},async abort(){}};
 const backend=new NativeBackend(session as any),events:any[]=[];let finished=false;const pending=backend.run("task",event=>events.push(event)).then(result=>{finished=true;return result;});
 try{await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(finished,false);release();assert.deepEqual(await pending,{outcome:"completed",complete:true});assert.equal(events.filter(event=>event.type==="agent_settled").length,1);}finally{release();await backend.dispose();}
});

test("disposal retains the route until an outstanding prompt preflight settles", async () => {
  let finishPreflight!: () => void;
  const preflight = new Promise<void>(resolve => { finishPreflight = resolve; });
  let emit: (event: AgentSessionEvent) => void = () => {};
  let released = false, disposed = false;
  // Pi 1.1.0 awaits input/auth hooks before marking a run active. A controlled
  // session double isolates that asynchronous boundary without model/network I/O.
  const session = {
    messages: [], isStreaming: false,
    subscribe(listener: typeof emit) { emit = listener; return () => {}; },
    async prompt() { await preflight; emit({ type: "agent_settled" } as AgentSessionEvent); },
    async waitForIdle() {}, async abort() {}, clearQueue() {},
    dispose() { disposed = true; },
  } as unknown as AgentSession;
  const backend = new NativeBackend(session, async () => { released = true; });
  const running = backend.run("task", () => {});
  const closing = backend.dispose(), duplicateClose = backend.dispose();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(disposed, false, "idle preflight is still owned by the backend");
    assert.equal(released, false, "pending prompt must retain its Headroom lease");
    assert.deepEqual(await backend.run("late task", () => {}), { outcome: "failed", complete: false });
  } finally {
    finishPreflight();
    await running; await closing; await duplicateClose;
  }
  assert.equal(disposed, true); assert.equal(released, true);
  assert.deepEqual(await running, { outcome: "interrupted", complete: false });
});
