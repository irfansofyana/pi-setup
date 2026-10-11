import test from "node:test";
import assert from "node:assert/strict";
import { appendInspector, Inspector } from "./inspector.ts";
test("inspector bounds UTF-8 activity and strips terminal escapes",()=>{
  const text=appendInspector("a".repeat(65536),"\x1b[2J"+"界".repeat(30000));
  assert.ok(Buffer.byteLength(text)<=65536);assert.equal(text.includes("\x1b"),false);assert.ok(text.startsWith("[earlier"));
});
test("modal close unsubscribes without worker controls; follow and scrolling render bounded lines",()=>{
  let unsubscribed=0,closed=0;
  const viewer=new Inspector({requestRender(){},terminal:{rows:20}},()=>Array.from({length:100},(_,i)=>`line ${i}`).join("\n"),()=>()=>unsubscribed++,()=>closed++);
  assert.ok(viewer.render(50).length<=15);assert.ok(viewer.render(50).at(-1)?.includes("99"));
  viewer.handleInput("k");assert.equal(viewer.render(50).at(-1)?.includes("99"),false);
  viewer.handleInput("f");assert.ok(viewer.render(50).at(-1)?.includes("99"));viewer.handleInput("q");assert.equal(unsubscribed,1);assert.equal(closed,1);
});
