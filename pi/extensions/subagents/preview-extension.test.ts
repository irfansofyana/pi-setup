import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerPreview,registerNative } from "./preview-extension.ts";

test("exclusive preview registers tools/UI, executes a native child, reads result and closes without provider network", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-sdk-"));
  const saved = {dir:process.env.PI_CODING_AGENT_DIR,profile:process.env.PI_SETUP_SUBAGENTS_PROFILE,preview:process.env.PI_SETUP_SUBAGENTS_PREVIEW};
  process.argv.push("--no-extensions");
  try {
    process.env.PI_CODING_AGENT_DIR=root; process.env.PI_SETUP_SUBAGENTS_PROFILE=join(root,"subagents-preview.json");
    await mkdir(join(root,"agents")); await copyFile(new URL("../../agents/researcher.md",import.meta.url),join(root,"agents/researcher.md"));
    await writeFile(join(root,"settings.json"),JSON.stringify({packages:[],extensions:[]}));
    await writeFile(process.env.PI_SETUP_SUBAGENTS_PROFILE,JSON.stringify({version:1,agentDir:root,routing:"native",skillPaths:{},persist:true,workflows:true,schedules:true}));
    await writeFile(join(root,"subagents-native.json"),JSON.stringify({version:1,enabled:true,routing:"native"}));
    await writeFile(join(root,"settings.json"),JSON.stringify({packages:["npm:@tintinweb/pi-subagents@0.14.3"],extensions:[]}));
    await assert.rejects(registerNative(new Proxy({},{get(){throw Error("registration touched before conflict gate");}})as any),/companion conflict/);
    await writeFile(join(root,"settings.json"),JSON.stringify({packages:[],extensions:[]}));
    process.env.PI_SETUP_SUBAGENTS_PREVIEW="1";
    const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:SettingsManager.inMemory({}),noExtensions:true,noSkills:true,noContextFiles:true,noThemes:true,noPromptTemplates:true,additionalExtensionPaths:[new URL("./index.ts",import.meta.url).pathname],disabledBuiltinExtensions:["mcp","codemode","tool-search"]});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors,[]);
    assert.equal(loader.getExtensions().extensions.length,1);
    assert.deepEqual([...loader.getExtensions().extensions[0].tools.keys()].sort(),["Agent","get_subagent_result","steer_subagent","subagent_control","subagent_wait","subagent_start","subagent_job","subagent_workflow"].sort());
    const tools = new Map<string,any>(), commands = new Map<string,any>(), events = new Map<string,any>();
    await registerPreview({registerTool:t=>tools.set(t.name,t),registerCommand:(n,c)=>commands.set(n,c),on:(n,h)=>events.set(n,h)} as any);
    assert.equal(commands.has("agents"),true);
    const model:any={id:"chosen",provider:"fixture",name:"Fixture",api:"fixture",baseUrl:"offline://fixture",input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},reasoning:false,contextWindow:32768,maxTokens:1024};
    let requests=0;
    const stream = () => {requests++; const s=createAssistantMessageEventStream(); queueMicrotask(()=>{
      const m:any={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"text",text:"Preview works"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
      s.push({type:"start",partial:m});s.push({type:"text_delta",contentIndex:0,delta:"Preview works",partial:m});s.push({type:"done",reason:"stop",message:m}); });return s;};
    const original={id:"fixture",name:"Fixture",stream,streamSimple:stream};
    let status="";
    const ctx:any={cwd:root,model,hasUI:true,ui:{notify(){},setStatus(_key,text){status=text??"";},setWidget(){}},modelRegistry:{getAvailable:()=>[model],find:()=>model,getProvider:()=>original,getApiKeyAndHeaders:async()=>({ok:true,apiKey:"fixture-not-a-real-key"})}};
    const answer=await tools.get("Agent").execute("call",{prompt:"Say hello without tools",description:"fixture",subagent_type:"researcher",run_in_background:true},undefined,undefined,ctx);
    assert.equal(answer.details.ok,true,JSON.stringify(answer.details));
    const result=await tools.get("get_subagent_result").execute("result",{agent_id:answer.details.agentId,wait:true},undefined,undefined,ctx);
    assert.equal(result.details[0].outcome,"completed");assert.equal(result.details[0].text,"Preview works");assert.equal(requests,1);
    const next=await tools.get("subagent_control").execute("next",{version:1,operation:"follow_up",threadId:answer.details.threadId,expectedRunId:answer.details.runId,message:"Continue"});
    await tools.get("subagent_wait").execute("wait",{run_ids:[next.details.runId]},undefined,undefined,ctx);
    for(const operation of ["result","consume"]){
      await tools.get("subagent_control").execute("historical",{version:1,operation,threadId:answer.details.threadId,expectedRunId:answer.details.runId});
      const current=await tools.get("get_subagent_result").execute("current",{agent_id:answer.details.agentId,wait:false},undefined,undefined,ctx);
      assert.equal(current.details.runId,next.details.runId,`${operation} must not retarget latest run`);
    }
    const workflow=await tools.get("subagent_workflow")?.execute("workflow",{action:"start",plan:{version:1,steps:[{id:"research",role:"researcher",prompt:"Answer without tools",maxTurns:1}]}},undefined,undefined,ctx);
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
    assert.equal(close.details.status,"handled");await events.get("session_shutdown")();
    const persisted=JSON.parse(await (await import("node:fs/promises")).readFile(join(root,"subagents-state","state.json"),"utf8"));
    assert.ok(persisted.data.results.some((item:any)=>item.result?.runId===answer.details.runId));
    assert.equal(persisted.data.workflows.find((item:any)=>item.id===workflow.details.id).state,"completed");
  } finally {
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
