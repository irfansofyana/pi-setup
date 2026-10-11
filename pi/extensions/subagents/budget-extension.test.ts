import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisor } from "./supervisor.ts";

test("explicit turn extensions are exact-run, bounded and do not reset cumulative usage or deadline",async()=>{
  let serial=0,time=0;
  const fleet=createSupervisor({nextId:()=>String(++serial),now:()=>time,budget:{softTurns:2,hardTurns:3,maxTokens:100,maxCost:10,elapsedMs:1000},
    createBackend:async()=>({hasRetainedContext:()=>true,abort:async()=>{},dispose:async()=>{},run:async(_prompt,emit)=>{
      emit({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0.1}}}});
      return{outcome:"completed",complete:true};}})});
  try {
    const started=await fleet.start({prompt:"initial"});assert.equal(started.ok,true);if(!started.ok)return;
    await fleet.wait([started.runId]);
    const old=fleet.inspect(started.threadId)!;
    const extend=(additionalTurns:number,expectedRunId=started.runId)=>fleet.control({version:1,operation:"extend_budget",threadId:started.threadId,expectedRunId,additionalTurns}as any);
    assert.equal((await extend(1,"run-wrong")).status,"rejected");
    assert.equal((await extend(3)).status,"rejected");
    assert.equal((await extend(2)).status,"handled");
    const current=fleet.inspect(started.threadId)!;
    assert.equal(current.budget?.softTurns,4);assert.equal(current.budget?.hardTurns,5);
    assert.equal(old.budget?.hardTurns,3,"previous inspection cannot mutate with a grant");
    assert.equal(current.turns,1);assert.equal(current.usage.totalTokens,2);assert.equal(current.usage.cost,0.1);
    assert.equal(current.budget?.elapsedMs,1000);assert.equal(current.budget?.maxTokens,100);assert.equal(current.budget?.maxCost,10);
    assert.equal((await extend(2)).status,"handled");assert.equal((await extend(1)).status,"rejected");
    time=1001;
    const follow=await fleet.control({version:1,operation:"follow_up",threadId:started.threadId,message:"not after original deadline"});
    assert.equal(follow.status,"rejected");
  }finally{await fleet.dispose();}
});

test("turn extensions cannot resurrect a hard-exhausted backend",async()=>{
 let serial=0;
 const fleet=createSupervisor({nextId:()=>String(++serial),budget:{softTurns:1,hardTurns:1},createBackend:async()=>({abort:async()=>{},dispose:async()=>{},run:async(_p,emit)=>{
  emit({type:"message_end",message:{role:"assistant",stopReason:"toolUse",content:[]}});return{outcome:"completed",complete:false};}})});
 try {const start=await fleet.start({prompt:"exhaust"});assert.equal(start.ok,true);if(!start.ok)return;
  assert.equal((await fleet.wait([start.runId]))[0].outcome,"budget_exhausted");
  assert.equal((await fleet.control({version:1,operation:"extend_budget",threadId:start.threadId,expectedRunId:start.runId,additionalTurns:1}as any)).status,"rejected");
 }finally{await fleet.dispose();}
});

test("hard-two evaluators and workflow-reserved tasks cannot extend their caller-owned budgets",async()=>{
 let serial=0;
 const fleet=createSupervisor({nextId:()=>String(++serial),evaluatorSupported:true,budget:{softTurns:2,hardTurns:2},createBackend:async()=>({abort:async()=>{},dispose:async()=>{},run:async()=>({outcome:"completed",complete:true})})});
 try {for(const request of[{evaluator:true},{budgetExtendable:false}]){
   const start=await fleet.start({prompt:"fixed caller budget",...request});assert.equal(start.ok,true);if(!start.ok)continue;
   await fleet.wait([start.runId]);
   assert.equal((await fleet.control({version:1,operation:"extend_budget",threadId:start.threadId,expectedRunId:start.runId,additionalTurns:1}as any)).status,"rejected");
  }
 }finally{await fleet.dispose();}
});
