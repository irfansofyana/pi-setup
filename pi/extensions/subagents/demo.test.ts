import test from"node:test";import assert from"node:assert/strict";import{createDemo}from"./demo.ts";
test("disposable demo streams synthetic tool detail and supports interrupt without SDK model requests",async()=>{
 const demo=createDemo();const observed:any[]=[];demo.service.subscribe(event=>observed.push(event));
 try{const first=await demo.service.start({prompt:"synthetic demo"});await new Promise(resolve=>setTimeout(resolve,30));
 await demo.service.control({version:1,operation:"interrupt",threadId:first.threadId,expectedRunId:first.runId});
 const[result]=await demo.service.wait([first.runId]);assert.equal(result.complete,false);assert.equal(result.outcome,"interrupted");assert.ok(observed.some(event=>event.event?.toolName==="read"));
 }finally{await demo.service.dispose();}
});
