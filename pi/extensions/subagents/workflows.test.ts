import test from"node:test";import assert from"node:assert/strict";import{createWorkflows}from"./workflows.ts";
async function settled(){for(let i=0;i<8;i++)await new Promise<void>(r=>setImmediate(r));}
test("skip reaches all reverse-ordered descendants and completes without a future worker callback",async()=>{
 let launches=0;const engine=createWorkflows({enabled:true,launch:async()=>{launches++;return{runId:"failed",threadId:"thread",done:Promise.resolve({outcome:"failed",complete:false})};},stop:async()=>{}});
 try{
  const graph=engine.start({version:1,steps:[{id:"c",role:"reviewer",prompt:"c",dependsOn:["b"]},{id:"branch",role:"reviewer",prompt:"branch",dependsOn:["b"]},{id:"b",role:"reviewer",prompt:"b",dependsOn:["a"]},{id:"a",role:"reviewer",prompt:"a"}]});
  await settled();engine.skip(graph.id,"a");
  assert.deepEqual(engine.inspect(graph.id).steps.map(step=>step.state),["skipped","skipped","skipped","skipped"]);
  assert.equal(engine.inspect(graph.id).state,"completed_with_skips");assert.equal(launches,1);
 }finally{await engine.dispose();}
});
test("human verification gates block dependants until evidence; pause holds the frontier and invalid schemas never launch",async()=>{
 const requests:any[]=[];const engine=createWorkflows({enabled:true,launch:async request=>{requests.push(request);return {runId:`run-${requests.length}`,threadId:`thread-${requests.length}`,done:Promise.resolve({outcome:"completed",complete:true,text:"ready"})};},stop:async()=>{}});
 try{
  for(const schema of [{type:"array",maxItems:-1},{type:"string",minLength:4,maxLength:1},{type:"object",properties:42}])assert.throws(()=>engine.start({version:1,steps:[{id:"a",role:"reviewer",prompt:"x",schema}]}),/invalid/);
  assert.equal(requests.length,0);
  const graph=engine.start({version:1,steps:[{id:"check",kind:"verification",prompt:"Verify manually"},{id:"next",role:"reviewer",prompt:"continue",dependsOn:["check"]}]});
  assert.equal(engine.inspect(graph.id).steps[0].state,"verification_requested");engine.pause(graph.id);
  assert.throws(()=>engine.verify(graph.id,"check",{accepted:true,proof:""}),/verification/);
  engine.verify(graph.id,"check",{accepted:true,proof:"Manually verified the output"});await settled();assert.equal(requests.length,0);
  engine.resume(graph.id);await settled();assert.equal(requests.length,1);assert.equal(engine.inspect(graph.id).state,"completed");
 }finally{await engine.dispose();}
});
test("journal recovery never replays in-flight work and rejects a mismatched plan fingerprint",async()=>{
 let release:any,starts=0;const first=createWorkflows({enabled:true,launch:async()=>({runId:"run-old",threadId:"thread-old",done:new Promise(r=>release=r)}),stop:async()=>{release?.({complete:false,outcome:"interrupted"});}});
 const original=first.start({version:1,steps:[{id:"a",role:"reviewer",prompt:"review"}]});await settled();const snapshot=first.inspect(original.id);await first.dispose();
 const recovered=createWorkflows({enabled:true,launch:async()=>{starts++;return {runId:"run-new",threadId:"thread-new",done:Promise.resolve({complete:true,outcome:"completed",text:"new"})};},stop:async()=>{}});
 try{const view=recovered.restore(snapshot);assert.equal(view?.state,"paused");assert.equal(recovered.inspect(view.id).steps[0].state,"failed");assert.equal(starts,0);
  assert.throws(()=>recovered.restore({...snapshot,id:"different",fingerprint:"tampered"}),/fingerprint/);
  recovered.retry(view.id,"a");assert.equal(starts,0);recovered.resume(view.id);await settled();assert.equal(starts,1);assert.equal(recovered.inspect(view.id).steps[0].runId,"run-new");
 }finally{await recovered.dispose();}
});
test("workflow dependency outputs are bounded data, successful gates advance, and every task uses normal launch",async()=>{
 const requests:any[]=[];const engine=createWorkflows({enabled:true,launch:async(request:any)=>{requests.push(request);return {runId:`run-${requests.length}`,threadId:`thread-${requests.length}`,done:Promise.resolve({complete:true,outcome:"completed",text:requests.length===1?'{"valid":true}':"reviewed"})};},stop:async()=>{}});
 try{const workflow=engine.start({version:1,steps:[{id:"map",role:"code-mapper",prompt:"map",maxTurns:2,schema:{type:"object",properties:{valid:{type:"boolean"}},required:["valid"],additionalProperties:false}},{id:"review",role:"reviewer",prompt:"review",maxTurns:2,dependsOn:["map"]}]});
 await settled();assert.equal(engine.inspect(workflow.id).state,"completed");assert.equal(requests.length,2);assert.match(requests[1].prompt,/dependency_data/);assert.match(requests[1].prompt,/valid/);assert.equal(requests[1].maxTurns,2);
 await engine.dispose();assert.equal(engine.inspect(workflow.id).state,"completed");
 }finally{await engine.dispose();}
});
test("workflow rejects cycles, arbitrary code, unknown roles and excessive shared budget before any launch",async()=>{
 let launches=0;const engine=createWorkflows({enabled:true,launch:async()=>{launches++;},stop:async()=>{}});
 try{for(const graph of [{version:1,steps:[{id:"a",role:"reviewer",prompt:"a",dependsOn:["b"]},{id:"b",role:"reviewer",prompt:"b",dependsOn:["a"]}]},{version:1,steps:[{id:"a",role:"shell",prompt:"x"}]},{version:1,steps:[{id:"a",role:"reviewer",prompt:"x",script:"evil"}]},{version:1,maxTurns:1,steps:[{id:"a",role:"reviewer",prompt:"x",maxTurns:2}]},{version:1,maxTurns:129,steps:[{id:"a",role:"reviewer",prompt:"x"}]}])assert.throws(()=>engine.start(graph),/invalid|cycle|budget/);assert.equal(launches,0);
 }finally{await engine.dispose();}
});
test("structured output failure pauses dependants; explicit retry has a new run; cancellation cannot become success",async()=>{
 let calls=0,release:any;
 const engine=createWorkflows({enabled:true,launch:async()=>{calls++;return {runId:`run-${calls}`,threadId:`thread-${calls}`,done:calls===1?Promise.resolve({complete:true,outcome:"completed",text:'{"valid":"wrong"}'}):new Promise(r=>release=r)};},stop:async()=>{release?.({complete:false,outcome:"interrupted",text:"partial"});}});
 try{const workflow=engine.start({version:1,steps:[{id:"a",role:"reviewer",prompt:"review",maxTurns:2,schema:{type:"object",properties:{valid:{type:"boolean"}},required:["valid"]}},{id:"b",role:"reviewer",prompt:"next",maxTurns:2,dependsOn:["a"]}]});
 await settled();assert.equal(engine.inspect(workflow.id).steps[0].state,"failed");assert.equal(calls,1);
 engine.retry(workflow.id,"a");await settled();assert.equal(engine.inspect(workflow.id).steps[0].runId,"run-2");
 await engine.cancel(workflow.id);await settled();assert.equal(engine.inspect(workflow.id).state,"cancelled");assert.equal(calls,2);
 }finally{await engine.dispose();}
});
