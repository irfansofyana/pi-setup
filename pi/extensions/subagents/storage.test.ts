import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,stat,readdir,rm}from"node:fs/promises";
import {join}from"node:path";
import {tmpdir}from"node:os";
import {openStore,inspectStorageLease,reconcileStorageLease}from"./storage.ts";
test("stale lease recovery preserves the lock evidence and refuses a living PID or drift",async()=>{
 const root=await mkdtemp(join(tmpdir(),"subagents-stale-"));
 try{const lock=join(root,"owner.lock");await writeFile(lock,JSON.stringify({version:1,owner:"profile",pid:process.pid,token:"fixture-token"}),{mode:0o600});
 const live=await inspectStorageLease(root);await assert.rejects(reconcileStorageLease(root,live),/alive/);
 await writeFile(lock,JSON.stringify({version:1,owner:"profile",pid:2147483647,token:"fixture-token"}),{mode:0o600});
 await assert.rejects(reconcileStorageLease(root,live),/drift/);const dead=await inspectStorageLease(root);await reconcileStorageLease(root,dead);
 assert.equal((await readdir(root)).some(name=>name.startsWith("owner.lock.recovered-")),true);
 const store=await openStore({root,owner:"profile",enabled:true});await store.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test("private storage atomically revisions state and rejects concurrent ownership/revision drift",async()=>{
 const root=await mkdtemp(join(tmpdir(),"subagents-store-"));let store:any;
 try{store=await openStore({root:join(root,"state"),owner:"session-a",enabled:true});
  assert.equal(await store.load(),undefined);
  const saved=await store.save(0,{results:[{runId:"run-a",text:"retained"}],outbox:[]});assert.equal(saved.revision,1);
  assert.equal((await store.load()).data.results[0].text,"retained");
  await assert.rejects(store.save(0,{results:[]}),/revision/);
  await assert.rejects(openStore({root:join(root,"state"),owner:"session-a",enabled:true}),/lease/);
  assert.equal((await stat(join(root,"state","state.json"))).mode&0o077,0);
  await store.close();store=await openStore({root:join(root,"state"),owner:"session-a",enabled:true});assert.equal((await store.load()).revision,1);
 }finally{await store?.close();await rm(root,{recursive:true,force:true});}
});
test("disabled storage writes nothing; corrupt/future/foreign state remains untouched",async()=>{
 const root=await mkdtemp(join(tmpdir(),"subagents-store-policy-"));let store:any;
 try{const disabled=await openStore({root:join(root,"disabled"),owner:"session-a",enabled:false});assert.equal(await disabled.load(),undefined);await assert.rejects(disabled.save(0,{}),/disabled/);assert.deepEqual(await readdir(root),[]);
  store=await openStore({root:join(root,"state"),owner:"session-a",enabled:true});
  for(const data of ["{broken",JSON.stringify({version:99,owner:"session-a",revision:1,data:{}}),JSON.stringify({version:1,owner:"other",revision:1,data:{}})]){
   await writeFile(join(root,"state","state.json"),data,{mode:0o600});await assert.rejects(store.load(),/corrupt|version|owner/);assert.equal(await readFile(join(root,"state","state.json"),"utf8"),data);
  }
 }finally{await store?.close();await rm(root,{recursive:true,force:true});}
});
