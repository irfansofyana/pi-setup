import test from"node:test";import assert from"node:assert/strict";import {createScheduler}from"./scheduler.ts";
function clock(){let time=0,id=0;const timers=new Map<number,{at:number;fn:()=>void}>();return {now:()=>time,set:(fn:()=>void,delay:number)=>{const key=++id;timers.set(key,{at:time+delay,fn});return key;},clear:(key:number)=>timers.delete(key),async advance(value:number){time=value;for(const[key,timer]of[...timers])if(timer.at<=time){timers.delete(key);timer.fn();}for(let i=0;i<5;i++)await new Promise<void>(r=>setImmediate(r));},size:()=>timers.size};}
test("restored jobs stay paused without replay; launch failures pause instead of retrying forever",async()=>{
 const fake=clock();let calls=0;
 const scheduler=createScheduler({enabled:true,clock:fake,launch:async()=>{calls++;throw Error("lease lost");},stop:async()=>{}});
 try{scheduler.restore({id:"old",schedule:{kind:"interval",everyMs:1000},request:{role:"reviewer",prompt:"x"},state:"scheduled",next:0,activeRunId:"old-run"});
 assert.equal(fake.size(),0);await fake.advance(9000);assert.equal(calls,0);assert.equal(scheduler.list()[0].state,"paused");
 scheduler.resume("old");await fake.advance(10000);assert.equal(calls,1);assert.equal(scheduler.list()[0].state,"paused");await fake.advance(20000);assert.equal(calls,1);
 }finally{scheduler.dispose();}
});
test("scheduler uses normal launch, skips overlap/missed intervals and distinguishes future cancellation",async()=>{
 const fake=clock();let calls=0,release:any,stops=0;
 const scheduler=createScheduler({enabled:true,clock:fake,launch:async()=>{calls++;return {runId:`run-${calls}`,threadId:`thread-${calls}`,done:new Promise(resolve=>release=resolve)};},stop:async()=>{stops++;}});
 try{const job=scheduler.add({schedule:{kind:"interval",everyMs:1000},request:{role:"reviewer",prompt:"review"}});
 await fake.advance(1000);assert.equal(calls,1);await fake.advance(9000);assert.equal(calls,1);
 scheduler.pause(job.id);assert.equal(stops,0);release();await fake.advance(20000);assert.equal(calls,1);
 scheduler.resume(job.id);await fake.advance(21000);assert.equal(calls,2);await scheduler.stopActive(job.id);assert.equal(stops,1);release();
 }finally{scheduler.dispose();}assert.equal(fake.size(),0);
});
test("scheduler is opt-in; one-shot and bounded UTC cron validate before timers",async()=>{
 const fake=clock();let calls=0;
 const disabled=createScheduler({enabled:false,clock:fake,launch:async()=>{calls++;}});assert.throws(()=>disabled.add({schedule:{kind:"once",at:1},request:{role:"reviewer",prompt:"x"}}),/disabled/);assert.equal(fake.size(),0);
 const scheduler=createScheduler({enabled:true,clock:fake,launch:async()=>{calls++;return {runId:"run-a",threadId:"thread-a",done:Promise.resolve()};},stop:async()=>{}});
 try{for(const schedule of [{kind:"interval",everyMs:0},{kind:"cron",expression:"* * * * *",timezone:"invalid"},{kind:"cron",expression:"*/0 * * * *",timezone:"UTC"}])assert.throws(()=>scheduler.add({schedule,request:{role:"reviewer",prompt:"x"}}),/invalid/);
 scheduler.add({schedule:{kind:"once",at:100},request:{role:"reviewer",prompt:"x"}});await fake.advance(100);await fake.advance(1000);assert.equal(calls,1);
 scheduler.add({schedule:{kind:"cron",expression:"1 * * * *",timezone:"UTC"},request:{role:"reviewer",prompt:"x"}});await fake.advance(60000);assert.equal(calls,2);
 }finally{scheduler.dispose();}
});
