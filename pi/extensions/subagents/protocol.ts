import type { createSupervisor, StartRequest } from "./supervisor.ts";
type Supervisor=ReturnType<typeof createSupervisor>;
type Events={on(name:string,handler:(value:any)=>any):()=>void;emit(name:string,value:any):any};
type Record={id:string;threadId:string;runId:string;type:string;description:string;isBackground:boolean;started:number;requestId?:string};
export function createProtocol(options:{events:Events;supervisor:Supervisor;start:(request:StartRequest,metadata?:any)=>ReturnType<Supervisor["start"]>;generation:string;cwd?:()=>string;now?:()=>number}) {
  const records=new Map<string,Record>(),runs=new Map<string,Record>(),early=new Map<string,any>(),outbox=new Map<string,any>(),requests=new Map<string,string>(),cancelled=new Set<string>();
  const preparing=new Set<string>();
  let live=true;const now=options.now??Date.now;
  const emit=(channel:string,value:any)=>{if(!live)return;try{const pending=options.events.emit(channel,value);pending?.catch?.(()=>{});}catch{/* observers cannot break worker ownership */}};
  function terminal(record:Record,result:any){
    if(outbox.has(result.runId))return;
    const envelope={id:record.id,runId:result.runId,threadId:record.threadId,generation:options.generation,type:record.type,description:record.description,isBackground:record.isBackground,
      result:result.text??"",error:result.complete?null:result.outcome,status:result.outcome,complete:result.complete,truncated:result.truncated,
      toolUses:result.toolUses??0,durationMs:Math.max(0,now()-record.started),tokens:result.usage?.totalTokens??null,usage:result.usage??null};
    outbox.set(result.runId,envelope);
    if(record.isBackground)emit(result.complete?"subagents:completed":"subagents:failed",envelope);
  }
  const unsubscribe=options.supervisor.subscribe(event=>{
    if(!live||event.type!=="result")return;
    const record=runs.get(event.runId);
    if(record)terminal(record,event.result);
    else if(early.size<32)early.set(event.runId,event.result);
  });
  function announce(receipt:any,metadata:{type:string;description:string;isBackground:boolean;requestId?:string}){
    if(!receipt.ok)return receipt;
    if(records.get(receipt.agentId)?.runId===receipt.runId)return receipt;
    for(const [id,record]of records){const state=options.supervisor.inspect(record.threadId);if(!state||(state.threadState==="closed"&&state.consumed)){records.delete(id);for(const [key,value]of requests)if(value===id)requests.delete(key);}}
    const record={id:receipt.agentId,threadId:receipt.threadId,runId:receipt.runId,started:now(),...metadata};records.set(record.id,record);runs.set(record.runId,record);
    if(metadata.requestId)requests.set(metadata.requestId,record.id);
    emit("subagents:created",{id:record.id,type:record.type,description:record.description,isBackground:record.isBackground,threadId:record.threadId,runId:record.runId,generation:options.generation});
    const result=early.get(receipt.runId);if(result){early.delete(receipt.runId);terminal(record,result);}
    return receipt;
  }
  async function control(request:any){
    const receipt=await options.supervisor.control(request);
    if(receipt.status!=="rejected"){
      if(request.operation==="consume"){outbox.delete(receipt.runId!);runs.delete(receipt.runId!);}
      if(["follow_up","resume"].includes(request.operation)&&receipt.runId){
        const previous=[...records.values()].find(r=>r.threadId===request.threadId);if(previous){const record={...previous,runId:receipt.runId,started:now()};records.set(record.id,record);runs.set(record.runId,record);emit("subagents:created",{id:record.id,type:record.type,description:record.description,isBackground:record.isBackground,threadId:record.threadId,runId:record.runId,generation:options.generation});const result=early.get(receipt.runId);if(result){early.delete(receipt.runId);terminal(record,result);}}
      }
    }
    return receipt;
  }
  const subscriptions=[unsubscribe];
  for(const operation of ["ping","spawn","stop"]){
    const channel=`subagents:rpc:${operation}`;
    subscriptions.push(options.events.on(channel,async(raw:any)=>{
      if(!live||!raw||typeof raw.requestId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(raw.requestId))return;
      const reply=(data:any)=>emit(`${channel}:reply:${raw.requestId}`,data);
      let reserved=false;
      try{
        if(operation==="ping"){reply({success:true,data:{version:2}});return;}
        if(operation==="stop"){
          if(raw.spawnRequestId){if(cancelled.size>=64)throw Error("cancel_request_capacity");cancelled.add(raw.spawnRequestId);}
          const record=records.get(raw.id??requests.get(raw.spawnRequestId));
          if(!record){if(raw.spawnRequestId){reply({success:true,data:{cancelled:true}});return;}throw Error("unknown_agent");}
          const receipt=await control({version:1,operation:"interrupt",threadId:record.threadId,expectedRunId:record.runId});
          reply({success:receipt.status!=="rejected",...(receipt.status==="rejected"?{error:receipt.error?.code}:{data:receipt})});return;
        }
        const fields=raw.options??{};
        if(typeof raw.prompt!=="string"||!raw.prompt.trim()||!["researcher","code-mapper","builder","reviewer","Explore"].includes(raw.type)||Object.keys(fields).some(k=>!["description","isBackground","inheritContext","maxTurns","cwd","model","thinking","files"].includes(k))||
          (fields.inheritContext!==undefined&&fields.inheritContext!==false)||(fields.cwd!==undefined&&fields.cwd!==options.cwd?.())||
          (fields.isBackground!==undefined&&typeof fields.isBackground!=="boolean")||(fields.description!==undefined&&(typeof fields.description!=="string"||Buffer.byteLength(fields.description)>512)))throw Error("unsupported_request");
        if(cancelled.has(raw.requestId)||requests.has(raw.requestId)||preparing.has(raw.requestId))throw Error("cancelled_or_duplicate_request");
        if(preparing.size>=32)throw Error("request_preparation_capacity");
        preparing.add(raw.requestId);reserved=true;
        const request:StartRequest={prompt:raw.prompt,role:raw.type,...(raw.type==="Explore"?{evaluator:true,maxTurns:2}:fields.maxTurns!==undefined?{maxTurns:fields.maxTurns}:{}),
          ...(fields.model!==undefined?{model:fields.model}:{}),...(fields.thinking!==undefined?{thinking:fields.thinking}:{}),...(fields.files!==undefined?{files:fields.files}:{})};
        const receipt=await options.start(request,{type:raw.type,description:fields.description??raw.type,isBackground:fields.isBackground??true,requestId:raw.requestId});
        if(!receipt.ok){reply({success:false,error:receipt.code});return;}
        announce(receipt,{type:raw.type,description:fields.description??raw.type,isBackground:fields.isBackground??true,requestId:raw.requestId});
        if(!live||cancelled.has(raw.requestId))await options.supervisor.control({version:1,operation:"close",threadId:receipt.threadId,expectedRunId:receipt.runId});
        reply({success:true,data:{id:receipt.agentId,threadId:receipt.threadId,runId:receipt.runId}});
      }catch{reply({success:false,error:"unsupported_or_stale_request"});}
      finally{if(reserved)preparing.delete(raw.requestId);}
    }));
  }
  return {announce,control,consume(runId:string){outbox.delete(runId);runs.delete(runId);},pending:()=>[...outbox.values()],get:(id:string)=>records.get(id),
    dispose(){live=false;for(const unsub of subscriptions)unsub();outbox.clear();early.clear();records.clear();runs.clear();requests.clear();cancelled.clear();preparing.clear();}};
}
