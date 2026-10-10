import{randomUUID}from"node:crypto";import{createSupervisor}from"./supervisor.ts";
/** No credentials, resources, SDK sessions, shell, provider or filesystem operations. */
export function createDemo(){
 const service=createSupervisor({nextId:randomUUID,concurrency:1,threads:2,slots:4,pending:2,createBackend:async()=>{
  let stopped=false;
  return {async run(_prompt,emit){emit({type:"tool_execution_start",toolName:"read",args:{path:"synthetic-example.txt"}});
   for(let i=0;i<12&&!stopped;i++){emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:`Synthetic frame ${i+1}\n`}});await new Promise(resolve=>setTimeout(resolve,40));}
   emit({type:"tool_execution_end",toolName:"read",result:{content:[{type:"text",text:"Synthetic result: no file read"}]}});
   return {outcome:stopped?"interrupted"as const:"completed"as const,complete:!stopped};},async abort(){stopped=true;},async dispose(){stopped=true;}};
 }});return {service};
}
