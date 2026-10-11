import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createManagedSupervisor } from "./manager-service.ts";
import { createChildTools } from "./child-tools.ts";
import { createOrchestration } from "./orchestration.ts";

test("scoped child tools delegate through retained admission and yield the sole slot without sibling authority",async()=>{
  const root=await mkdtemp(`${tmpdir()}/child-tools-`);let serial=0,owner:any;
  let orchestration:Awaited<ReturnType<typeof createOrchestration>>;
  const definitions:any[]=[{name:"worker",description:"Work",systemPrompt:"bounded",tools:{}}];
  const service=createManagedSupervisor({concurrency:1,threads:4,nextId:()=>String(++serial),createBackend:async()=>{throw Error("unprepared");},
    prepare:async request=>({model:"fixture/model",budget:{softTurns:5,hardTurns:5},createBackend:async()=>({
      hasRetainedContext:()=>true,abort:async()=>{},dispose:async()=>{},run:async(_prompt,emit)=>{
        if(request.prompt==="parent"){
          while(!owner)await new Promise<void>(resolve=>setImmediate(resolve));
          const tools=createChildTools({path:"/root/parent",allowed:["agent_spawn","agent_wait","agent_status"],service,orchestration:()=>orchestration,types:()=>definitions,resolve:()=>({model:"fixture/model",thinkingLevel:"low"})});
          assert.deepEqual(tools.map(tool=>tool.name),["agent_spawn","agent_wait","agent_status","agent_update","agent_pause"]);
          assert.throws(()=>service.manager.scope("/root/parent").get("/other"),/descendant/);
          const spawned:any=await tools.find(tool=>tool.name==="agent_spawn")!.execute("spawn",{path:"child",type:"worker",task:"child"},undefined,undefined,{} as any);
          assert.equal(spawned.details.path,"/root/parent/child");assert.equal(spawned.details.state,"completed");
          const waited:any=await tools.find(tool=>tool.name==="agent_wait")!.execute("wait",{path:"child"},undefined,undefined,{} as any);
          assert.equal(waited.details.state,"completed");
          const visible:any=await tools.find(tool=>tool.name==="agent_status")!.execute("status",{},undefined,undefined,{} as any);
          assert.deepEqual(visible.details.map(thread=>thread.path),["/root/parent","/root/parent/child"]);
        }
        emit({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"done"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0.01}}}});
        return{outcome:"completed" as const,complete:true};
      },
    })})},{maxLevels:4,getType:name=>({...definitions[0],name})});
  orchestration=await createOrchestration({agentDir:root,config:{},owner:"test",notify(){},outbox:()=>[],wait:service.wait,control:service.control,
    start:(request,metadata)=>service.start(request,metadata?.managerPath,metadata?.timeoutMs,metadata?.isBackground!==false,metadata?.managerCaller)});
  service.subscribe(event=>{if(event.type==="result")orchestration.remember(event.result!);});
  try{
    owner=await orchestration.admit({role:"worker",prompt:"parent"},{managerPath:"parent"});if(!owner.ok)throw Error("admission");
    assert.equal((await service.wait([owner.runId]))[0].complete,true);
    assert.equal(orchestration.results().length,2,"nested outcomes cannot bypass retained result ownership");
    assert.deepEqual(service.manager.saved().map(thread=>thread.inherited),[[],[]]);
  }finally{await service.dispose();await orchestration.close();await rm(root,{recursive:true,force:true});}
});
