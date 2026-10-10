import test from"node:test";
import assert from"node:assert/strict";
import{mkdtemp,rm,readdir,readFile}from"node:fs/promises";
import{join}from"node:path";
import{tmpdir}from"node:os";
import{createOrchestration}from"./orchestration.ts";
import{createSupervisor}from"./supervisor.ts";
import{createProtocol}from"./protocol.ts";
import{humanMenu}from"./human-ui.ts";
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test("human consumption releases live supervisor capacity, live notifications and retained state together",async()=>{
 const root=await mkdtemp(join(tmpdir(),"human-consume-"));let n=0;
 const service=createSupervisor({slots:1,nextId:()=>String(++n),createBackend:async()=>({run:async()=>({outcome:"completed",complete:true}),abort:async()=>{},dispose:async()=>{}})});
 const protocol=createProtocol({events:{on:()=>()=>{},emit:()=>{}},supervisor:service,start:service.start,generation:"owner"});
 const driver=await createOrchestration({agentDir:root,config:{persist:true},owner:"owner",start:async(request)=>protocol.announce(await service.start(request),{type:"reviewer",description:"test",isBackground:true}),wait:service.wait,control:protocol.control,notify:()=>{},outbox:protocol.pending});
 service.subscribe(event=>{if(event.type==="result")driver.remember(event.result!);});
 try{
  const first=await driver.admit({role:"reviewer",prompt:"first"});await service.wait([first.runId]);await driver.control({version:1,operation:"close",threadId:first.threadId});
  assert.equal(protocol.pending().length,1);
  await humanMenu("results",{select:async(_title,choices)=>choices[0],input:async()=>undefined,confirm:async()=>true,notify(){}},driver);
  assert.equal(driver.results()[0].consumed,true);assert.equal(protocol.pending().length,0);
  assert.notEqual(service.inspect(first.threadId)?.consumed,false); // consumed closed threads may be pruned
  const saved=JSON.parse(await readFile(join(root,"subagents-state","state.json"),"utf8"));assert.deepEqual(saved.data.outbox,[]);
  assert.equal((await driver.admit({role:"reviewer",prompt:"capacity recovered"})).ok,true);
 }finally{await driver.stopPlans();await service.dispose();await driver.close();protocol.dispose();await rm(root,{recursive:true,force:true});}
});
async function fixture(root:string,config:any,owner:string){
 let id=0;const runs:any[]=[];
 const service=createSupervisor({nextId:()=>String(++id),createBackend:async()=>({run:async(_prompt,emit)=>new Promise<any>(resolve=>runs.push({emit,resolve})),abort:async()=>{runs.at(-1)?.resolve({outcome:"interrupted",complete:false});},dispose:async()=>{},hasRetainedContext:()=>true})});
 const driver=await createOrchestration({agentDir:root,config,owner,start:service.start,wait:service.wait,control:service.control,notify:()=>{},outbox:()=>[]});
 service.subscribe(event=>{if(event.type==="result")driver.remember(event.result!);});
 return {service,driver,runs,async close(){await driver.stopPlans();await service.dispose();await driver.close();}};
}
test("persistence-off stays memory-only; drain stores actual interruptions and restart never replays",async()=>{
 const root=await mkdtemp(join(tmpdir(),"orchestration-"));let h:any;
 try{
  h=await fixture(root,{},"first");const start=await h.driver.admit({role:"reviewer",prompt:"pending"});await tick();
  await h.close();assert.equal((await h.service.wait([start.runId]))[0].outcome,"interrupted");assert.deepEqual(await readdir(root),[]);
  h=await fixture(root,{persist:true,schedules:true,workflows:true},"second");
  const pending=await h.driver.admit({role:"reviewer",prompt:"pending"});await tick();
  h.driver.jobs("create",{schedule:{kind:"interval",everyMs:60000},request:{role:"reviewer",prompt:"later"}});
  await h.close();
  const saved=JSON.parse(await readFile(join(root,"subagents-state","state.json"),"utf8"));assert.equal(saved.data.results[0].result.outcome,"interrupted");
  h=await fixture(root,{persist:true,schedules:true,workflows:true},"third");assert.equal(h.runs.length,0);assert.equal(h.driver.jobs("list",{}).jobs[0].state,"paused");
  const retained=h.driver.recoveredAgent(pending.agentId);assert.equal(retained.result.outcome,"interrupted");assert.equal(h.driver.results()[0].resumable,false);assert.equal(h.driver.results()[0].restored,true);
 }finally{await h?.close();await rm(root,{recursive:true,force:true});}
});
test("same-thread follow-up reserves durable orphan metadata and consumption never discards unconsumed results",async()=>{
 const root=await mkdtemp(join(tmpdir(),"orchestration-controls-"));let h:any;
 try{h=await fixture(root,{persist:true},"first");const start=await h.driver.admit({role:"reviewer",prompt:"first"});await tick();h.runs[0].resolve({outcome:"completed",complete:true});await h.service.wait([start.runId]);await tick();
  const next=await h.driver.control({version:1,operation:"follow_up",threadId:start.threadId,expectedRunId:start.runId,message:"second"});await tick();await h.driver.flush();
  const saved=JSON.parse(await readFile(join(root,"subagents-state","state.json"),"utf8"));assert.equal(saved.data.results.find((entry:any)=>entry.result.runId===next.runId).pending,true);
  await h.driver.control({version:1,operation:"consume",threadId:start.threadId,expectedRunId:start.runId});assert.equal(h.driver.results().find((entry:any)=>entry.result.runId===start.runId).consumed,true);
  assert.equal(h.driver.results().find((entry:any)=>entry.result.runId===next.runId).consumed,false);
 }finally{await h?.close();await rm(root,{recursive:true,force:true});}
});
