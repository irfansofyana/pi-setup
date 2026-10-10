import { randomUUID } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSupervisor } from "./supervisor.ts";
import { resolveTrustedRole, createTrustedRoleBackend } from "./trusted.ts";
import { parentProvider } from "./parent-provider.ts";
import { committedBase, createWorktree, inspectWorktree,recoverWorktree,discardWorktree,reviewWorktree } from "./worktrees.ts";
import {hasLiveBuilder,pruneRuntimeRecords}from"./runtime-records.ts";
import { Inspector, appendInspector } from "./inspector.ts";
import { createProtocol } from "./protocol.ts";
import { createEvaluatorBackend } from "./backend.ts";
import { validateLegacy } from "./contracts.ts";
import {createOrchestration}from"./orchestration.ts";
import {claimOwner}from"./ownership.ts";
import {fleetLines,activityDetail,displayText}from"./presentation.ts";
import {humanMenu}from"./human-ui.ts";
import {inspectStorageLease,reconcileStorageLease}from"./storage.ts";
import {validateNativeConfig,companionConfigured}from"./config.ts";
import {createDemo}from"./demo.ts";

/** Experimental, exclusive temporary-profile adapter. No live-package cutover. */
export async function registerPreview(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  if (!process.argv.includes("--no-extensions") || process.env.PI_SETUP_SUBAGENTS_PROFILE !== join(agentDir, "subagents-preview.json")) throw Error("Use the isolated subagents preview launcher");
  const config = JSON.parse(await readFile(process.env.PI_SETUP_SUBAGENTS_PROFILE!, "utf8"));
  const approved=[new URL("./index.ts",import.meta.url).pathname,...(config.integration?["goal-loop","loop"].map(name=>new URL(`../${name}/index.ts`,import.meta.url).pathname):[]),...(config.themeUI?[new URL("../../themes/pi-irfan-devs/index.ts",import.meta.url).pathname]:[])];
  for(let i=0;i<process.argv.length;i++)if(["-e","--extension"].includes(process.argv[i])&&!approved.includes(process.argv[i+1]))throw Error("Preview forbids additional extension entrypoints");
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  if (config.version !== 1 || config.agentDir !== agentDir || config.routing !== "native" || settings.packages?.length || settings.extensions?.length) throw Error("Non-exclusive preview profile rejected");
  return registerRuntime(pi,agentDir,{...config,concurrency:1,threads:4,slots:8,pending:4});
}
/** Global user-owned config, never project activation; gate before any registration. */
export async function registerNative(pi:ExtensionAPI){
 const agentDir=getAgentDir(),input=JSON.parse(await readFile(join(agentDir,"subagents-native.json"),"utf8"));
 const config=validateNativeConfig(input);
 for(const path of [join(agentDir,"settings.json"),join(process.cwd(),".pi/settings.json")]){
  let settings;try{settings=JSON.parse(await readFile(path,"utf8"));}catch(error){if((error as any).code==="ENOENT")continue;throw error;}
  if(companionConfigured(settings))throw Error("Native subagents companion conflict: review/disable Tintinweb source first; no tools registered");
 }
 return registerRuntime(pi,agentDir,config);
}
async function registerRuntime(pi:ExtensionAPI,agentDir:string,config:any){
  let supervisor: ReturnType<typeof createSupervisor> | undefined;
  let protocol: ReturnType<typeof createProtocol> | undefined;
  let orchestration:Awaited<ReturnType<typeof createOrchestration>>|undefined;
  let boot:Promise<ReturnType<typeof createSupervisor>>|undefined;
  let ownership:ReturnType<typeof claimOwner>|undefined,ending:Promise<void>|undefined;
  let closingGeneration=false,ownerUI:any;
  const records = new Map<string, { threadId: string; runId: string; role: string;model?:string;task?:string;name?:string }>();
  const receipts=new Map<string,string>();
  const artifacts = new Map<string, any>();
  const activity = new Map<string,string>();
  const viewers = new Set<() => void>();
  const pruneRecords=()=>pruneRuntimeRecords(records,activity,receipts,id=>supervisor?.inspect(id));
  let refreshFleet=()=>{};
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value });
  const initialize = async (ctx: any) => {
    ownership=claimOwner(agentDir);
    closingGeneration=false;ownerUI=ctx.hasUI?ctx.ui:undefined;
    supervisor = createSupervisor({ concurrency:config.concurrency, threads:config.threads, slots:config.slots, pending:config.pending, nextId: randomUUID,evaluatorSupported:true,
      resolveSource:id=>ctx.sessionManager?.getSessionId()===id?ctx.sessionManager:undefined,
      createBackend: async () => { throw Error("Unprepared role"); },
      prepare: async request => {
        const role = request.role!;
        const cwd=ctx.cwd;
        const assignment = request.model ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
        if(role==="Explore"){
          if(!request.evaluator||request.context||request.artifactId||request.files?.length||!assignment||(request.maxTurns!==undefined&&request.maxTurns>2))throw Error("Invalid evaluator loadout");
          const provider=parentProvider(ctx.modelRegistry,assignment);
          if(ctx.scopedModels?.length&&!ctx.scopedModels.some((entry:any)=>`${entry.model.provider}/${entry.model.id}`===assignment))throw Error("Evaluator model outside parent scope");
          return {model:assignment,budget:{softTurns:2,hardTurns:2,elapsedMs:Math.min(config.elapsedMs??120000,120000),maxTokens:config.maxTokens,maxCost:config.maxCost},createBackend:async()=>{const result=await createEvaluatorBackend({agentDir,cwd,model:assignment,provider});if(!result.ok)throw Error(result.code);return result.backend;}};
        }
        const available = { tools: ["read", "grep", "find", "ls", "edit", "write", "ext:web-research/web_search", "ext:web-research/web_fetch", "ext:fff/fffind", "ext:fff/ffgrep", "ext:fff/fff-multi-grep"],
          extensions: ["web-research", ...(config.fffPath ? ["fff"] : [])], skills: ["my-web-search", ...Object.keys(config.skillPaths ?? {})], models: ctx.modelRegistry.getAvailable().map((m: any) => `${m.provider}/${m.id}`) };
        const resolved = await resolveTrustedRole(role, agentDir, available, { model: assignment, routing: "native", maxTurns: request.maxTurns });
        if (!resolved.ok) { if(ctx.hasUI) ctx.ui.notify(`Role unavailable: ${resolved.code}. Check preview FFF, skills and exact model.`,"warning"); throw Error(resolved.code); }
        if(ctx.scopedModels?.length && !ctx.scopedModels.some((entry:any)=>`${entry.model.provider}/${entry.model.id}`===resolved.loadout.model)) throw Error("Model outside parent scope");
        if (role === "builder" && !request.files?.length) {if(ctx.hasUI)ctx.ui.notify("Builder requires explicit files.","warning");throw Error("Explicit builder file scopes required");}
        if(request.artifactId&&role!=="builder")throw Error("Artifact recovery requires builder");
        const recovered=request.artifactId?await recoverWorktree(join(agentDir,"worktrees"),request.artifactId):undefined;
        if(recovered&&(JSON.stringify(request.files)!==JSON.stringify(recovered.files)||hasLiveBuilder(records,id=>supervisor?.inspect(id))))throw Error("Artifact recovery scope or live-owner conflict");
        if (role === "builder" && !recovered && artifacts.size >= 4) throw Error("Artifact cap: explicitly review/clean retained worktrees");
        const provider = parentProvider(ctx.modelRegistry, resolved.loadout.model!);
        const base = role === "builder" ? await committedBase(cwd) : undefined;
        if(recovered&&recovered.repo!==base?.repo)throw Error("Artifact repository mismatch");
        return {model:resolved.loadout.model, budget: { softTurns: resolved.loadout.softTurns, hardTurns: resolved.loadout.hardTurns, elapsedMs:config.elapsedMs??600000,maxTokens:config.maxTokens,maxCost:config.maxCost },
          createBackend: async context => {
            const lease = recovered??(base ? await createWorktree({ repo: base.repo, base: base.base, root: join(agentDir, "worktrees"), files: request.files! }) : undefined);
            if (lease) artifacts.set(lease.id, lease);
            const skillPaths = Object.fromEntries(resolved.loadout.skills.filter(n => n !== "my-web-search").map(n => [n, config.skillPaths[n]]));
            const result = await createTrustedRoleBackend({ role, agentDir, cwd: lease?.path ?? cwd, model: resolved.loadout.model!, routing: "native", provider,context,
              expectedDefinition: resolved.fingerprint, thinking: request.thinking as any, available, fffPath: config.fffPath, skillPaths, fffMultigrepEnabled: true, worktreeLease: lease });
            if (!result.ok) { if(ctx.hasUI)ctx.ui.notify(`Subagent initialization: ${result.code}`, "warning"); throw Error(result.code); }
            return result.backend;
          } };
      } });
    refreshFleet=()=>{
      if(ctx.hasUI&&!closingGeneration){
        ctx.ui.setStatus("native-subagents",`agents: ${[...records.values()].filter(record=>{const snapshot=supervisor?.inspect(record.threadId);return snapshot&&snapshot.state!=="terminal";}).length} active`);
        ctx.ui.setWidget?.("native-subagents",fleetLines({model:ctx.model&&`${ctx.model.provider}/${ctx.model.id}`},[...records].map(([id,record])=>({id,...record,snapshot:supervisor?.inspect(record.threadId)}))));
      }
    };
    supervisor.subscribe(event => {
      pruneRecords();
      const native = event.event;
      const detail = event.type === "native" ? activityDetail(native) :
        event.type === "state" ? `\n[state: ${event.state}]\n` : "";
      if (detail) activity.set(event.threadId,appendInspector(activity.get(event.threadId) ?? "",String(detail)));
      for (const viewer of viewers) viewer();
      refreshFleet();
      if (event.type === "result" && ctx.hasUI&&!closingGeneration) ctx.ui.notify(`Subagent ${event.result!.agentId}: ${event.result!.outcome}`, "info");
      if(event.type==="result")orchestration?.remember(event.result!);
    });
    const service=supervisor;
    if(pi.events)protocol=createProtocol({events:pi.events,supervisor:service,generation:randomUUID(),cwd:()=>ctx.cwd,start:async(request,metadata)=>{await init(ctx);return orchestration!.admit(request,metadata);}});
    orchestration=await createOrchestration({agentDir,config,owner:`${ctx.sessionManager?.getSessionId?.()??"unknown"}-${randomUUID()}`,start:async(request,metadata)=>{
      pruneRecords();const result=await service.start(request);if(result.ok){records.set(result.agentId,{threadId:result.threadId,runId:result.runId,role:request.role!,model:service.inspect(result.threadId)?.model,task:request.prompt,name:metadata?.name});protocol?.announce(result,metadata??{type:request.role!,description:request.role!,isBackground:false});}pruneRecords();refreshFleet();return result;
    },wait:service.wait,control:async request=>{const receipt=await(protocol?.control(request)??service.control(request));pruneRecords();refreshFleet();return receipt;},notify:text=>{if(ctx.hasUI)ctx.ui.notify(text,"warning");},outbox:()=>protocol?.pending()??[]});
    return service;
  };
  const init=(ctx:any)=>{if(ending)throw Error("Subagent generation draining");return boot??=initialize(ctx).catch(async error=>{try{await supervisor?.dispose();ownership?.release();}catch{ownership?.quarantine();}throw error;});};
  const shutdown = () => ending??=(async()=>{
    closingGeneration=true;
    let failure:unknown;
    try{await boot;}catch{}
    try{await orchestration?.stopPlans();}catch(error){failure=error;}
    // The persistence observer and protocol stay attached until final SDK outcomes
    // settle; closing the store first would replace actual interruptions with orphans.
    try{await supervisor?.dispose();}catch(error){ownership?.quarantine();failure??=error;}
    if(failure){protocol?.dispose();protocol=undefined;await orchestration?.flush();ownerUI?.setStatus?.("native-subagents","agents quarantined; restart Pi after inspecting retained evidence");throw failure;}
    try{await orchestration?.close();}catch(error){failure??=error;}
    protocol?.dispose();protocol=undefined;orchestration=undefined;supervisor=undefined;boot=undefined;
    ownership?.release();ownership=undefined;records.clear();artifacts.clear();activity.clear();receipts.clear();
    ownerUI?.setWidget?.("native-subagents",undefined);ownerUI?.setStatus?.("native-subagents",undefined);ownerUI=undefined;
    if(failure)throw failure;
  })().finally(()=>{ending=undefined;});
  pi.on("session_start",async(_event,ctx)=>{await init(ctx);});
  pi.on("session_shutdown", shutdown);
  pi.on("session_tree", shutdown);
  pi.registerTool({ name: "Agent", label: "Native Agent", description: `Start a fresh-context researcher, code-mapper, reviewer, or worktree builder. At most ${config.concurrency} children execute; no shell. Builder requires explicit owned files (directory scopes end in /).`,
    parameters: Type.Object({ prompt: Type.String(), description: Type.String({maxLength:512}), subagent_type: Type.String(),name:Type.Optional(Type.String()),thinking:Type.Optional(Type.String()),resume:Type.Optional(Type.String()),isolated:Type.Optional(Type.Boolean()),inherit_context:Type.Optional(Type.Boolean()),isolation:Type.Optional(Type.String()),
      model: Type.Optional(Type.String()), max_turns: Type.Optional(Type.Integer({minimum:1})), run_in_background: Type.Optional(Type.Boolean()), files: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, signal, _update, ctx) {
      const service = await init(ctx);
      const {files,...legacy}=params;const valid=validateLegacy("Agent",legacy);if(!valid.ok)return reply(valid);
      if(params.isolation&&params.subagent_type!=="builder")return reply({ok:false,code:"unsupported_field"});
      if(params.resume){const record=records.get(params.resume);if(!record||record.role!==params.subagent_type||params.model||params.thinking||params.max_turns||params.files)return reply({ok:false,code:"unsupported_field"});
        const receipt=await orchestration!.control({version:1,operation:"resume",threadId:record.threadId,expectedRunId:record.runId,message:params.prompt});
        if(receipt.runId&&receipt.status!=="rejected")record.runId=receipt.runId;
        return reply(params.run_in_background!==false?receipt:receipt.status==="rejected"?receipt:await service.wait([receipt.runId!],signal));}
      pruneRecords();
      const result = await orchestration!.admit({ prompt: params.prompt, role: params.subagent_type, ...(params.subagent_type==="Explore"?{evaluator:true,maxTurns:2}:{}), ...(params.model ? { model: params.model } : {}), ...(params.thinking?{thinking:params.thinking}:{}), ...(params.max_turns ? {maxTurns:params.max_turns} : {}), ...(params.files ? {files:params.files} : {}) },{type:params.subagent_type,description:params.description,isBackground:params.run_in_background!==false,name:params.name});
      if (!result.ok) return reply(result);
      protocol?.announce(result,{type:params.subagent_type,description:params.description,isBackground:params.run_in_background!==false});
      if (params.run_in_background !== false) return reply(result);
      return reply(await service.wait([result.runId], signal));
    } });
  pi.registerTool({ name: "get_subagent_result", label: "Subagent result", description: "Read the current exact run. Waiting does not consume or close a thread.", parameters: Type.Object({agent_id:Type.String(),wait:Type.Optional(Type.Boolean()),verbose:Type.Optional(Type.Boolean())}),
    async execute(_id, p, signal) { const record = records.get(p.agent_id); if (!record || !supervisor) return reply(orchestration?.recoveredAgent(p.agent_id)??{ok:false,code:"unknown_agent"});
      return reply(p.wait ? await supervisor.wait([record.runId], signal) : supervisor.inspect(record.threadId,record.runId)); } });
  pi.registerTool({ name: "steer_subagent", label: "Steer subagent", description: "Steer the currently running exact native child; receipts do not prove model consumption.",parameters:Type.Object({agent_id:Type.String(),message:Type.String()}),
    async execute(_id,p) { const record=records.get(p.agent_id); return reply(record && orchestration ? await orchestration.control({version:1,operation:"steer",threadId:record.threadId,expectedRunId:record.runId,message:p.message}) : {ok:false,code:"unknown_agent"}); } });
  pi.registerTool({ name: "subagent_control", label: "Subagent control", description: "Version 1 native control; use exact threadId and expectedRunId. Closing stops the child, not merely the inspector.",
    parameters: Type.Object({version:Type.Literal(1),operation:Type.Union(["message","steer","follow_up","interrupt","result","consume","resume","close"].map(v=>Type.Literal(v))),threadId:Type.String(),expectedRunId:Type.Optional(Type.String()),message:Type.Optional(Type.String())}),
    async execute(_id, p) { if (!supervisor||!orchestration) return reply({ok:false,code:"not_started"}); const answer=await orchestration.control(p as any);
      if (["follow_up","resume"].includes(p.operation)&&answer.runId && answer.status !== "rejected") for(const record of records.values()) if(record.threadId===p.threadId) record.runId=answer.runId;
      return reply(answer); } });
  pi.registerTool({name:"subagent_wait",label:"Wait for exact runs",description:"Wait for one or more run IDs with an optional timeout. Cancelling this wait does not stop workers.",parameters:Type.Object({run_ids:Type.Array(Type.String(),{maxItems:32}),timeout_ms:Type.Optional(Type.Integer({minimum:0,maximum:600000}))}),
    async execute(_id,p,signal,_update,ctx){const service=await init(ctx);return reply(await service.wait(p.run_ids,signal,p.timeout_ms));}});
  pi.registerTool({name:"subagent_start",label:"Explicit native subagent start",description:"Version 1 fresh child with optional identified snapshot. Snapshot is bounded, loadout-filtered, and rejected for researcher/Explore. Native fork is unsupported. Canonical defaults stay fresh.",
    parameters:Type.Object({version:Type.Literal(1),role:Type.String(),prompt:Type.String(),model:Type.Optional(Type.String()),thinking:Type.Optional(Type.String()),maxTurns:Type.Optional(Type.Integer({minimum:1})),files:Type.Optional(Type.Array(Type.String())),context:Type.Optional(Type.Object({mode:Type.Union([Type.Literal("snapshot"),Type.Literal("fork")]),sourceSessionId:Type.String(),branchLeafId:Type.String(),entryAnchorId:Type.String()}))}),
    async execute(_id,p,_signal,_update,ctx){await init(ctx);const {version,...request}=p;return reply(await orchestration!.admit(request,{type:p.role,description:p.role,isBackground:true}));}});
  pi.registerTool({name:"subagent_job",label:"Optional agent job",description:"Opt-in one-shot/interval/UTC cron jobs. All launches use native admission. Pausing future fires is separate from stopping an active run.",parameters:Type.Object({action:Type.Union(["list","create","pause","resume","stop_active"].map(v=>Type.Literal(v))),job_id:Type.Optional(Type.String()),schedule:Type.Optional(Type.Any()),request:Type.Optional(Type.Any())}),
    async execute(_id,p,_signal,_update,ctx){await init(ctx);try{const value=await orchestration!.jobs(p.action,p);await orchestration!.flush();return reply(value);}catch{return reply({ok:false,code:"invalid_or_disabled_job"});}}});
  pi.registerTool({name:"subagent_workflow",label:"Optional declarative workflow",description:"Opt-in bounded specialist graph; no scripts or shell grants. Structured result validation is local. Verification requires parent-owned evidence through human UI, not this tool.",parameters:Type.Object({action:Type.Union(["list","start","inspect","pause","resume","retry","skip","cancel"].map(v=>Type.Literal(v))),workflow_id:Type.Optional(Type.String()),step_id:Type.Optional(Type.String()),plan:Type.Optional(Type.Any())}),
    async execute(_id,p,_signal,_update,ctx){await init(ctx);try{const value=await orchestration!.workflow(p.action,p);await orchestration!.flush();return reply(value);}catch{return reply({ok:false,code:"invalid_or_disabled_workflow"});}}});
  pi.registerCommand("agents-demo",{description:"Disposable synthetic inspector; no SDK model/provider or filesystem operations",handler:async(_args,ctx)=>{
    if(!ctx.hasUI)return;const demo=createDemo();let text="Synthetic demo: no model or tool requests. Escape closes the view.\n";
    const listeners=new Set<()=>void>();const unsub=demo.service.subscribe(event=>{text=appendInspector(text,event.type==="native"?activityDetail(event.event):`\n${event.state??event.result?.outcome}\n`);for(const listener of listeners)listener();});
    try{await demo.service.start({prompt:"synthetic"});
      if(ctx.mode==="tui")await ctx.ui.custom((tui,_theme,_keys,done)=>new Inspector(tui,()=>text,listener=>{listeners.add(listener);return()=>listeners.delete(listener);},done));
      else await ctx.ui.select(displayText(text,16000),["Back"]);
    }finally{unsub();await demo.service.dispose();}
  }});
  pi.registerCommand("agents", { description: "Inspect/control native workers (no model call)", handler: async (_args, ctx) => {
    if (!ctx.hasUI) return;
    try{
    if(_args.trim()==="storage"){
      const root=join(agentDir,"subagents-state"),lease=await inspectStorageLease(root);
      if(await ctx.ui.confirm("Review stale storage lease",`${JSON.stringify(lease)}\nOnly a dead process lease may be reconciled. Original lock is kept as evidence; jobs never auto-replay.`)){
        await reconcileStorageLease(root,lease);boot=undefined;ctx.ui.notify("Dead lease reconciled; original lock retained. Run /agents again to load paused recovery metadata.","info");
      }return;
    }
    await init(ctx);
    const topic=_args.trim()||await ctx.ui.select("Native agents",["fleet","results","notifications","jobs","workflows","artifacts"]);
    if(!topic)return;
    if(["results","notifications","jobs","workflows"].includes(topic)){await humanMenu(topic,ctx.ui as any,orchestration);return;}
    if(topic==="artifacts"){
      const root=join(agentDir,"worktrees");let names:string[]=[];try{names=(await readdir(root)).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).slice(0,32);}catch(error){if((error as any).code!=="ENOENT")throw error;}
      const selected=await ctx.ui.select("Retained owned artifacts",names);if(!selected)return;
      const lease=await recoverWorktree(root,selected.slice(0,-5)),artifact=await inspectWorktree(lease);
      await ctx.ui.select(displayText(JSON.stringify(artifact,null,2),16000),["Back"]);
      if(hasLiveBuilder(records,id=>supervisor?.inspect(id))){ctx.ui.notify("Close all live builder threads before recovery or cleanup.","warning");return;}
      const action=await ctx.ui.select("Artifact controls",["Keep","Start fresh builder on retained worktree","Discard owned worktree"]);
      if(action==="Start fresh builder on retained worktree"){
        const prompt=await ctx.ui.input("Fresh task on the retained artifact","Conversation is not restored. Original file scopes and branch are preserved.");if(!prompt)return;
        const result=await orchestration!.admit({role:"builder",prompt,artifactId:lease.id,files:[...lease.files]},{type:"builder",description:"Human-reviewed artifact recovery",isBackground:true});ctx.ui.notify(JSON.stringify(result),result.ok?"info":"warning");return;
      }
      if(action!=="Discard owned worktree")return;
      const reviewed=await reviewWorktree(lease);
      if(JSON.stringify(reviewed.artifact)!==JSON.stringify(artifact))throw Error("worktree review drift; reopen artifact review");
      if(!await ctx.ui.confirm("Discard this exact worktree?",`${artifact.path}\n${artifact.status}\nUncommitted/ignored files will be permanently removed. The branch and ownership record remain.`))return;
      const confirmation=await ctx.ui.input("Type the exact branch to confirm deletion",artifact.branch);if(confirmation!==artifact.branch)return;
      await discardWorktree(lease,{expectedStatus:artifact.status,expectedFingerprint:reviewed.fingerprint,discardDirty:true});artifacts.delete(lease.id);
      ctx.ui.notify("Owned worktree removed. Branch/record retained; discarded uncommitted files are not recoverable.","warning");return;
    }
    if(topic!=="fleet")throw Error("Use /agents [fleet|results|notifications|jobs|workflows|artifacts]");
    const choices = [...records].map(([id,r]) => `${id} | ${r.role} | ${supervisor?.inspect(r.threadId)?.state}`);
    const selected = await ctx.ui.select("Native preview fleet", choices.length ? choices : ["No workers. Ask Pi to use Agent."]);
    const record = selected && records.get(selected.split(" | ")[0]); if (!record || !supervisor) return;
    const action = await ctx.ui.select("Worker controls", ["Inspect", "Message", "Steer", "Follow up", "Resume", "Interrupt", "Consume result", "Close thread"]);
    if (!action) return;
    if (action === "Inspect") {
      const snapshot = () => JSON.stringify({...supervisor?.inspect(record.threadId),model:record.model,task:record.task,name:record.name},null,2).slice(0,16000)+"\nReceipts:\n"+(receipts.get(record.threadId)??"")+"\n"+(activity.get(record.threadId) ?? "");
      if(ctx.mode === "tui") await ctx.ui.custom((_tui,_theme,_keys,done) => new Inspector(_tui,snapshot,listener=>{viewers.add(listener);return ()=>viewers.delete(listener);},done));
      else await ctx.ui.select(snapshot().slice(-16000),["Back"]);
      return;
    }
    const operation = ({Message:"message",Steer:"steer","Follow up":"follow_up",Resume:"resume",Interrupt:"interrupt","Consume result":"consume","Close thread":"close"} as any)[action];
    const message = ["message","steer","follow_up","resume"].includes(operation) ? await ctx.ui.input(action,"Message") : undefined;
    if (["message","steer","follow_up","resume"].includes(operation) && !message) return;
    const control:any={version:1,operation,threadId:record.threadId,expectedRunId:record.runId,...(message ? {message} : {})};
    const receipt = await orchestration!.control(control);
    receipts.set(record.threadId,appendInspector(receipts.get(record.threadId)??"",JSON.stringify(receipt)+"\n"));
    if(receipt.runId && receipt.status !== "rejected") record.runId=receipt.runId;
    if(operation==="consume"&&receipt.status!=="rejected"&&receipt.runId)await orchestration?.consume(receipt.runId);
    ctx.ui.notify(JSON.stringify(receipt), receipt.status === "rejected" ? "warning" : "info");
    }catch(error){ctx.ui.notify(displayText(error instanceof Error?error.message:error,512),"warning");}
  } });
}
