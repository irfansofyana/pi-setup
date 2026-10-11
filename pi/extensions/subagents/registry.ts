import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ConfigStore, type ConfigStoreOptions } from "./upstream/src/prefs/config.ts";
import { selectPreferredModel } from "./upstream/src/prefs/models.ts";
import type { AgentType, ThinkingLevel } from "./upstream/src/types.ts";
import type { Loadout } from "./roles.ts";
import { selectOptionalTools, selectOptionalSkills, usesBundledResources } from "./parent-resources.ts";

export const canonicalRole = (name: string) => name === "code-mapper" ? "scout" : name;
export const delegationTools = ["agent_types", "agent_spawn", "agent_wait", "agent_steer", "agent_status", "agent_stop", "agent_output"] as const;
export const reviewedTools = ["read", "grep", "find", "ls", "edit", "write", "web_search", "web_fetch", "fffind", "ffgrep", "fff-multi-grep", ...delegationTools] as const;
const local = ["read", "grep", "find", "ls", "fffind", "ffgrep", "fff-multi-grep"];
const policies: Record<string, { tools: string[]; turns: number; skills: string[]; isolation?: string }> = {
  researcher: { tools: ["web_search", "web_fetch"], turns: 20, skills: ["my-web-search"] },
  scout: { tools: local, turns: 25, skills: ["mermaid", "teach"] },
  reviewer: { tools: local, turns: 25, skills: ["code-review"] },
  builder: { tools: [...local, "edit", "write"], turns: 60, skills: ["code-review"], isolation: "worktree" },
};

class AgentRegistry extends ConfigStore {
  get(name: string) { return super.get(canonicalRole(name)); }
  save(...args: Parameters<ConfigStore["save"]>) { validateTools(args[0],true); return super.save(...args); }
  saveOverride(...args: Parameters<ConfigStore["saveOverride"]>) { validateTools(args[1],true); return super.saveOverride(...args); }
}

function validateTools(type: AgentType,saving=false){
  if(saving&&type.name==="code-mapper")throw Error("code-mapper is a reserved scout alias");
  const role=canonicalRole(type.name),policy=policies[role];
  const selected=(type.tools?.allow??[]).filter(name=>!type.tools?.block?.includes(name));
  if(selected.some(name=>!(reviewedTools as readonly string[]).includes(name)))throw Error("Unsupported tool in agent definition");
  if(policy&&selected.some(name=>!policy.tools.includes(name)))throw Error(`Canonical ${role} tool boundary cannot expand`);
  return selected;
}

export function createAgentRegistry(options: Omit<ConfigStoreOptions, "bundledDir">) {
  return new AgentRegistry({ ...options, bundledDir: fileURLToPath(new URL("./agents/", import.meta.url)) });
}

export type AgentDefinition = {
  ok: true; loadout: Loadout; prompt: string; thinking: ThinkingLevel; fingerprint: string;
  type: AgentType; toolNames: string[];
};

/** Resolve only data from the upstream registry; never execute a definition factory. */
export function resolveAgentDefinition(type: AgentType, options: {
  model?: string; explicitModel?:string; models: string[]; scopedModels?: string[]; maxTurns?: number; thinking?: ThinkingLevel;
  modelSelection?: "pick-first-available" | "pick-first-scoped" | "use-current";
  availableTools?: readonly string[]; availableSkills?: readonly string[];
}): AgentDefinition {
  const role = canonicalRole(type.name), policy = policies[role];
  const selected = selectOptionalTools(validateTools(type), usesBundledResources(type) ? "bundled" : type.source, options.availableTools);
  const modelSelection = options.modelSelection ?? "pick-first-available";
  const eligible = modelSelection === "pick-first-scoped" && options.scopedModels?.length ? options.models.filter(model => options.scopedModels!.includes(model)) : options.models;
  const preferred = options.explicitModel!==undefined ? options.explicitModel : modelSelection === "use-current" ? undefined : selectPreferredModel(type, eligible.map(identity => {
    const slash = identity.indexOf("/"); return { model: { provider: identity.slice(0, slash), id: identity.slice(slash + 1) } };
  }), modelSelection === "pick-first-scoped");
  const model = preferred ?? options.model;
  if (!model || !/^[^\s/]+\/[^\s]+$/.test(model) || !options.models.includes(model)) throw Error("Exact available provider/model-id required");
  if (options.scopedModels?.length && !options.scopedModels.includes(model)) throw Error("Model outside parent scope");
  const maximum = policy?.turns ?? 40, turns = options.maxTurns ?? maximum;
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > maximum) throw Error("Requested turn budget exceeds role ceiling");
  const extensions = [...(selected.some(name => ["web_search", "web_fetch"].includes(name)) ? ["web-research"] : []),
    ...(selected.some(name => ["fffind", "ffgrep", "fff-multi-grep"].includes(name)) ? ["fff"] : [])];
  const tools = selected.map(name => ["web_search", "web_fetch"].includes(name) ? `ext:web-research/${name}` : ["fffind", "ffgrep", "fff-multi-grep"].includes(name) ? `ext:fff/${name}` : name);
  const snapshot = structuredClone(type);
  const loadout: Loadout = Object.freeze({ role, provenance: type.source==="bundled"?"bundled":type.source==="project"?"trusted-project":"trusted-global", routing: "native", tools: Object.freeze(tools),
    extensions: Object.freeze(extensions), skills: Object.freeze(selectOptionalSkills(role, policy?.skills ?? [], options.availableSkills)), model,
    softTurns: turns, graceTurns: 5, hardTurns: turns + 5,
    isolation: policy?.isolation ?? (selected.some(name => ["edit", "write"].includes(name)) ? "worktree" : undefined),
    inheritContext: false, persistSession: false, outputTranscript: false });
  return { ok: true, loadout, prompt: snapshot.systemPrompt, thinking: snapshot.thinkingLevel ?? options.thinking ?? "medium",
    fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), type: snapshot, toolNames: [...selected] };
}
