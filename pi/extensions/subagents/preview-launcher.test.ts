import test from "node:test";
import assert from "node:assert/strict";
import {execFile}from"node:child_process";
import {promisify}from"node:util";
import {readFile,rm,writeFile,mkdir}from"node:fs/promises";
import {join}from"node:path";
const exec=promisify(execFile),launcher=new URL("./preview.mjs",import.meta.url).pathname;
test("launcher prepares opt-in features and reuses only its private marked profile without replacing role pins",async()=>{
 let root:string|undefined;
 try{
  const first=await exec(process.execPath,[launcher,"--prepare-only","--headroom","--persist","--schedules","--workflows"]);
  root=/Preview profile retained at: (.+)/.exec(first.stdout)?.[1];assert.ok(root);
  const path=join(root!,"subagents-preview.json"),config=JSON.parse(await readFile(path,"utf8"));
  assert.equal(config.persist,true);assert.equal(config.schedules,true);assert.equal(config.workflows,true);
  assert.equal(config.headroom,true);assert.equal(config.routing,"headroom-preferred");
  await assert.rejects(readFile(join(root!,"agents","researcher.md")),"bundled defaults must not be copied into user-owned global templates");
  const directory=join(root!,"subagent-manager","agents");await mkdir(directory,{recursive:true});
  const role=join(directory,"researcher.yml"),original="thinkingLevel: high\n";await writeFile(role,original);
  const again=await exec(process.execPath,[launcher,"--prepare-only",`--profile=${root}`]);assert.match(again.stdout,new RegExp(root!));
  assert.equal(await readFile(role,"utf8"),original);
  await assert.rejects(exec(process.execPath,[launcher,"--prepare-only","--profile=/tmp"]),/private|profile/);
 }finally{if(root)await rm(root,{recursive:true,force:true});}
});
