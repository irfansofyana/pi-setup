import {stripVTControlCharacters}from"node:util";
/** Text-only views: theme/editor retain input ownership, no idle polling. */
export function displayText(value:unknown,cap=160){return stripVTControlCharacters(String(value??"")).replace(/[\x00-\x1f\x7f-\x9f]/g," ").slice(0,cap);}
export function fleetLines(main:{model?:string},workers:any[]){
 return [`main | ${displayText(main.model??"unassigned")}`,...workers.slice(0,16).map(worker=>{
  const s=worker.snapshot;
  return `${displayText(worker.id,48)} | ${displayText(worker.role,32)} | ${displayText(worker.model??"unassigned",64)} | ${s?.state??"retained"} | turns ${s?.turns??0}/${s?.budget?.hardTurns??"?"} | ${s?.usage?.totalTokens??"?"} tokens | ${displayText(worker.task,100)}`;
 })];
}
export function activityDetail(event:any):string{
 if(event?.type==="message_update"&&event.assistantMessageEvent?.type==="text_delta")return String(event.assistantMessageEvent.delta??"");
 if(!event?.type?.startsWith("tool_execution_"))return "";
 let detail;try{detail=JSON.stringify({args:event.args,partial:event.partialResult,result:event.result});}catch{detail="[unserializable detail]";}
 const points=Array.from(stripVTControlCharacters(detail??""));let used=0,kept="";
 for(const point of points){used+=Buffer.byteLength(point);if(used>3500)break;kept+=point;}
 return `\n[${displayText(event.type)}: ${displayText(event.toolName??event.toolCallId??"tool")}]\n${kept}${used>3500?"\n[tool detail truncated]":""}\n`;
}
