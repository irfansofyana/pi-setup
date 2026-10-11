import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createManagedSupervisor as createSupervisor } from "./manager-service.ts";
import { createRootThreadService } from "./root-service.ts";
import { agentTools } from "./upstream/src/orch/tools.ts";
import { AgentNavigationController } from "./upstream/src/ui/status-ui.ts";
import { updateWidget } from "./upstream/src/ui/ui.ts";
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
import {nativeActivation} from "./activation.ts";
import { parentSearchTools, optionalSearchTools, usesBundledResources, shouldUseBuiltinFallback } from "./parent-resources.ts";
import { createAgentRegistry, canonicalRole, resolveAgentDefinition, delegationTools } from "./registry.ts";
import { createChildTools } from "./child-tools.ts";
import { createManagerUI } from "./manager-ui.ts";
import { createManagerPresentation } from "./manager-presentation.ts";
import { isRootEditor } from "../../themes/pi-irfan-devs/root-editor.ts";
import { createParentDelivery } from "./parent-delivery.ts";
import { subagentPrompt } from "./upstream/src/orch/prompt.ts";
import { CostLedger, COST_ENTRY } from "./upstream/src/orch/cost-ledger.ts";
import { CostFooterController } from "./upstream/src/ui/cost-footer.ts";
import type { DriverOptions } from "./upstream/src/types.ts";
import { parentPath } from "./upstream/src/orch/paths.ts";

/** In-memory defaults; preserve user config and gate companion collisions before registration. */
export async function registerNative(pi:ExtensionAPI){
 const agentDir=getAgentDir(),config=await nativeActivation(agentDir,process.cwd());
 if(!config)return;
 return registerRuntime(pi,agentDir,config);
}
async function registerRuntime(pi:ExtensionAPI,agentDir:string,config:any){
  let supervisor: ReturnType<typeof createSupervisor> | undefined;
  let protocol: ReturnType<typeof createProtocol> | undefined;
  let orchestration:Awaited<ReturnType<typeof createOrchestration>>|undefined;
  let boot:Promise<ReturnType<typeof createSupervisor>>|undefined;
  let ownership:ReturnType<typeof claimOwner>|undefined,ending:Promise<void>|undefined;
  let closingGeneration=false,ownerUI:any;
  const navigation = new AgentNavigationController();
  let currentModel: string | undefined;
  let registry: ReturnType<typeof createAgentRegistry> | undefined, runtimeContext: any;
  let managerUI: ReturnType<typeof createManagerUI> | undefined, rootTurnEnded=false;
  let delivery: ReturnType<typeof createParentDelivery> | undefined;
  let costLedger=new CostLedger();
  const costFooter=new CostFooterController({getCommands:()=>pi.getCommands?.()??[],events:pi.events??{emit(){}}}as any,
    ()=>costLedger.totalUsd,()=>managerUI?.settings.nerdFontIcons??false,()=>managerUI?.settings.costDisplay??"pi-footer-status","status");
  const publicTools:any[]=[];
  const syncTools=()=>{for(const tool of publicTools)pi.registerTool({...tool,exposure:managerUI?.settings.subagentMode==="off"?"hidden":"direct"});};
  const adoptContext=(ctx:any)=>{if(runtimeContext&&(ctx.cwd!==runtimeContext.cwd||(ctx.sessionManager?.getSessionId?.()&&runtimeContext.sessionManager?.getSessionId?.()&&ctx.sessionManager.getSessionId()!==runtimeContext.sessionManager.getSessionId())))throw Error("Root session changed; drain and attach a new subagent generation");runtimeContext=ctx;currentModel=ctx.model&&`${ctx.model.provider}/${ctx.model.id}`;};
  const registerTool=(tool:any)=>{const guarded={...tool,async execute(...args:any[]){const ctx=args[4]??runtimeContext;await init(ctx);adoptContext(ctx);if(managerUI?.settings.subagentMode==="off")throw Error("Subagent Mode is off");return tool.execute(...args);}};publicTools.push(guarded);pi.registerTool(guarded);};
  const records = new Map<string, { threadId: string; runId: string; role: string;model?:string;task?:string;name?:string }>();
  const driverOptions=new Map<string,DriverOptions>();
  const resourcesFor = (type: any, ctx: any) => {
    const writable = (type.tools?.allow ?? []).some((name: string) => ["edit", "write"].includes(name) && !type.tools?.block?.includes(name));
    const parentTools = writable ? [] : parentSearchTools(ctx);
    const bundled = usesBundledResources(type);
    const availableTools = [...parentTools.map(tool => tool.name), ...(!bundled && config.fffPath ? optionalSearchTools.filter(name => name !== "fff-multi-grep" || process.env.PI_FFF_MULTIGREP === "1") : [])];
    // Bundled roles never load third-party packages or external skills into their child runtime.
    return { parentTools, availableTools, availableSkills: bundled ? [] : Object.keys(config.skillPaths ?? {}) };
  };
  const receipts=new Map<string,string>();
  const artifacts = new Map<string, any>();
  const activity = new Map<string,string>();
  const viewers = new Set<() => void>();
  const pruneRecords=()=>{pruneRuntimeRecords(records,activity,receipts,id=>supervisor?.inspect(id));const paths=new Set(supervisor?.manager.list().map(thread=>thread.path)??[]);for(const path of driverOptions.keys())if(!paths.has(path))driverOptions.delete(path);};
  let refreshFleet=()=>{};
  const presentation=createManagerPresentation({settings:()=>managerUI?.settings,threads:()=>supervisor?.manager.list()??[],
    metrics(path){const handle=supervisor?.handleFor(path);const snapshot=handle&&supervisor?.inspect(handle.threadId);return snapshot?{runState:snapshot.state,turns:snapshot.turns,toolUses:snapshot.toolUses,totalTokens:snapshot.usage.totalTokens,softTurns:snapshot.budget?.softTurns,hardTurns:snapshot.budget?.hardTurns}:undefined;},
    service:()=>rootThreads(),isEditor:(component):component is CustomEditor=>component instanceof CustomEditor && isRootEditor(component),
    renderOther(ctx,settings,threads,ended){updateWidget(ctx,threads,settings.widgetMode,settings.nerdFontIcons,ended,settings.loaderStyle,false);}});
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value });
  const initialize = async (ctx: any) => {
    ownership=claimOwner(agentDir);
    closingGeneration=false;ownerUI=ctx.hasUI?ctx.ui:undefined;
    currentModel=ctx.model&&`${ctx.model.provider}/${ctx.model.id}`;
    runtimeContext=ctx;
    registry=createAgentRegistry({agentDir,cwd:ctx.cwd,includeProject:ctx.isProjectTrusted?.()===true});
    for(const diagnostic of registry.diagnostics)if(ctx.hasUI)ctx.ui.notify(diagnostic,"warning");
    presentation.reset();
    managerUI=createManagerUI({agentDir,cwd:ctx.cwd,store:registry,pi,caps:{concurrency:config.concurrency,threads:config.threads,levels:4},
      apply(settings){supervisor?.setAdmissionLimits({concurrency:settings.maxConcurrent,threads:settings.maxThreads});supervisor?.manager.setLimits({...settings,maxConcurrent:config.threads});syncTools();refreshFleet();delivery?.flush();},
      reap:{candidates:()=>supervisor?.manager.reapCandidates()??[],async close(confirmed){
        const eligible=new Set(supervisor!.manager.reapCandidates(confirmed)),closed:string[]=[];
        for(const path of [...eligible].sort((a,b)=>b.split("/").length-a.split("/").length)){
          const handle=supervisor!.handleFor(path),current=handle&&supervisor!.inspect(handle.threadId);if(!handle||!current)continue;
          const receipt=await orchestration!.control({version:1,operation:"close",threadId:handle.threadId,expectedRunId:current.runId});if(receipt.status!=="rejected")closed.push(path);
        }pruneRecords();refreshFleet();return closed;
      }}});
    costLedger=new CostLedger();costLedger.restore(ctx.sessionManager?.getEntries?.()??[]);
    if(pi.sendMessage)delivery=createParentDelivery(pi,{settings:()=>managerUI!.settings,context:()=>runtimeContext,
      outstanding:()=>supervisor?.manager.outstandingAsync()??0,runKey:thread=>{const handle=supervisor?.handleFor(thread.path);return handle?`${handle.threadId}/${handle.runId}`:`${thread.costId}/${thread.updatedAt}`;}});
    const providerFor = (assignment: string) => parentProvider(runtimeContext.modelRegistry, assignment, config.routing === "headroom-preferred" ? { routing: "headroom-preferred", warn(message) {
      if (ctx.hasUI) ctx.ui.notify(message,"warning"); else console.warn(message);
    } } : undefined);
    supervisor = createSupervisor({ concurrency:config.concurrency, threads:config.threads, slots:config.slots, pending:config.pending, nextId: randomUUID,evaluatorSupported:true,
      resolveSource:id=>ctx.sessionManager?.getSessionId()===id?ctx.sessionManager:undefined,
      createBackend: async () => { throw Error("Unprepared role"); },
      prepare: async request => {
        const ctx=runtimeContext;
        const role = canonicalRole(request.role!);
        const driver=request.managerPath?driverOptions.get(request.managerPath):undefined;
        const cwd=ctx.cwd;
        const parent=request.managerPath&&parentPath(request.managerPath),parentHandle=parent&&supervisor?.handleFor(parent),parentSettings=parentHandle&&supervisor?.inspect(parentHandle.threadId);
        const assignment = request.model ?? parentSettings?.model ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
        if(role==="Explore"){
          if(!request.evaluator||request.context||request.artifactId||request.files?.length||!assignment||(request.maxTurns!==undefined&&request.maxTurns>2))throw Error("Invalid evaluator loadout");
          const provider=providerFor(assignment);
          if(ctx.scopedModels?.length&&!ctx.scopedModels.some((entry:any)=>`${entry.model.provider}/${entry.model.id}`===assignment))throw Error("Evaluator model outside parent scope");
          return {model:assignment,budget:{softTurns:2,hardTurns:2,elapsedMs:Math.min(config.elapsedMs??120000,120000),maxTokens:config.maxTokens,maxCost:config.maxCost},createBackend:async()=>{const result=await createEvaluatorBackend({agentDir,cwd,model:assignment,provider});if(!result.ok)throw Error(result.code);return result.backend;}};
        }
        const type = registry!.get(role), resources = resourcesFor(type, runtimeContext);
        const available = { tools: ["read", "grep", "find", "ls", "edit", "write", "ext:web-research/web_search", "ext:web-research/web_fetch", ...resources.availableTools.map(name => `ext:fff/${name}`), ...delegationTools],
          extensions: ["web-research", ...(resources.availableTools.length ? ["fff"] : [])], skills: ["my-web-search", ...resources.availableSkills], models: ctx.modelRegistry.getAvailable().map((m: any) => `${m.provider}/${m.id}`) };
        const resolved = resolveAgentDefinition(type, { ...resources, model: assignment, explicitModel:request.model, models: available.models, thinking:parentSettings?.thinking??ctx.thinkingLevel,
          scopedModels:ctx.scopedModels?.map((entry:any)=>`${entry.model.provider}/${entry.model.id}`),maxTurns:request.maxTurns,modelSelection:managerUI!.settings.modelSelection });
        if(request.budgetExtendable===false&&resolved.toolNames.includes("agent_spawn"))throw Error("Scheduled/workflow turn reservations cannot fund nested delegation; use a non-delegating custom type");
        if(ctx.scopedModels?.length && !ctx.scopedModels.some((entry:any)=>`${entry.model.provider}/${entry.model.id}`===resolved.loadout.model)) throw Error("Model outside parent scope");
        const writable=resolved.loadout.isolation==="worktree";
        if (writable && !request.files?.length) {if(ctx.hasUI)ctx.ui.notify("Writable agents require explicit files.","warning");throw Error("Explicit worktree file scopes required");}
        if(request.artifactId&&role!=="builder")throw Error("Artifact recovery requires builder");
        const recovered=request.artifactId?await recoverWorktree(join(agentDir,"worktrees"),request.artifactId):undefined;
        if(recovered&&(JSON.stringify(request.files)!==JSON.stringify(recovered.files)||hasLiveBuilder(records,id=>supervisor?.inspect(id))))throw Error("Artifact recovery scope or live-owner conflict");
        if (writable && !recovered && artifacts.size >= 4) throw Error("Artifact cap: explicitly review/clean retained worktrees");
        const provider = providerFor(resolved.loadout.model!);
        const base = writable ? await committedBase(cwd) : undefined;
        if(recovered&&recovered.repo!==base?.repo)throw Error("Artifact repository mismatch");
        return {model:resolved.loadout.model, thinking:request.thinking??resolved.thinking, contextTools:resolved.toolNames, budget: { softTurns: resolved.loadout.softTurns, hardTurns: resolved.loadout.hardTurns, elapsedMs:config.elapsedMs??600000,maxTokens:config.maxTokens,maxCost:config.maxCost },
          createBackend: async context => {
            const lease = recovered??(base ? await createWorktree({ repo: base.repo, base: base.base, root: join(agentDir, "worktrees"), files: request.files! }) : undefined);
            if (lease) artifacts.set(lease.id, lease);
            const skillPaths = Object.fromEntries(resolved.loadout.skills.filter(n => n !== "my-web-search").map(n => [n, config.skillPaths[n]]));
            const backendOptions = { role, agentDir, cwd: lease?.path ?? cwd, model: resolved.loadout.model!, routing: "native" as const, provider,context,
              ...(driver?{shouldPause:driver.shouldPause,childTools:createChildTools({path:driver.path,allowed:resolved.toolNames,service:supervisor!,orchestration:()=>orchestration!,types:()=>registry!.list(),resolve:type=>{
                const child=resolveAgentDefinition(type,{...resourcesFor(type,runtimeContext),model:resolved.loadout.model,models:available.models,thinking:resolved.thinking,scopedModels:ctx.scopedModels?.map((entry:any)=>`${entry.model.provider}/${entry.model.id}`),modelSelection:managerUI!.settings.modelSelection});
                return{model:child.loadout.model!,thinkingLevel:child.thinking};
              }})}:{}),
              definition:resolved, parentTools: resources.parentTools.filter(tool => resolved.toolNames.includes(tool.name)), expectedDefinition: resolved.fingerprint, thinking: (request.thinking??resolved.thinking) as any, available, fffPath: config.fffPath, skillPaths, fffMultigrepEnabled: true, worktreeLease: lease };
            let result = await createTrustedRoleBackend(backendOptions);
            if (!result.ok && shouldUseBuiltinFallback(resolved.type, resolved.loadout.extensions.includes("fff"), result.code, Boolean(context))) {
              // Initialization only: no model request was submitted, and optional authority only narrows.
              const core = resolveAgentDefinition(resolved.type, { model: resolved.loadout.model, models: available.models, modelSelection: "use-current", maxTurns: resolved.loadout.softTurns, availableTools: [], availableSkills: [] });
              result = await createTrustedRoleBackend({ ...backendOptions, definition: core, parentTools: [], expectedDefinition: core.fingerprint });
              if (result.ok && ctx.hasUI) try { ctx.ui.notify("Optional parent search unavailable; subagent using built-in search.", "warning"); } catch { /* optional UI cannot block child startup */ }
            }
            if (!result.ok) { if(ctx.hasUI)try { ctx.ui.notify(`Subagent initialization: ${result.code}`, "warning"); } catch {} throw Error(result.code); }
            return result.backend;
          } };
      } }, {maxLevels:4,onDriver(driver){driverOptions.set(driver.path,driver);},getType(name){return name==="Explore"?{name,description:"Bounded read-only evaluator",systemPrompt:"",tools:{}}:registry!.get(name);},onEvent(event) {
        if(!closingGeneration){
          delivery?.event(event);
          if(event.kind!=="change"&&event.kind!=="metrics"&&event.recipient!=="/root")void supervisor?.manager.deliver(event.recipient,JSON.stringify({untrustedSubagentEvent:true,path:event.thread.path,state:event.thread.state,status:event.thread.status.slice(0,4096),...(event.kind==="update"?{progress:event.message.slice(0,4096)}:event.kind==="timeout"?{reportOnlyTimeoutMs:event.timeoutMs}: {output:event.thread.output?.slice(0,16000)})})).catch(error=>{if(ctx.hasUI)ctx.ui.notify(`Child event delivery failed: ${String(error)}`,"warning");});
          if(["settled","change"].includes(event.kind))costLedger.settle(event.thread,record=>pi.appendEntry?.(COST_ENTRY,record));
          refreshFleet();
        }
        if(event.kind==="timeout"&&!closingGeneration){
          const text=`Subagent ${event.thread.path} report-only timeout; still ${event.thread.state}. Use agent_wait, agent_steer or agent_stop.`;
          if(ctx.hasUI)ctx.ui.notify(text,"warning");
        }
      }});
    refreshFleet=()=>{
      const ctx=runtimeContext;
      if(ctx.hasUI&&!closingGeneration){
        if(managerUI?.settings.subagentMode==="off"){costFooter.clear();costFooter.reset(ctx);}else costFooter.refresh(ctx);
        ctx.ui.setStatus("native-subagents",ctx.mode==="tui"||managerUI?.settings.subagentMode==="off"?undefined:`agents: ${[...records.values()].filter(record=>{const snapshot=supervisor?.inspect(record.threadId);return snapshot&&snapshot.state!=="terminal";}).length} active`);
        if(managerUI?.settings.subagentMode==="off"){ctx.ui.setWidget?.("native-subagents",undefined);presentation.clear(ctx);}
        else if(ctx.ui.theme){ctx.ui.setWidget?.("native-subagents",undefined);presentation.refresh(ctx,rootTurnEnded);}
        else ctx.ui.setWidget?.("native-subagents",fleetLines({model:ctx.model&&`${ctx.model.provider}/${ctx.model.id}`},[...records].map(([id,record])=>({id,...record,snapshot:supervisor?.inspect(record.threadId)}))));
      }
    };
    supervisor.subscribe(event => {
      if(event.type==="state"&&event.state==="queued")for(const record of records.values())if(record.threadId===event.threadId)record.runId=event.runId;
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
    const isRole=(name:string)=>{try{return typeof name==="string"&&!!registry!.get(name);}catch{return false;}};
    if(pi.events)protocol=createProtocol({events:pi.events,supervisor:service,generation:randomUUID(),cwd:()=>ctx.cwd,isRole:name=>name==="Explore"||isRole(name),start:async(request,metadata)=>{await init(runtimeContext);return orchestration!.admit(request,metadata);}});
    orchestration=await createOrchestration({agentDir,config,isRole,owner:`${ctx.sessionManager?.getSessionId?.()??"unknown"}-${randomUUID()}`,start:async(request,metadata)=>{
      if(managerUI!.settings.subagentMode==="off")return {ok:false,code:"unsupported_field"}as const;
      pruneRecords();const result=await service.start(request,metadata?.managerPath,metadata?.timeoutMs,metadata?.isBackground!==false,metadata?.managerCaller);if(result.ok){records.set(result.agentId,{threadId:result.threadId,runId:result.runId,role:request.role!,model:service.inspect(result.threadId)?.model,task:request.prompt,name:metadata?.name});protocol?.announce(result,metadata??{type:request.role!,description:request.role!,isBackground:false});}pruneRecords();refreshFleet();return result;
    },wait:service.wait,control:async request=>{const receipt=await(protocol?.control(request)??service.control(request));pruneRecords();refreshFleet();return receipt;},notify:text=>{if(ctx.hasUI)ctx.ui.notify(text,"warning");},outbox:()=>protocol?.pending()??[]});
    supervisor.setAdmissionLimits({concurrency:managerUI.settings.maxConcurrent,threads:managerUI.settings.maxThreads});
    supervisor.manager.setLimits({...managerUI.settings,maxConcurrent:config.threads});syncTools();refreshFleet();
    return service;
  };
  const init=(ctx:any)=>{if(ending)throw Error("Subagent generation draining");return boot??=initialize(ctx).catch(async error=>{try{await supervisor?.dispose();ownership?.release();}catch{ownership?.quarantine();}throw error;});};
  const shutdown = () => ending??=(async()=>{
    closingGeneration=true;
    delivery?.close();delivery=undefined;
    navigation.close();
    if(runtimeContext)presentation.clear(runtimeContext);
    costFooter.clear();if(runtimeContext)costFooter.reset(runtimeContext);
    let failure:unknown;
    try{await boot;}catch{}
    try{await orchestration?.stopPlans();}catch(error){failure=error;}
    // The persistence observer and protocol stay attached until final SDK outcomes
    // settle; closing the store first would replace actual interruptions with orphans.
    try{await supervisor?.dispose();}catch(error){ownership?.quarantine();failure??=error;}
    // Manager shutdown suppresses live events. Persist final own-usage high-water
    // marks while appendEntry still targets the departing root session/branch.
    if(!failure)try{for(const thread of supervisor?.manager.list()??[])costLedger.settle(thread,record=>pi.appendEntry?.(COST_ENTRY,record));}catch(error){ownership?.quarantine();failure=error;}
    if(failure){protocol?.dispose();protocol=undefined;await orchestration?.flush();ownerUI?.setStatus?.("native-subagents","agents quarantined; restart Pi after inspecting retained evidence");throw failure;}
    try{await orchestration?.close();}catch(error){failure??=error;}
    protocol?.dispose();protocol=undefined;orchestration=undefined;supervisor=undefined;boot=undefined;
    ownership?.release();ownership=undefined;records.clear();driverOptions.clear();artifacts.clear();activity.clear();receipts.clear();
    ownerUI?.setWidget?.("native-subagents",undefined);ownerUI?.setStatus?.("native-subagents",undefined);ownerUI=undefined;
    if(runtimeContext)presentation.clear(runtimeContext);
    if(failure)throw failure;
  })().finally(()=>{ending=undefined;});
  pi.on("session_start",async(_event,ctx)=>{if(boot)await shutdown();await init(ctx);});
  pi.on("session_shutdown", shutdown);
  const beforeNavigation=async(_event:any,ctx:any)=>{try{await shutdown();}catch(error){ctx.ui?.notify(`Subagent cleanup unconfirmed; navigation cancelled. Restart after inspecting retained evidence: ${String(error)}`,"warning");return{cancel:true};}};
  pi.on("session_before_tree",beforeNavigation);
  pi.on("session_before_switch",beforeNavigation);
  pi.on("session_before_fork",beforeNavigation);
  pi.on("session_tree",async(_event,ctx)=>{await shutdown();await init(ctx);});
  pi.on("before_agent_start",async(event,ctx)=>{
    await init(ctx);adoptContext(ctx);
    const prompt=subagentPrompt(managerUI!.settings,"Call agent_types before choosing a type. Use task-based kebab-case paths under /root. New children are fresh-context: provide a self-contained task, explicit owned files for writable agents, and useful completion criteria. Canonical researcher is web-only; scout and reviewer are read-only/network-free; builder writes only in its owned worktree. There is no shell/test authority. Do not start broad validation on this shared host. Use child checkpoints and steering to narrow work instead of repeatedly relaunching an exhausted task.");
    return prompt?{systemPrompt:`${event.systemPrompt}\n\n${prompt}`}:undefined;
  });
  pi.on("agent_start",async()=>{delivery?.started();rootTurnEnded=false;refreshFleet();});
  pi.on("agent_end",async()=>{rootTurnEnded=true;refreshFleet();});
  pi.on("agent_settled",async(_event,ctx)=>{if(runtimeContext&&ctx.cwd===runtimeContext.cwd)adoptContext(ctx);delivery?.settled();});
  const types = () => registry?.list() ?? [];
  const rootThreads = () => {
    if (!supervisor || !orchestration) throw Error("Subagents not initialized");
    return createRootThreadService(supervisor, orchestration.control);
  };
  for (const tool of agentTools(() => ({ scope: rootThreads }), "/root", types,
    type => { if (!currentModel) throw Error("Choose an exact parent model first"); const resolved=resolveAgentDefinition(type,{...resourcesFor(type,runtimeContext),model:currentModel,thinking:runtimeContext.thinkingLevel,models:runtimeContext.modelRegistry.getAvailable().map((model:any)=>`${model.provider}/${model.id}`),scopedModels:runtimeContext.scopedModels?.map((entry:any)=>`${entry.model.provider}/${entry.model.id}`),modelSelection:managerUI!.settings.modelSelection});return {model:resolved.loadout.model!,thinkingLevel:resolved.thinking}; })) {
    if (["agent_update", "agent_pause"].includes(tool.name)) continue;
    const adapted = { ...tool };
    if (tool.name === "agent_spawn") {
      adapted.description = "Spawn a named fresh-context bundled or user-defined agent. Relative paths live under /root; absolute /task paths create independent roots. Only explicit custom delegation tools enable child-controlled nesting. Use agent_types to discover types. Writable agents require explicit owned files and a worktree. wait:false detaches; use agent_wait for completion. Same-session continuation retains lifetime budget; no transcript persistence.";
      adapted.parameters = Type.Object({ ...(tool.parameters as any).properties, files: Type.Optional(Type.Array(Type.String())), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), maxTurns: Type.Optional(Type.Integer({ minimum: 1 })) });
    }
    if (tool.name === "agent_types") adapted.description = "List bundled researcher/scout/builder/reviewer plus trusted custom types and resolved model defaults. Exact resources are checked at admission. code-mapper is a scout compatibility alias.";
    adapted.execute = async (id, params: any, signal, update, ctx) => {
      signal?.throwIfAborted();
      const service = await init(ctx);
      if (tool.name === "agent_spawn") {
        if (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 30000 || params.timeoutMs > 300000)) throw Error("Invalid report-only timeout");
        const { path, type, task, files, model, thinking, maxTurns } = params;
        const receipt = await orchestration!.admit({ role: type, prompt: task, ...(files ? { files } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}) },
          { managerPath: path, name: path, type, description: task.slice(0,512), isBackground: params.wait === false, timeoutMs: params.timeoutMs });
        if (!receipt.ok) return reply(receipt);
        const exactPath = service.pathFor(receipt.threadId)!;
        return reply(params.wait === false ? service.manager.get(exactPath) : await service.manager.wait("/root", exactPath, undefined, signal));
      }
      return tool.execute(id, params, signal, update, ctx);
    };
    registerTool(adapted);
  }
  registerTool({ name: "Agent", label: "Native Agent", description: `Start a fresh bundled or trusted custom agent. code-mapper aliases scout. At most ${config.concurrency} children execute; no shell. Writable agents require explicit worktree files (directory scopes end in /).`,
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
  registerTool({ name: "get_subagent_result", label: "Subagent result", description: "Read the current exact run. Waiting does not consume or close a thread.", parameters: Type.Object({agent_id:Type.String(),wait:Type.Optional(Type.Boolean()),verbose:Type.Optional(Type.Boolean())}),
    async execute(_id, p, signal) { const record = records.get(p.agent_id); if (!record || !supervisor) return reply(orchestration?.recoveredAgent(p.agent_id)??{ok:false,code:"unknown_agent"});
      return reply(p.wait ? await supervisor.wait([record.runId], signal) : supervisor.inspect(record.threadId,record.runId)); } });
  registerTool({ name: "steer_subagent", label: "Steer subagent", description: "Steer the currently running exact native child; receipts do not prove model consumption.",parameters:Type.Object({agent_id:Type.String(),message:Type.String()}),
    async execute(_id,p) { const record=records.get(p.agent_id); return reply(record && orchestration ? await orchestration.control({version:1,operation:"steer",threadId:record.threadId,expectedRunId:record.runId,message:p.message}) : {ok:false,code:"unknown_agent"}); } });
  registerTool({ name: "subagent_control", label: "Subagent control", description: "Version 1 native control; use exact threadId and expectedRunId. Closing stops the child, not merely the inspector.",
    parameters: Type.Object({version:Type.Literal(1),operation:Type.Union(["message","steer","follow_up","interrupt","result","consume","resume","close","extend_budget"].map(v=>Type.Literal(v))),threadId:Type.String(),expectedRunId:Type.Optional(Type.String()),message:Type.Optional(Type.String()),additionalTurns:Type.Optional(Type.Integer({minimum:1}))}),
    async execute(_id, p) { if (!supervisor||!orchestration) return reply({ok:false,code:"not_started"}); const answer=await orchestration.control(p as any);
      if (["follow_up","resume"].includes(p.operation)&&answer.runId && answer.status !== "rejected") for(const record of records.values()) if(record.threadId===p.threadId) record.runId=answer.runId;
      return reply(answer); } });
  registerTool({name:"subagent_wait",label:"Wait for exact runs",description:"Wait for one or more run IDs with an optional timeout. Cancelling this wait does not stop workers.",parameters:Type.Object({run_ids:Type.Array(Type.String(),{maxItems:32}),timeout_ms:Type.Optional(Type.Integer({minimum:0,maximum:600000}))}),
    async execute(_id,p,signal,_update,ctx){const service=await init(ctx);return reply(await service.wait(p.run_ids,signal,p.timeout_ms));}});
  registerTool({name:"subagent_start",label:"Explicit native subagent start",description:"Version 1 fresh child with optional identified snapshot. Snapshot is bounded, loadout-filtered, and rejected for researcher/Explore. Native fork is unsupported. Canonical defaults stay fresh.",
    parameters:Type.Object({version:Type.Literal(1),role:Type.String(),prompt:Type.String(),model:Type.Optional(Type.String()),thinking:Type.Optional(Type.String()),maxTurns:Type.Optional(Type.Integer({minimum:1})),files:Type.Optional(Type.Array(Type.String())),context:Type.Optional(Type.Object({mode:Type.Union([Type.Literal("snapshot"),Type.Literal("fork")]),sourceSessionId:Type.String(),branchLeafId:Type.String(),entryAnchorId:Type.String()}))}),
    async execute(_id,p,_signal,_update,ctx){await init(ctx);const {version,...request}=p;return reply(await orchestration!.admit(request,{type:p.role,description:p.role,isBackground:true}));}});
  registerTool({name:"subagent_job",label:"Optional agent job",description:"Opt-in one-shot/interval/UTC cron jobs. All launches use native admission. Pausing future fires is separate from stopping an active run.",parameters:Type.Object({action:Type.Union(["list","create","pause","resume","stop_active"].map(v=>Type.Literal(v))),job_id:Type.Optional(Type.String()),schedule:Type.Optional(Type.Any()),request:Type.Optional(Type.Any())}),
    async execute(_id,p,_signal,_update,ctx){await init(ctx);try{const value=await orchestration!.jobs(p.action,p);await orchestration!.flush();return reply(value);}catch{return reply({ok:false,code:"invalid_or_disabled_job"});}}});
  registerTool({name:"subagent_workflow",label:"Optional declarative workflow",description:"Opt-in bounded specialist graph; no scripts or shell grants. Structured result validation is local. Verification requires parent-owned evidence through human UI, not this tool.",parameters:Type.Object({action:Type.Union(["list","start","inspect","pause","resume","retry","skip","cancel"].map(v=>Type.Literal(v))),workflow_id:Type.Optional(Type.String()),step_id:Type.Optional(Type.String()),plan:Type.Optional(Type.Any())}),
    async execute(_id,p,_signal,_update,ctx){await init(ctx);try{const value=await orchestration!.workflow(p.action,p);await orchestration!.flush();return reply(value);}catch{return reply({ok:false,code:"invalid_or_disabled_workflow"});}}});
  pi.registerCommand("agents", { description: "Agent tasks/settings/types/tree/import/reload/reap and exact-run controls; import asks the current model to migrate selected definitions", handler: async (_args, ctx) => {
    if (!ctx.hasUI) return;
    try{
    if(_args.trim()==="storage"){
      const root=join(agentDir,"subagents-state"),lease=await inspectStorageLease(root);
      if(await ctx.ui.confirm("Review stale storage lease",`${JSON.stringify(lease)}\nOnly a dead process lease may be reconciled. Original lock is kept as evidence; jobs never auto-replay.`)){
        await reconcileStorageLease(root,lease);boot=undefined;ctx.ui.notify("Dead lease reconciled; original lock retained. Run /agents again to load paused recovery metadata.","info");
      }return;
    }
    await init(ctx);
    adoptContext(ctx);
    const topic=_args.trim()||"settings";
    if(!topic)return;
    if(topic==="tasks" || topic.startsWith("tasks ")){presentation.open(ctx,topic==="tasks"?undefined:topic.slice(6).trim());return;}
    if(await managerUI!.command(topic,ctx))return;
    if(topic==="tree" || topic.startsWith("tree ") || topic.startsWith("/root/")){await navigation.open(ctx,rootThreads(),topic==="tree"?undefined:topic.startsWith("tree ")?topic.slice(5).trim():topic,managerUI!.settings.nerdFontIcons,managerUI!.settings.loaderStyle);return;}
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
    if(topic!=="fleet")throw Error("Use /agents [tasks|tree|/root/task|fleet|results|notifications|jobs|workflows|artifacts]");
    const choices = [...records].map(([id,r]) => `${id} | ${r.role} | ${supervisor?.inspect(r.threadId)?.state}`);
    const selected = await ctx.ui.select("Native agent fleet", choices.length ? choices : ["No workers. Ask Pi to use Agent."]);
    const record = selected && records.get(selected.split(" | ")[0]); if (!record || !supervisor) return;
    const action = await ctx.ui.select("Worker controls", ["Inspect", "Message", "Steer", "Follow up", "Resume", "Extend turn budget", "Interrupt", "Consume result", "Close thread"]);
    if (!action) return;
    if (action === "Inspect") {
      const snapshot = () => JSON.stringify({...supervisor?.inspect(record.threadId),model:record.model,task:record.task,name:record.name},null,2).slice(0,16000)+"\nReceipts:\n"+(receipts.get(record.threadId)??"")+"\n"+(activity.get(record.threadId) ?? "");
      if(ctx.mode === "tui") await ctx.ui.custom((_tui,_theme,_keys,done) => new Inspector(_tui,snapshot,listener=>{viewers.add(listener);return ()=>viewers.delete(listener);},done));
      else await ctx.ui.select(snapshot().slice(-16000),["Back"]);
      return;
    }
    if(action==="Extend turn budget"){
      const current=supervisor.inspect(record.threadId),input=await ctx.ui.input("Additional turns","At most the initial soft allowance per grant; two grants per lifetime. Usage and deadline do not reset.");
      if(!input||!/^\d+$/.test(input))return;
      const additionalTurns=Number(input);
      if(!Number.isSafeInteger(additionalTurns)||additionalTurns<1||!await ctx.ui.confirm("Extend this exact run?",`Grant ${additionalTurns} turns to ${record.runId}. Current budget: ${JSON.stringify(current?.budget)}. Hard-exhausted sessions cannot be revived.`))return;
      const receipt=await orchestration!.control({version:1,operation:"extend_budget",threadId:record.threadId,expectedRunId:record.runId,additionalTurns});
      ctx.ui.notify(JSON.stringify(receipt),receipt.status==="rejected"?"warning":"info");refreshFleet();return;
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
