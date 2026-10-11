import{displayText}from"./presentation.ts";
type UI={select(title:string,choices:string[]):Promise<string|undefined>;input(title:string,hint?:string):Promise<string|undefined>;confirm(title:string,message:string):Promise<boolean>;notify(text:string,level?:string):void};
/** Human-only controls. No model tool accepts a `confirmed: true` shortcut. */
export async function humanMenu(topic:string,ui:UI,driver:any){
 const show=async(value:unknown)=>{await ui.select(displayText(JSON.stringify(value,null,2),16000),["Back"]);};
 if(topic==="results"){
  const results=driver.results();const choice=await ui.select("Retained outcomes (restart cannot restore a conversation)",results.map((entry:any)=>`${entry.result.runId} | ${entry.result.outcome} | ${entry.consumed?"consumed":"unconsumed"}`));
  const entry=results.find((entry:any)=>choice?.startsWith(`${entry.result.runId} |`));if(!entry)return;
  await show(entry);if(await ui.confirm("Consume outcome?","This marks the outcome and matching notification disposable; it does not remove its worktree."))await driver.consume(entry.result.runId);return;
 }
 if(topic==="notifications"){await show(driver.notifications());return;}
 if(topic==="jobs"){
  const jobs=driver.jobs("list",{}).jobs;
  const choice=await ui.select("Schedules: restored jobs are paused; Pi must remain open",["Create from JSON",...jobs.map((job:any)=>`${job.id} | ${job.state}`)]);
  if(choice==="Create from JSON"){const text=await ui.input("Schedule + request JSON","{\"schedule\":{\"kind\":\"interval\",\"everyMs\":60000},\"request\":{\"role\":\"reviewer\",\"prompt\":\"Review without changes\"}} ");if(text)await driver.jobs("create",JSON.parse(text));}
  else {const job=jobs.find((job:any)=>choice?.startsWith(`${job.id} |`));if(!job)return;await show(job);
   const action=await ui.select("Job controls (pause does not stop active execution)",["Pause future fires","Resume future fires","Stop active run"]);if(action)await driver.jobs({"Pause future fires":"pause","Resume future fires":"resume","Stop active run":"stop_active"}[action],{job_id:job.id});}
  await driver.flush();return;
 }
 if(topic==="workflows"){
  const workflows=driver.workflow("list",{});
  const choice=await ui.select("Declarative workflows",["Start from JSON",...workflows.map((workflow:any)=>`${workflow.id} | ${workflow.state}`)]);
  if(choice==="Start from JSON"){const text=await ui.input("Version 1 workflow plan JSON");if(text)await driver.workflow("start",{plan:JSON.parse(text)});await driver.flush();return;}
  const workflow=workflows.find((workflow:any)=>choice?.startsWith(`${workflow.id} |`));if(!workflow)return;await show(workflow);
  const action=await ui.select("Workflow controls",["Pause","Resume","Retry step","Skip step","Verify step","Cancel"]);if(!action)return;
  if(["Retry step","Skip step","Verify step"].includes(action)){
   const stepId=await ui.select("Select step",workflow.steps.filter((step:any)=>action==="Verify step"?step.state==="verification_requested":action==="Retry step"?step.state==="failed":["pending","failed","verification_requested"].includes(step.state)).map((step:any)=>step.definition.id));if(!stepId)return;
   if(action==="Verify step"){const decision=await ui.select("Your manual verification decision",["Reject","Accept"]);if(!decision)return;const proof=await ui.input("Record your verification evidence","What you checked and the observed outcome (no secrets)");if(proof)driver.verify(workflow.id,stepId,{accepted:decision==="Accept",proof});}
   else await driver.workflow(action==="Retry step"?"retry":"skip",{workflow_id:workflow.id,step_id:stepId});
  }else await driver.workflow(action.toLowerCase(),{workflow_id:workflow.id});
  await driver.flush();return;
 }
 throw Error("Unknown native subagent view");
}
