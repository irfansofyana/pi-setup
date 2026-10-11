import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerPreview,registerNative } from "./preview-extension.ts";
import { publishChildRouting } from "../headroom/child-route.ts";
import { CostLedger,COST_ENTRY } from "./upstream/src/orch/cost-ledger.ts";

test("exclusive preview registers tools/UI, executes a native child, reads result and closes without provider network", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-sdk-"));
  const saved = {dir:process.env.PI_CODING_AGENT_DIR,profile:process.env.PI_SETUP_SUBAGENTS_PROFILE,preview:process.env.PI_SETUP_SUBAGENTS_PREVIEW};
  process.argv.push("--no-extensions");
  let releaseRoute: (() => void) | undefined;
  let shutdown: (()=>Promise<void>) | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR=root; process.env.PI_SETUP_SUBAGENTS_PROFILE=join(root,"subagents-preview.json");
    await mkdir(join(root,"agents")); await copyFile(new URL("../../agents/researcher.md",import.meta.url),join(root,"agents/researcher.md"));
    await mkdir(join(root,"subagent-manager","agents"),{recursive:true});
    await writeFile(join(root,"subagent-manager","agents","worker.md"),"---\nname: worker\ndescription: Custom general helper\ntools:\n  allow: [read]\n---\nAnswer only the assigned task.\n");
    await writeFile(join(root,"settings.json"),JSON.stringify({packages:[],extensions:[]}));
    await writeFile(process.env.PI_SETUP_SUBAGENTS_PROFILE,JSON.stringify({version:1,agentDir:root,routing:"headroom-preferred",skillPaths:{},persist:true,workflows:true,schedules:true}));
    await writeFile(join(root,"subagents-native.json"),JSON.stringify({version:1,enabled:true,routing:"native"}));
    await writeFile(join(root,"settings.json"),JSON.stringify({packages:["npm:@tintinweb/pi-subagents@0.14.3"],extensions:[]}));
    await assert.rejects(registerNative(new Proxy({},{get(){throw Error("registration touched before conflict gate");}})as any),/companion conflict/);
    await writeFile(join(root,"settings.json"),JSON.stringify({packages:[],extensions:[]}));
    process.env.PI_SETUP_SUBAGENTS_PREVIEW="1";
    const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:SettingsManager.inMemory({}),noExtensions:true,noSkills:true,noContextFiles:true,noThemes:true,noPromptTemplates:true,additionalExtensionPaths:[new URL("./index.ts",import.meta.url).pathname],disabledBuiltinExtensions:["mcp","codemode","tool-search"]});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors,[]);
    assert.equal(loader.getExtensions().extensions.length,1);
    assert.deepEqual([...loader.getExtensions().extensions[0].tools.keys()].sort(),["Agent","get_subagent_result","steer_subagent","subagent_control","subagent_wait","subagent_start","subagent_job","subagent_workflow","agent_types","agent_spawn","agent_wait","agent_steer","agent_status","agent_stop","agent_output"].sort());
    const tools = new Map<string,any>(), commands = new Map<string,any>(), events = new Map<string,any>();
    const shortcuts = new Map<string,any>(), deliveries:any[]=[],entries:any[]=[]; let editorReplaced = 0;
    await registerPreview({registerTool:t=>tools.set(t.name,t),registerCommand:(n,c)=>commands.set(n,c),registerShortcut:(n,c)=>shortcuts.set(n,c),on:(n,h)=>events.set(n,h),sendMessage:(message,options)=>deliveries.push({message,options}),appendEntry:(customType,data)=>entries.push({type:"custom",customType,data})} as any);
    shutdown=()=>events.get("session_shutdown")();
    assert.equal(commands.has("agents"),true);
    const model:any={id:"chosen",provider:"fixture",name:"Fixture",api:"fixture",baseUrl:"offline://fixture",input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},reasoning:false,contextWindow:32768,maxTokens:1024};
    const changedModel = { ...model, id: "changed" };
    let requests=0;
    const transports:any[]=[];let routeReady=true,authKey="fixture-not-a-real-key",hanging=false;const warnings:string[]=[];
    const stream = (target:any,_context:any,options:any) => {transports.push({target,options});requests++; const s=createAssistantMessageEventStream(); queueMicrotask(()=>{
      if(JSON.stringify(_context.messages.at(-1)).includes("Record spend and wait")){
        const partial:any={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
        const interrupted=()=>{s.push({type:"error",reason:"aborted",error:{...partial,stopReason:"aborted",errorMessage:"Cancelled by navigation"}});};
        options.signal.addEventListener("abort",interrupted,{once:true});hanging=true;return;
      }
      const checkpoint=JSON.stringify(_context.messages.at(-1)).includes("Please checkpoint");
      const delegate=JSON.stringify(_context.messages.at(-1)).includes("Coordinate offline delegation");
      const spending=JSON.stringify(_context.messages.at(-1)).includes("Spend then hold");
      const m:any={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:checkpoint?[{type:"toolCall",id:"checkpoint-1",name:"agent_pause",arguments:{reason:"Need parent decision"}}]:delegate?[{type:"toolCall",id:"delegate-1",name:"agent_spawn",arguments:{path:"child",type:"worker",task:"Fresh nested child"}}]:spending?[{type:"toolCall",id:"spend-1",name:"agent_update",arguments:{message:"Record spend and wait"}}]:[{type:"text",text:"Preview works"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0.005,output:0.005,cacheRead:0,cacheWrite:0,total:0.01}},stopReason:checkpoint||delegate||spending?"toolUse":"stop",timestamp:Date.now()};
      s.push({type:"start",partial:m});if(!checkpoint&&!delegate&&!spending)s.push({type:"text_delta",contentIndex:0,delta:"Preview works",partial:m});s.push({type:"done",reason:m.stopReason,message:m}); });return s;};
    const original={id:"fixture",name:"Fixture",stream,streamSimple:stream};
    let status="";
    const ctx:any={cwd:root,model,hasUI:true,ui:{notify(message,level){if(level==="warning")warnings.push(message);},setStatus(_key,text){status=text??"";},setWidget(){},setEditorComponent(){editorReplaced++;},getEditorComponent:()=>()=>({})},modelRegistry:{getAvailable:()=>[model,changedModel],find:(_provider,id)=>[model,changedModel].find(m=>m.id===id),getProvider:()=>original,getApiKeyAndHeaders:async()=>({ok:true,apiKey:authKey,headers:{"x-auth-fixture":authKey}})}};
    ctx.sessionManager={getSessionId:()=>"root-fixture",getEntries:()=>entries};
    releaseRoute=publishChildRouting(ctx.modelRegistry,{canonical:(_provider,id)=>[model,changedModel].find(m=>m.id===id),route:async()=>routeReady?{baseUrl:"http://127.0.0.1:8787/v1"}:undefined});
    const types=await tools.get("agent_types").execute("types",{},undefined,undefined,ctx);
    assert.deepEqual(types.details.map((type:any)=>type.name).sort(),["builder","researcher","reviewer","scout","worker"]);
    await commands.get("agents").handler("reload",ctx);
    assert.equal(warnings.some(message=>/Use \/agents/.test(message)),false);
    const answer=await tools.get("Agent").execute("call",{prompt:"Say hello without tools",description:"fixture",subagent_type:"researcher",run_in_background:true},undefined,undefined,ctx);
    assert.equal(answer.details.ok,true,JSON.stringify(answer.details));
    const result=await tools.get("get_subagent_result").execute("result",{agent_id:answer.details.agentId,wait:true},undefined,undefined,ctx);
    assert.equal(result.details[0].outcome,"completed");assert.equal(result.details[0].text,"Preview works");assert.equal(requests,1);
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(deliveries.filter(item=>item.options.triggerTurn).length,1,"a detached completion wakes the parent");
    assert.ok(deliveries.every(item=>item.message.display===false));
    const grant=await tools.get("subagent_control").execute("grant",{version:1,operation:"extend_budget",threadId:answer.details.threadId,expectedRunId:answer.details.runId,additionalTurns:1},undefined,undefined,ctx);
    assert.equal(grant.details.status,"handled");
    const extended=await tools.get("get_subagent_result").execute("extended",{agent_id:answer.details.agentId,wait:false},undefined,undefined,ctx);
    assert.equal(extended.details.budget.softTurns,21);assert.equal(extended.details.turns,1);
    assert.equal(transports[0].target.baseUrl,"http://127.0.0.1:8787/v1");
    routeReady=false;authKey="fixture-refreshed";
    const next=await tools.get("subagent_control").execute("next",{version:1,operation:"follow_up",threadId:answer.details.threadId,expectedRunId:answer.details.runId,message:"Continue"});
    await tools.get("subagent_wait").execute("wait",{run_ids:[next.details.runId]},undefined,undefined,ctx);
    assert.equal(transports[1].target.baseUrl,"offline://fixture");assert.equal(transports[1].options.apiKey,"fixture-refreshed");
    assert.equal(transports[1].options.headers["x-auth-fixture"],"fixture-refreshed");assert.ok(warnings.some(message=>/direct upstream/.test(message)));
    for(const operation of ["result","consume"]){
      await tools.get("subagent_control").execute("historical",{version:1,operation,threadId:answer.details.threadId,expectedRunId:answer.details.runId});
      const current=await tools.get("get_subagent_result").execute("current",{agent_id:answer.details.agentId,wait:false},undefined,undefined,ctx);
      assert.equal(current.details.runId,next.details.runId,`${operation} must not retarget latest run`);
    }
    const workflow=await tools.get("subagent_workflow")?.execute("workflow",{action:"start",plan:{version:1,steps:[{id:"general",role:"worker",prompt:"Answer without tools",maxTurns:1}]}},undefined,undefined,ctx);
    assert.equal(workflow?.details.state,"running");
    for(let i=0;i<20;i++)await new Promise<void>(r=>setImmediate(r));
    let completed:any;for(let i=0;i<20;i++){completed=await tools.get("subagent_workflow")?.execute("inspect",{action:"inspect",workflow_id:workflow.details.id},undefined,undefined,ctx);if(completed?.details.state==="completed")break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(completed?.details.state,"completed");
    for(let index=0;index<4;index++){
      const automatic=await tools.get("subagent_workflow").execute("auto",{action:"start",plan:{version:1,steps:[{id:"task",role:"researcher",prompt:"Automatic task",maxTurns:1}]}},undefined,undefined,ctx);
      for(let attempt=0;attempt<40;attempt++){
        const view=await tools.get("subagent_workflow").execute("inspect",{action:"inspect",workflow_id:automatic.details.id},undefined,undefined,ctx);
        if(view.details.state==="completed")break;await new Promise(resolve=>setTimeout(resolve,10));
      }
    }
    assert.equal(status,"agents: 0 active","automatically closed/consumed workers must not accumulate as missing active records");
    const close=await tools.get("subagent_control").execute("close",{version:1,operation:"close",threadId:answer.details.threadId,expectedRunId:answer.details.runId});
    assert.equal(close.details.status,"handled");
    const named=await tools.get("agent_spawn").execute("named",{path:"named-task",type:"researcher",task:"Answer without tools"},undefined,undefined,ctx);
    assert.equal(named.details.path,"/root/named-task"); assert.equal(named.details.state,"completed");
    const statusView=await tools.get("agent_status").execute("status",{},undefined,undefined,ctx);
    assert.equal(statusView.details.length,1);
    const output=await tools.get("agent_output").execute("out",{path:"named-task"},undefined,undefined,ctx);
    assert.equal(output.details.text,"Preview works");
    const beforeResume=requests;
    await tools.get("agent_steer").execute("resume-named",{path:"named-task",message:"Continue the named task"},undefined,undefined,ctx);
    const settled=await tools.get("agent_wait").execute("wait-named",{path:"named-task"},undefined,undefined,ctx);
    assert.equal(settled.details.state,"completed");assert.equal(requests,beforeResume+1);
    const costs=entries.filter(entry=>entry.customType===COST_ENTRY),id=named.details.costId;
    assert.deepEqual(costs.filter(entry=>entry.data.threadId===id).map(entry=>entry.data.totalUsd),[0.01,0.02],"same-session SDK continuation advances one settled cost identity");
    const restoredCosts=new CostLedger();restoredCosts.restore([...entries,...entries]);
    const expected=Object.values(Object.fromEntries(costs.map(entry=>[entry.data.threadId,entry.data.totalUsd]))).reduce((sum:number,cost:any)=>sum+cost,0);
    assert.equal(restoredCosts.totalUsd,expected,"replaying root branch records cannot double count reaped/closed SDK work");
    const custom=await tools.get("agent_spawn").execute("custom",{path:"general-task",type:"worker",task:"Answer a general question"},undefined,undefined,ctx);
    assert.equal(custom.details.state,"completed");assert.equal(custom.details.type,"worker");
    const changedCtx = { ...ctx, model: changedModel, thinkingLevel: "low" };
    const changedTypes = await tools.get("agent_types").execute("types-changed",{},undefined,undefined,changedCtx);
    assert.equal(changedTypes.details.find(type=>type.name==="worker").model,"fixture/changed");
    assert.equal(changedTypes.details.find(type=>type.name==="worker").thinkingLevel,"low","unset custom thinking follows the current parent");
    const changed = await tools.get("agent_spawn").execute("changed",{path:"changed-model",type:"worker",task:"Use the current parent model"},undefined,undefined,changedCtx);
    assert.equal(changed.details.state,"completed");
    assert.equal(changed.details.thinkingLevel,"low");
    assert.equal(transports.at(-1).target.id,"changed","new admissions must follow a parent model change");
    assert.equal(editorReplaced,0,"agent UI must preserve the theme's editor slot");
    assert.equal(shortcuts.has("ctrl+shift+a"),true,"tree navigation has a cooperative shortcut");
    const beforePause=requests;
    const paused=await tools.get("agent_spawn").execute("pause",{path:"checkpoint",type:"worker",task:"Please checkpoint"},undefined,undefined,ctx);
    assert.equal(paused.details.state,"paused");assert.equal(paused.details.output,undefined);assert.equal(requests,beforePause+1);
    await tools.get("agent_steer").execute("continue",{path:"checkpoint",message:"Decision supplied; continue"},undefined,undefined,ctx);
    const resumed=await tools.get("agent_wait").execute("resume-wait",{path:"checkpoint"},undefined,undefined,ctx);
    assert.equal(resumed.details.state,"completed");assert.equal(requests,beforePause+2);
    const guide=await events.get("before_agent_start")({systemPrompt:"Parent system",prompt:"New task"},ctx);
    assert.match(guide.systemPrompt,/Opportunistic mode/);
    assert.match(guide.systemPrompt,/fresh-context/);
    assert.doesNotMatch(guide.systemPrompt,/forks the lexical/);
    await writeFile(join(root,"subagent-manager","settings.json"),JSON.stringify({subagentMode:"orchestration"}));
    await commands.get("agents").handler("reload",ctx);
    assert.match((await events.get("before_agent_start")({systemPrompt:"Parent system",prompt:"New task"},ctx)).systemPrompt,/Orchestration mode/);
    // Spend on a tool exchange, then hold the following provider request until
    // navigation interrupts it. Earlier settled spend already exists for this ID.
    await tools.get("agent_steer").execute("active-continuation",{path:"named-task",message:"Spend then hold"},undefined,undefined,ctx);
    for(let attempt=0;attempt<100&&!hanging;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(hanging,true);
    await writeFile(join(root,"subagent-manager","settings.json"),JSON.stringify({subagentMode:"off"}));
    await commands.get("agents").handler("reload",ctx);
    assert.equal(await events.get("before_agent_start")({systemPrompt:"Parent system",prompt:"New task"},ctx),undefined);
    assert.ok([...tools.values()].every(tool=>tool.exposure==="hidden"));
    await assert.rejects(tools.get("agent_types").execute("off",{},undefined,undefined,ctx),/Mode is off/);
    for(const event of ["session_before_tree","session_before_switch","session_before_fork"])assert.equal(typeof events.get(event),"function","old generation drains before changing the root branch/session");
    await events.get("session_before_tree")({},ctx);
    assert.equal(entries.filter(entry=>entry.customType===COST_ENTRY&&entry.data.threadId===id).at(-1)?.data.totalUsd,0.03,"navigation persists newly incurred usage after interrupting an active continuation");
    await events.get("session_tree")({},ctx);
    await writeFile(join(root,"subagent-manager","settings.json"),JSON.stringify({subagentMode:"opportunistic"}));
    await commands.get("agents").handler("reload",ctx);
    assert.deepEqual((await tools.get("agent_status").execute("new-generation",{},undefined,undefined,ctx)).details,[],"branch attach never pretends saved outcomes restore live sessions");
    const independent=await tools.get("agent_spawn").execute("independent",{path:"/independent",type:"worker",task:"Fresh branch-independent task"},undefined,undefined,ctx);
    assert.equal(independent.details.state,"completed");assert.equal(independent.details.parent,null);
    await writeFile(join(root,"subagent-manager","agents","coordinator.md"),"---\nname: coordinator\ndescription: Custom bounded coordinator\ntools:\n  allow: [agent_spawn, agent_status]\n---\nDelegate only explicitly assigned bounded tasks.\n");
    await commands.get("agents").handler("reload",ctx);
    const coordinated=await tools.get("agent_spawn").execute("coordinate",{path:"coordinator",type:"coordinator",task:"Coordinate offline delegation"},undefined,undefined,ctx);
    assert.equal(coordinated.details.state,"completed");
    const tree=await tools.get("agent_status").execute("nested-status",{},undefined,undefined,ctx);
    assert.equal(tree.details.find(thread=>thread.path==="/root/coordinator/child")?.state,"completed","native SDK custom delegation cannot deadlock the sole preview permit");
    await writeFile(join(root,"subagent-manager","agents","worker.md"),"---\nname: worker\ndescription: Custom general helper\nmodels: [fixture/chosen]\ntools:\n  allow: [read]\n---\nAnswer only the assigned task.\n");
    await commands.get("agents").handler("reload",ctx);
    const overridden=await tools.get("agent_spawn").execute("explicit-model",{path:"explicit-model",type:"worker",task:"Use invocation model",model:"fixture/changed"},undefined,undefined,ctx);
    assert.equal(overridden.details.state,"completed",JSON.stringify(overridden.details));
    assert.equal(overridden.details.model,"fixture/changed","explicit invocation overrides saved model preference");
    await events.get("session_shutdown")();
    const persisted=JSON.parse(await (await import("node:fs/promises")).readFile(join(root,"subagents-state","state.json"),"utf8"));
    assert.ok(persisted.data.results.some((item:any)=>item.result?.runId===answer.details.runId));
    assert.equal(persisted.data.workflows.find((item:any)=>item.id===workflow.details.id).state,"completed");
  } finally {
    await shutdown?.();
    releaseRoute?.();
    process.argv.splice(process.argv.lastIndexOf("--no-extensions"),1);
    if(saved.dir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=saved.dir;
    if(saved.profile===undefined)delete process.env.PI_SETUP_SUBAGENTS_PROFILE;else process.env.PI_SETUP_SUBAGENTS_PROFILE=saved.profile;
    if(saved.preview===undefined)delete process.env.PI_SETUP_SUBAGENTS_PREVIEW;else process.env.PI_SETUP_SUBAGENTS_PREVIEW=saved.preview;
    await rm(root,{recursive:true,force:true});
  }
});

test("preview refuses registration without exclusive CLI discovery gate",async()=>{
  const previous=process.env.PI_SETUP_SUBAGENTS_PROFILE;delete process.env.PI_SETUP_SUBAGENTS_PROFILE;
  try { await assert.rejects(registerPreview(new Proxy({},{get(){throw Error("touched registration");}}) as any),/isolated/); }
  finally {if(previous!==undefined)process.env.PI_SETUP_SUBAGENTS_PROFILE=previous;}
});
