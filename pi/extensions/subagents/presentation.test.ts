import test from "node:test";
import assert from "node:assert/strict";
import {fleetLines,activityDetail,displayText}from"./presentation.ts";
test("fleet includes main and bounded effective worker activity without terminal control injection",()=>{
 const lines=fleetLines({model:"parent/main"},[{id:"agent-1",role:"reviewer",model:"provider/exact",task:"hello\x1b[2J\nworld",snapshot:{state:"queued",turns:2,budget:{hardTurns:5},usage:{totalTokens:7,cost:0}}}]);
 assert.match(lines.join("\n"),/main.*parent\/main/);assert.match(lines.join("\n"),/provider\/exact/);assert.match(lines.join("\n"),/2\/5/);assert.equal(lines.join("\n").includes("\x1b"),false);
 assert.equal(displayText("x".repeat(10000),100).length,100);
});
test("inspector includes bounded tool arguments, progress and results instead of tool names alone",()=>{
 const detail=activityDetail({type:"tool_execution_end",toolName:"read",args:{path:"public.txt"},result:{content:[{type:"text",text:"x".repeat(10000)}]}});
 assert.match(detail,/public.txt/);assert.match(detail,/truncated/);assert.ok(Buffer.byteLength(detail)<5000);
});
