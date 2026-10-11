import test from "node:test";
import assert from "node:assert/strict";
import {hasLiveBuilder} from "./runtime-records.ts";
test("a retired builder record with no supervisor thread cannot block artifact recovery",()=>{
 const records=new Map([["agent",{threadId:"retired",role:"builder"}]]);
 assert.equal(hasLiveBuilder(records,()=>undefined),false);
 assert.equal(hasLiveBuilder(records,()=>({threadState:"open",consumed:false})),true);
 assert.equal(hasLiveBuilder(records,()=>({threadState:"closed",consumed:false})),false);
});
