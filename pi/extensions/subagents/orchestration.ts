import{join}from"node:path";
import{randomUUID}from"node:crypto";
import{openStore}from"./storage.ts";
import{createScheduler}from"./scheduler.ts";
import{createWorkflows}from"./workflows.ts";
import type{createSupervisor,StartRequest}from"./supervisor.ts";
import type{RunResult,Control}from"./contracts.ts";
type Supervisor=ReturnType<typeof createSupervisor>;
type Retained={result:RunResult;consumed:boolean;owner:string;pending?:boolean};
export async function createOrchestration(options:{agentDir:string;config:any;owner:string;start:(request:StartRequest,metadata?:any)=>ReturnType<Supervisor["start"]>;wait:Supervisor["wait"];control:(request:Control)=>ReturnType<Supervisor["control"]>;notify:(text:string)=>void;outbox:()=>any[]}){
 const store=await openStore<any>({root:join(options.agentDir,"subagents-state"),owner:options.config.profileOwner??"profile",enabled:options.config.persist===true});
 let saved:any,revision=0;
 try{saved=await store.load();}catch(error){await store.close();throw error;}
 if(saved){if(saved.data.version!==1||!Array.isArray(saved.data.results)||saved.data.results.length>32||!Array.isArray(saved.data.outbox)||saved.data.outbox.length>32||!Array.isArray(saved.data.jobs)||saved.data.jobs.length>32||!Array.isArray(saved.data.workflows)||saved.data.workflows.length>8){await store.close();throw Error("unsupported retained state; original preserved");}revision=saved.revision;}
 const retained=new Map<string,Retained>(),recoveredOutbox=new Map<string,any>();
 for(const envelope of saved?.data.outbox??[]){if(typeof envelope?.runId!=="string"||typeof envelope?.generation!=="string"){await store.close();throw Error("invalid retained notification");}recoveredOutbox.set(envelope.runId,envelope);}
 for(const entry of saved?.data.results??[]){if(!entry.result?.runId?.startsWith("run-")||typeof entry.owner!=="string"||typeof entry.consumed!=="boolean"){await store.close();throw Error("invalid retained result");}retained.set(entry.result.runId,entry);}
 let fault=false,dirty=false,writing:Promise<void>|undefined,closed=false,stopping=false,ready=false,reservations=0;
 const notify=(text:string)=>{try{options.notify(text);}catch{}};
 let scheduler:ReturnType<typeof createScheduler>,workflows:ReturnType<typeof createWorkflows>;
 const notifications=()=>[...recoveredOutbox.values(),...options.outbox()];
 function data(){return {version:1,owner:options.owner,results:[...retained.values()],outbox:notifications(),
  jobs:options.config.schedules?scheduler.list():saved?.data.jobs??[],workflows:options.config.workflows?workflows.list():saved?.data.workflows??[]};}
 function persist():Promise<void>{
  if(!ready||!options.config.persist||closed||fault)return Promise.resolve();dirty=true;
  return writing??=(async()=>{try{while(dirty){dirty=false;const result=await store.save(revision,data());revision=result.revision;}}
   catch{fault=true;dirty=false;notify("Subagent state write failed; new submissions blocked. Retained file preserved; current results remain in memory.");}
   finally{writing=undefined;}})();
 }
 function prune(){for(const[id,entry]of retained)if(retained.size>=32&&entry.consumed)retained.delete(id);}
 async function admit(request:StartRequest,metadata?:any){
  prune();if(closed||stopping||fault||retained.size+reservations>=32)return {ok:false as const,code:"backpressure"as const,domain:"results"as const,recovery:"consume_or_close"as const};
  reservations++;
  try{const result=await options.start(request,metadata);if(result.ok&&!retained.has(result.runId))retained.set(result.runId,{owner:options.owner,consumed:false,pending:true,result:{version:1,agentId:result.agentId,threadId:result.threadId,runId:result.runId,outcome:"orphaned",complete:false,truncated:false,text:"In-flight context unavailable after restart"}});void persist();return result;}
  finally{reservations--;}
 }
 async function markConsumed(runId:string){const entry=retained.get(runId);if(!entry)throw Error("unknown retained run");entry.consumed=true;recoveredOutbox.delete(runId);await persist();}
 async function consume(runId:string){
  const entry=retained.get(runId);if(!entry)throw Error("unknown retained run");
  if(entry.owner===options.owner){
   if(entry.pending)throw Error("in-flight outcome cannot be consumed");
   const answer=await options.control({version:1,operation:"consume",threadId:entry.result.threadId,expectedRunId:runId});
   if(answer.status==="rejected")throw Error("live outcome consumption rejected");
  }
  await markConsumed(runId);
 }
 async function control(request:Control){
  const launches=["follow_up","resume"].includes(request.operation);
  if(launches){prune();if(stopping||closed||fault||retained.size+reservations>=32)return {version:1 as const,controlId:`control-${randomUUID()}`,status:"rejected"as const,error:{ok:false as const,code:"backpressure"as const,domain:"results"as const,recovery:"consume_or_close"as const}};reservations++;}
  try{const answer=await options.control(request);
   if(answer.status!=="rejected"&&answer.runId){
    if(launches&&!retained.has(answer.runId)){const prior=[...retained.values()].find(entry=>entry.result.threadId===request.threadId);if(!prior)throw Error("missing retained thread owner");retained.set(answer.runId,{owner:options.owner,pending:true,consumed:false,result:{...prior.result,runId:answer.runId,outcome:"orphaned",complete:false,text:"In-flight context unavailable after restart",usage:undefined,turns:undefined,toolUses:undefined}});}
    if(request.operation==="consume")await markConsumed(answer.runId);else void persist();
   }return answer;
  }finally{if(launches)reservations--;}
 }
 async function launch(request:StartRequest){
  const accepted=await admit(request,{type:request.role,description:"Scheduled/workflow specialist",isBackground:true});if(!accepted.ok)throw Error(accepted.code);
  const done=(async()=>{const[result]=await options.wait([accepted.runId]);try{return result;}finally{await control({version:1,operation:"close",threadId:accepted.threadId,expectedRunId:accepted.runId});await control({version:1,operation:"consume",threadId:accepted.threadId,expectedRunId:accepted.runId});}})();
  return {runId:accepted.runId,threadId:accepted.threadId,done};
 }
 const stop=async(run:{runId:string;threadId:string})=>{await options.control({version:1,operation:"interrupt",threadId:run.threadId,expectedRunId:run.runId});};
 scheduler=createScheduler({enabled:options.config.schedules===true,launch,stop,lease:async()=>{if(options.config.persist)await store.load();},changed:()=>{if(workflows)void persist();}});
 workflows=createWorkflows({enabled:options.config.workflows===true,launch,stop,changed:()=>{void persist();}});
 try{
  if(options.config.workflows)for(const snapshot of saved?.data.workflows??[])workflows.restore(snapshot);
  if(options.config.schedules)for(const snapshot of saved?.data.jobs??[])scheduler.restore(snapshot);
 }catch(error){scheduler.dispose();await workflows.dispose();await store.close();throw error;}
 ready=true;
 return {admit,control,flush:persist,notifications,remember(result:RunResult){const previous=retained.get(result.runId);retained.set(result.runId,{result,consumed:previous?.consumed??false,owner:options.owner,pending:false});queueMicrotask(()=>{void persist();});},consume,
  results:()=>[...retained.values()].map(entry=>structuredClone({...entry,restored:entry.owner!==options.owner,resumable:false})),
  recoveredAgent(id:string){return [...retained.values()].filter(entry=>entry.result.agentId===id).at(-1);},
  jobs(action:string,input:any){if(action==="list")return {jobs:scheduler.list()};if(stopping||!options.config.schedules)throw Error("scheduler disabled");
   let result;if(action==="create")result=scheduler.add({schedule:input.schedule,request:input.request});else if(action==="pause")scheduler.pause(input.job_id);else if(action==="resume")scheduler.resume(input.job_id);else if(action==="stop_active")return scheduler.stopActive(input.job_id).then(async()=>{await persist();return scheduler.list();});else throw Error("unsupported job action");void persist();return result??scheduler.list();},
  workflow(action:string,input:any){if(action==="list")return workflows.list();if(stopping||!options.config.workflows)throw Error("workflows disabled");
   let result;if(action==="start")result=workflows.start(input.plan);else if(action==="inspect")return workflows.inspect(input.workflow_id);else if(action==="pause")workflows.pause(input.workflow_id);else if(action==="resume")workflows.resume(input.workflow_id);else if(action==="retry")workflows.retry(input.workflow_id,input.step_id);else if(action==="skip")workflows.skip(input.workflow_id,input.step_id);else if(action==="cancel")return workflows.cancel(input.workflow_id).then(async()=>{await persist();return workflows.inspect(input.workflow_id);});else throw Error("unsupported workflow action");void persist();return result??workflows.inspect(input.workflow_id);},
  verify:workflows.verify,
  async stopPlans(){stopping=true;scheduler.dispose();await workflows.stop();},
  async close(){stopping=true;scheduler.dispose();try{await workflows.dispose();await persist();}finally{await store.close();closed=true;}},
 };
}
