import test from "node:test";
import assert from "node:assert/strict";
import {execFile}from"node:child_process";
import {promisify}from"node:util";
import {readFile,rm,writeFile}from"node:fs/promises";
import {join}from"node:path";
const exec=promisify(execFile),launcher=new URL("./preview.mjs",import.meta.url).pathname;
test("launcher prepares opt-in features and reuses only its private marked profile without replacing role pins",async()=>{
 let root:string|undefined;
 try{
  const first=await exec(process.execPath,[launcher,"--prepare-only","--persist","--schedules","--workflows"]);
  root=/Preview profile retained at: (.+)/.exec(first.stdout)?.[1];assert.ok(root);
  const path=join(root!,"subagents-preview.json"),config=JSON.parse(await readFile(path,"utf8"));
  assert.equal(config.persist,true);assert.equal(config.schedules,true);assert.equal(config.workflows,true);
  const role=join(root!,"agents","researcher.md");const original=await readFile(role,"utf8");await writeFile(role,original.replace("thinking: medium","thinking: high"));
  const again=await exec(process.execPath,[launcher,"--prepare-only",`--profile=${root}`]);assert.match(again.stdout,new RegExp(root!));
  assert.equal(await readFile(role,"utf8"),original.replace("thinking: medium","thinking: high"));
  await assert.rejects(exec(process.execPath,[launcher,"--prepare-only","--profile=/tmp"]),/private|profile/);
 }finally{if(root)await rm(root,{recursive:true,force:true});}
});
