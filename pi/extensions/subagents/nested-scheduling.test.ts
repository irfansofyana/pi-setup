import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisor } from "./supervisor.ts";

test("owner wait yields the sole execution slot through parent/child/grandchild and reacquires it", async () => {
  let serial=0, running=0, maximum=0; const visited:string[]=[];
  const handles=new Map<string,any>();
  const service=createSupervisor({concurrency:1,threads:4,nextId:()=>String(++serial),createBackend:async()=>{throw Error("unprepared");},
    prepare:async request=>({budget:{softTurns:5,hardTurns:5},createBackend:async()=>({
      abort:async()=>{},dispose:async()=>{},run:async()=>{
        const name=request.prompt; running++;maximum=Math.max(maximum,running);visited.push(name);
        if(name!=="grandchild"){
          while(!handles.has(name))await new Promise<void>(resolve=>setImmediate(resolve));
          const handle=handles.get(name); running--;
          await service.withYieldedSlot(handle.threadId,handle.runId,async()=>{
            const child=await service.start({prompt:name==="parent"?"child":"grandchild"});
            assert.equal(child.ok,true);if(!child.ok)throw Error("admission");handles.set(name==="parent"?"child":"grandchild",child);
            assert.equal((await service.wait([child.runId]))[0].complete,true);
          });
          running++;maximum=Math.max(maximum,running);visited.push(`${name}:resumed`);
        }
        running--;return {outcome:"completed" as const,complete:true};
      },
    })})});
  try {const parent=await service.start({prompt:"parent"});if(!parent.ok)throw Error("admission");handles.set("parent",parent);
    assert.equal((await service.wait([parent.runId]))[0].complete,true);
    assert.deepEqual(visited,["parent","child","grandchild","child:resumed","parent:resumed"]);assert.equal(maximum,1);
  } finally {await service.dispose();}
});

test("shutdown joins yielded parents and children; cancellation never grants a replacement model slot", async()=>{
  let serial=0, parent:any,child:any,release!:()=>void,entered!:()=>void,resumed=false,disposed=0;
  const ready=new Promise<void>(resolve=>entered=resolve);
  const service=createSupervisor({concurrency:1,nextId:()=>String(++serial),createBackend:async()=>{throw Error("unprepared");},
    prepare:async request=>({budget:{softTurns:5,hardTurns:5},createBackend:async()=>({
      abort:async()=>release?.(),dispose:async()=>{disposed++;},run:async()=>{
        if(request.prompt==="parent"){
          while(!parent)await new Promise<void>(resolve=>setImmediate(resolve));
          await service.withYieldedSlot(parent.threadId,parent.runId,async()=>{
            child=await service.start({prompt:"child"});await service.wait([child.runId]);
          });resumed=true;
        }else{entered();await new Promise<void>(resolve=>release=resolve);}
        return {outcome:"completed" as const,complete:true};
      },
    })})});
  parent=await service.start({prompt:"parent"});await ready;
  await service.dispose();assert.equal(resumed,false);assert.equal(disposed,2);
  assert.equal((await service.start({prompt:"replacement"})).ok,false);
});
