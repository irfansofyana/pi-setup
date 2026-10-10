import {randomUUID}from"node:crypto";
import type{StartRequest}from"./supervisor.ts";
export type Schedule={kind:"once";at:number}|{kind:"interval";everyMs:number}|{kind:"cron";expression:string;timezone:"UTC"};
type Launch={runId:string;threadId:string;done:Promise<unknown>};
type Job={id:string;schedule:Schedule;request:StartRequest;state:"scheduled"|"paused"|"completed";next:number;active?:Launch;stopRequested?:boolean;error?:string;timer?:any};
type Clock={now():number;set(fn:()=>void,delay:number):any;clear(timer:any):void};
function cron(expression:string){
 const bounds=[[0,59],[0,23],[1,31],[1,12],[0,6]],fields=expression.trim().split(/\s+/);if(fields.length!==5||expression.length>128)throw Error("invalid cron");
 return fields.map((field,index)=>{const result=new Set<number>();for(const item of field.split(",")){
  const match=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);if(!match)throw Error("invalid cron");
  const [min,max]=bounds[index],step=match[2]?Number(match[2]):1;const [start,end]=match[1]==="*"?[min,max]:match[1].includes("-")?match[1].split("-").map(Number):[Number(match[1]),Number(match[1])];
  if(step<1||step>max+1||start<min||end>max||start>end)throw Error("invalid cron");for(let n=start;n<=end;n+=step)result.add(n);
 }return result;});
}
function nextCron(schedule:Extract<Schedule,{kind:"cron"}>,now:number){
 const fields=cron(schedule.expression),raw=schedule.expression.trim().split(/\s+/);let at=(Math.floor(now/60000)+1)*60000;
 for(let i=0;i<527040;i++,at+=60000){const d=new Date(at),day=fields[2].has(d.getUTCDate()),week=fields[4].has(d.getUTCDay());
  if(fields[0].has(d.getUTCMinutes())&&fields[1].has(d.getUTCHours())&&fields[3].has(d.getUTCMonth()+1)&&
   (raw[2]==="*"?week:raw[4]==="*"?day:day||week))return at;
 }throw Error("invalid cron: no fire within 366 days");
}
export function createScheduler(options:{enabled:boolean;clock?:Clock;launch:(request:StartRequest)=>Promise<Launch>;stop:(run:Launch)=>Promise<void>;lease?:()=>Promise<void>;changed?:()=>void}){
 const clock=options.clock??{now:Date.now,set:setTimeout,clear:clearTimeout},jobs=new Map<string,Job>();let disposed=false;
 const notify=()=>{try{options.changed?.();}catch{}};
 const next=(schedule:Schedule,now:number)=>schedule.kind==="once"?schedule.at:schedule.kind==="interval"?now+schedule.everyMs:nextCron(schedule,now);
 function arm(job:Job){if(disposed||job.state!=="scheduled")return;job.timer=clock.set(()=>{job.timer=undefined;if(job.next>clock.now()){arm(job);return;}void fire(job);},Math.max(0,Math.min(2147483647,job.next-clock.now())));}
 async function fire(job:Job){
  if(disposed||job.state!=="scheduled")return;
  if(job.schedule.kind==="once")job.state="completed";else{job.next=next(job.schedule,clock.now());arm(job);}
  if(job.active)return;
  // Reserve before asynchronous admission; pause/dispose after admission closes the
  // late run through the same supervisor, never an untracked execution pool.
  const placeholder:Launch={runId:"",threadId:"",done:Promise.resolve()};job.active=placeholder;
  try{await options.lease?.();if(disposed||job.state==="paused"){job.active=undefined;return;}
   const run=await options.launch(structuredClone(job.request));job.active=run;
   if(disposed||job.stopRequested)await options.stop(run);
   await run.done;
  }catch{job.error="launch_failed_or_backpressured";job.state="paused";if(job.timer!==undefined)clock.clear(job.timer);job.timer=undefined;}
  finally{job.active=undefined;job.stopRequested=false;notify();}
 }
 function add(input:{schedule:Schedule;request:StartRequest;id?:string},restored=false){
  if(!options.enabled||disposed)throw Error("scheduler disabled");if(jobs.size>=32)throw Error("scheduler capacity");
  const schedule=structuredClone(input.schedule),request=structuredClone(input.request);
  if(!schedule||!["once","interval","cron"].includes(schedule.kind)||!request||!["researcher","code-mapper","builder","reviewer"].includes(request.role!)||typeof request.prompt!=="string"||!request.prompt.trim()||Buffer.byteLength(JSON.stringify(request))>65536)throw Error("invalid schedule request");
  const allowed=schedule.kind==="once"?["kind","at"]:schedule.kind==="interval"?["kind","everyMs"]:["kind","expression","timezone"];
  if(Object.keys(schedule).some(key=>!allowed.includes(key))||Object.keys(request).some(key=>!["role","prompt","files","maxTurns","model","thinking"].includes(key)))throw Error("invalid schedule request");
  if(schedule.kind==="once"&&(!Number.isSafeInteger(schedule.at)||schedule.at<0||(!restored&&schedule.at<=clock.now())))throw Error("invalid one-shot");
  if(schedule.kind==="interval"&&(!Number.isSafeInteger(schedule.everyMs)||schedule.everyMs<1000||schedule.everyMs>31536000000))throw Error("invalid interval");
  if(schedule.kind==="cron"&&(schedule.timezone!=="UTC"||typeof schedule.expression!=="string"))throw Error("invalid timezone");
  const id=input.id??randomUUID();if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||jobs.has(id))throw Error("invalid job id");
  const job:Job={id,schedule,request,state:restored?"paused":"scheduled",next:next(schedule,clock.now())};jobs.set(id,job);arm(job);notify();return snapshot(job);
 }
 function snapshot(job:Job){return structuredClone({id:job.id,schedule:job.schedule,request:job.request,state:job.state,next:job.next,activeRunId:job.active?.runId,error:job.error});}
 function find(id:string){const job=jobs.get(id);if(!job)throw Error("unknown job");return job;}
 return {add,restore(input:any){if(!input||!["scheduled","paused","completed"].includes(input.state))throw Error("invalid restored job");const result=add({id:input.id,schedule:input.schedule,request:input.request},true);const job=find(result.id);if(input.state==="completed")job.state="completed";if(input.activeRunId)job.error="orphaned_run_no_live_context";return snapshot(job);},
  list:()=>[...jobs.values()].map(snapshot),pause(id:string){const job=find(id);job.state="paused";if(job.timer!==undefined)clock.clear(job.timer);job.timer=undefined;notify();},
  resume(id:string){if(disposed)throw Error("scheduler disabled");const job=find(id);if(job.state!=="paused")throw Error("job not paused");job.next=next(job.schedule,clock.now());if(job.next<=clock.now())throw Error("missed one-shot requires explicit replacement");job.state="scheduled";arm(job);notify();},
  async stopActive(id:string){const job=find(id);job.stopRequested=true;const run=job.active;if(run?.runId)await options.stop(run);},
  dispose(){disposed=true;for(const job of jobs.values()){if(job.timer!==undefined)clock.clear(job.timer);job.timer=undefined;if(job.state==="scheduled")job.state="paused";}notify();},
 };
}
