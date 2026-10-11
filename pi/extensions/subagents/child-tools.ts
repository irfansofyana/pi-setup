import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { agentTools } from "./upstream/src/orch/tools.ts";
import type { AgentType, ResolvedAgentSettings } from "./upstream/src/types.ts";
import type { createManagedSupervisor } from "./manager-service.ts";
import type { createOrchestration } from "./orchestration.ts";
import { createRootThreadService } from "./root-service.ts";

/** Child identity is a closure, never a model-supplied caller or raw supervisor handle. */
export function createChildTools(options:{
  path:string; allowed:readonly string[]; service:ReturnType<typeof createManagedSupervisor>;
  orchestration():Pick<Awaited<ReturnType<typeof createOrchestration>>,"admit"|"control">;
  types():AgentType[];resolve(type:AgentType):ResolvedAgentSettings;
}):ToolDefinition[]{
  const scope=()=>createRootThreadService(options.service,request=>options.orchestration().control(request),options.path);
  return agentTools(()=>({scope}),options.path,options.types,options.resolve)
    .filter(tool=>["agent_update","agent_pause"].includes(tool.name)||options.allowed.includes(tool.name))
    .map(tool=>({ ...tool,
      ...(tool.name==="agent_spawn"?{
        description:"Spawn a fresh bounded immediate child of this agent. wait:false detaches; wait:true cooperatively yields the execution slot. Writable children require explicit worktree files. No inherited context or ambient tools.",
        parameters:Type.Object({...(tool.parameters as any).properties,files:Type.Optional(Type.Array(Type.String())),maxTurns:Type.Optional(Type.Integer({minimum:1}))}),
      }:{}),
      async execute(id,params:any,signal,update,ctx){
        signal?.throwIfAborted();
        const work=async()=>{
          if(tool.name!=="agent_spawn")return tool.execute(id,params,signal,update,ctx);
          const {path,type,task,files,maxTurns}=params;
          const receipt=await options.orchestration().admit({role:type,prompt:task,...(files?{files}:{}),...(maxTurns!==undefined?{maxTurns}:{})},
            {managerPath:path,managerCaller:options.path,type,description:task.slice(0,512),isBackground:params.wait===false,timeoutMs:params.timeoutMs});
          if(!receipt.ok)throw Error(`Child admission: ${receipt.code}`);
          const exact=options.service.pathFor(receipt.threadId)!;
          const view=params.wait===false?scope().get(exact):await scope().wait(exact,undefined,signal);
          return {content:[{type:"text" as const,text:JSON.stringify(view)}],details:view};
        };
        if(tool.name==="agent_wait"||tool.name==="agent_stop"||(tool.name==="agent_spawn"&&params.wait!==false)){
          const handle=options.service.handleFor(options.path),current=handle&&options.service.inspect(handle.threadId);
          if(!handle||!current)throw Error("Child owner unavailable");
          return options.service.withYieldedSlot(handle.threadId,current.runId,work);
        }
        return work();
      },
    }));
}
