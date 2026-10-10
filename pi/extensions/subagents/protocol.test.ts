import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisor } from "./supervisor.ts";
import { createProtocol } from "./protocol.ts";
function bus() {
  const listeners=new Map<string,Set<any>>(), messages:any[]=[];
  return {messages,on(name:string,fn:any){const handlers=listeners.get(name)??new Set();handlers.add(fn);listeners.set(name,handlers);return ()=>handlers.delete(fn);},
    async emit(name:string,value:any){messages.push([name,value]);await Promise.all([...(listeners.get(name)??[])].map(fn=>fn(value)));}};
}
test("concurrent duplicate spawn requests reserve identity before asynchronous preparation",async()=>{
 const events=bus();let n=0,starts=0,release:any;const gate=new Promise<void>(resolve=>release=resolve);
 const service=createSupervisor({nextId:()=>String(++n),createBackend:async()=>({run:async()=>({outcome:"completed",complete:true}),abort:async()=>{},dispose:async()=>{}})});
 const protocol=createProtocol({events,supervisor:service,start:async request=>{starts++;await gate;return service.start(request);},generation:"owner"});
 const request={requestId:"same",type:"reviewer",prompt:"review",options:{}};
 try{
  const first=events.emit("subagents:rpc:spawn",request),second=events.emit("subagents:rpc:spawn",request);
  release();await Promise.all([first,second]);
  assert.equal(starts,1);assert.equal(events.messages.filter(([name])=>name==="subagents:created").length,1);
  const replies=events.messages.filter(([name])=>name.endsWith(":reply:same")).map(([,value])=>value);
  assert.equal(replies.filter(reply=>reply.success).length,1);assert.equal(replies.filter(reply=>!reply.success).length,1);
 }finally{release();protocol.dispose();await service.dispose();}
});
test("a queued follow-up cannot suppress the preceding run's completion envelope",async()=>{
 const events=bus();let next=0;const runs:any[]=[];
 const supervisor=createSupervisor({nextId:()=>String(++next),createBackend:async()=>({run:async()=>new Promise<any>(resolve=>runs.push(resolve)),abort:async()=>{},dispose:async()=>{}})});
 const protocol=createProtocol({events,supervisor,start:supervisor.start,generation:"owner"});
 try{await events.emit("subagents:rpc:spawn",{requestId:"first",type:"reviewer",prompt:"first",options:{isBackground:true}});await new Promise<void>(r=>setImmediate(r));
 const first=events.messages.find(([name])=>name.endsWith(":reply:first"))[1].data;
 const nextRun=await protocol.control({version:1,operation:"follow_up",threadId:first.threadId,message:"next"});
 runs[0]({outcome:"completed",complete:true});await supervisor.wait([first.runId]);await new Promise<void>(r=>setImmediate(r));
 runs[1]({outcome:"completed",complete:true});await supervisor.wait([nextRun.runId!]);
 assert.deepEqual(events.messages.filter(([name])=>name==="subagents:completed").map(([,value])=>value.runId),[first.runId,nextRun.runId]);
 }finally{protocol.dispose();await supervisor.dispose();}
});
test("protocol v2 replies and fast lifecycle completion are correlated before parent notification",async()=>{
  const events=bus();let next=0;
  const supervisor=createSupervisor({nextId:()=>String(++next),createBackend:async()=>({run:async(_p,emit)=>{emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"ready"}});return {outcome:"completed",complete:true};},abort:async()=>{},dispose:async()=>{}})});
  const protocol=createProtocol({events,supervisor,start:(request:any)=>supervisor.start(request),generation:"owner-1"});
  try {
    await events.emit("subagents:rpc:ping",{requestId:"ping"});
    assert.deepEqual(events.messages.find(([name])=>name==="subagents:rpc:ping:reply:ping")?.[1],{success:true,data:{version:2}});
    await events.emit("subagents:rpc:spawn",{requestId:"spawn",type:"reviewer",prompt:"review",options:{description:"review",isBackground:true,inheritContext:false}});
    const reply=events.messages.find(([name])=>name==="subagents:rpc:spawn:reply:spawn")?.[1];assert.equal(reply?.success,true);
    await supervisor.wait([reply.data.runId]);await new Promise<void>(r=>setImmediate(r));
    const created=events.messages.find(([name])=>name==="subagents:created")?.[1],terminal=events.messages.find(([name])=>name==="subagents:completed")?.[1];
    assert.equal(created.id,reply.data.id);assert.equal(terminal.id,reply.data.id);assert.equal(terminal.runId,reply.data.runId);assert.equal(terminal.result,"ready");assert.equal(terminal.status,"completed");
    assert.equal(events.messages.filter(([name])=>name==="subagents:completed").length,1);
    assert.ok(events.messages.findIndex(([n])=>n==="subagents:created")<events.messages.findIndex(([n])=>n==="subagents:completed"));
    protocol.consume(reply.data.runId);assert.deepEqual(protocol.pending(),[]);
  } finally {protocol.dispose();await supervisor.dispose();}
});
test("protocol rejects authority expansion and stops an exact agent/request without launching fallback",async()=>{
  const events=bus();let next=0,release:any;
  const supervisor=createSupervisor({nextId:()=>String(++next),createBackend:async()=>({run:async()=>await new Promise(r=>release=r),abort:async()=>release?.({outcome:"interrupted",complete:false}),dispose:async()=>{}})});
  const protocol=createProtocol({events,supervisor,start:(request:any)=>supervisor.start(request),generation:"owner-1"});
  try {
    await events.emit("subagents:rpc:spawn",{requestId:"bad",type:"reviewer",prompt:"review",options:{inheritContext:true}});
    assert.equal(events.messages.find(([n])=>n.endsWith(":reply:bad"))?.[1].success,false);
    await events.emit("subagents:rpc:spawn",{requestId:"good",type:"reviewer",prompt:"review",options:{isBackground:true}});
    const reply=events.messages.find(([n])=>n.endsWith(":reply:good"))?.[1];
    await new Promise<void>(r=>setImmediate(r));
    await events.emit("subagents:rpc:stop",{requestId:"stop",id:reply.data.id});
    const [result]=await supervisor.wait([reply.data.runId]);assert.equal(result.outcome,"interrupted");
    await events.emit("subagents:rpc:spawn",{requestId:"cancelled",type:"reviewer",prompt:"review",options:{}});
    assert.equal(protocol.pending().length>=1,true);
  } finally {protocol.dispose();await supervisor.dispose();}
});
