// Global definitions are user-owned. Never discover roles or factories from the project cwd.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Provider } from "@earendil-works/pi-ai";
import type { Available, Definition, Options, Loadout, Resolution } from "./roles.ts";
import { resolveLoadout } from "./roles.ts";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, createWriteToolDefinition, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { HeadroomChildLease } from "../headroom/index.ts";
import { assertWritable, validateWorktree,inspectWorktree } from "./worktrees.ts";
import type { WorktreeLease } from "./worktrees.ts";
import { NativeBackend } from "./backend.ts";
import type { BackendResult } from "./backend.ts";
import type {ContextSnapshot}from"./context.ts";
import {limits,utf8Bytes}from"./contracts.ts";

export type TrustedResolution = { ok: true; loadout: Loadout; prompt: string; thinking: "medium" | "high"; fingerprint: string } |
  { ok: false; code: NonNullable<Resolution["error"]> | "invalid_definition" };
const keys = new Set(["description", "display_name", "tools", "extensions", "disallowed_tools", "skills", "thinking", "max_turns", "prompt_mode", "inherit_context", "run_in_background", "isolation", "persist_session", "output_transcript", "model"]);
const list = (value: string): string[] => value.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "").split(",").map(item => item.trim()).filter(Boolean);
/** Parse only the audited canonical template grammar; never execute YAML tags or imports. */
function parseRole(text: string): { definition: Definition; prompt: string; thinking: "medium" | "high" } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(text);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!entry || !keys.has(entry[1]) || fields.has(entry[1])) return undefined;
    fields.set(entry[1], entry[2]);
  }
  const required = ["description", "display_name", "tools", "extensions", "disallowed_tools", "skills", "thinking", "max_turns", "prompt_mode", "inherit_context", "run_in_background", "persist_session", "output_transcript"];
  if (required.some(key => !fields.get(key)) || !["medium", "high"].includes(fields.get("thinking")!) || fields.get("prompt_mode") !== "append" || fields.get("run_in_background") !== "true" ||
    !["true", "false"].includes(fields.get("inherit_context")!) || !["true", "false"].includes(fields.get("persist_session")!) || !["true", "false"].includes(fields.get("output_transcript")!) ||
    !/^\d+$/.test(fields.get("max_turns")!) || !match[2].trim()) return undefined;
  const tools = list(fields.get("tools")!);
  const disallowed = list(fields.get("disallowed_tools")!);
  if (tools.some(tool => disallowed.includes(tool)) || !disallowed.includes("headroom_stats") || !disallowed.includes("headroom_retrieve")) return undefined;
  return { definition: { provenance: "trusted-global", enabled: true, tools, extensions: list(fields.get("extensions")!), skills: list(fields.get("skills")!),
    maxTurns: Number(fields.get("max_turns")), inheritContext: fields.get("inherit_context") === "true", persistSession: fields.get("persist_session") === "true", outputTranscript: fields.get("output_transcript") === "true",
    isolation: fields.get("isolation"), model: fields.get("model") }, prompt: match[2], thinking: fields.get("thinking") as "medium" | "high" };
}
export async function resolveTrustedRole(role: string, agentDir: string, available: Available, options: Options): Promise<TrustedResolution> {
  if (!["researcher", "code-mapper", "builder", "reviewer"].includes(role)) return { ok: false, code: "unknown_role" };
  const directory = join(agentDir, "agents");
  const path = join(directory, `${role}.md`);
  try {
    if (!(await lstat(directory)).isDirectory() || !(await lstat(path)).isFile()) return { ok: false, code: "untrusted_role" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, code: "unknown_role" };
    return { ok: false, code: "untrusted_role" };
  }
  let parsed, text: string;
  try { text = await readFile(path, "utf8"); parsed = parseRole(text); }
  catch { return { ok: false, code: "invalid_definition" }; }
  if (!parsed) return { ok: false, code: "invalid_definition" };
  const result = resolveLoadout(role, { [role]: parsed.definition }, available, options);
  if (!result.loadout) return { ok: false, code: result.error! };
  return { ok: true, loadout: result.loadout, prompt: parsed.prompt, thinking: parsed.thinking, fingerprint: createHash("sha256").update(text).digest("hex") };
}

export async function probeApprovedResources(options: { agentDir: string; cwd: string; approved: readonly string[]; fffPath?: string; unapproved?: () => void }): Promise<{ ok: true; tools: string[] } | { ok: false; code: "unsupported_resource" }> {
  // Bounded loader probe only. Never run an ambient factory and filter afterward.
  if (options.approved.length !== 1 || !["web-research", "fff"].includes(options.approved[0]) || (options.approved[0] === "fff" && !options.fffPath)) return { ok: false, code: "unsupported_resource" };
  const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    additionalExtensionPaths: [options.approved[0] === "fff" ? options.fffPath! : new URL("../web-research/index.ts", import.meta.url).pathname],
    extensionFactories: [] });
  try {
    await loader.reload();
    const extensions = loader.getExtensions();
    if (extensions.errors.length || extensions.extensions.length !== 1) return { ok: false, code: "unsupported_resource" };
    return { ok: true, tools: [...extensions.extensions[0].tools.keys()] };
  } catch { return { ok: false, code: "unsupported_resource" }; }
}

/** Explicit native providers or an audited parent route; never discover ambient auth/resources. */
export async function createTrustedRoleBackend(options: { role: string; agentDir: string; cwd: string; model: string; provider?: Provider; available: Available;
  routing?: "native" | "headroom"; reviewedHeadroom?: Readonly<{ enabled: boolean }>;
  /** Caller-reviewed request credential, kept in the child runtime only; no parent auth-store copy. */
  headroom?: { registry: ModelRegistry; proxyUrl: string; apiKey: string };
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"; expectedDefinition?: string;
  extensionFactories?: Record<string, () => unknown>;
  fffPath?: string; skillPaths?: Record<string, string>; fffMultigrepEnabled?: boolean;
  worktreeLease?: WorktreeLease;context?:ContextSnapshot }): Promise<BackendResult> {
  if(options.context&&(options.role==="researcher"||options.context.serializedBytes>limits.contextBytes||options.context.serializedBytes!==utf8Bytes(JSON.stringify({sourceSessionId:options.context.sourceSessionId,branchLeafId:options.context.branchLeafId,entryAnchorId:options.context.entryAnchorId,sourceEntryIds:options.context.sourceEntryIds,messages:options.context.messages,policy:options.context.policy}))))return {ok:false,code:"unsupported_resource"};
  if (options.reviewedHeadroom && typeof options.reviewedHeadroom.enabled !== "boolean") return { ok: false, code: "unsupported_routing" };
  const routing = options.reviewedHeadroom ? (options.reviewedHeadroom.enabled ? "headroom" : "native") : options.routing;
  if (options.routing && routing !== options.routing) return { ok: false, code: "unsupported_routing" };
  if (routing !== "native" && routing !== "headroom") return { ok: false, code: "unsupported_routing" };
  if (routing === "headroom" && (!options.headroom || typeof options.headroom.apiKey !== "string" ||
    !options.headroom.apiKey.trim() || options.provider || options.role !== "researcher")) return { ok: false, code: "unsupported_routing" };
  const resolved = await resolveTrustedRole(options.role, options.agentDir, options.available, { model: options.model, routing });
  if (!resolved.ok) return { ok: false, code: resolved.code === "model_unavailable" || resolved.code === "invalid_model" ? "unsupported_provider" : "unsupported_resource" };
  if (options.expectedDefinition && resolved.fingerprint !== options.expectedDefinition) return { ok: false, code: "unsupported_resource" };
  const assignment = resolved.loadout.model!;
  const slash = assignment.indexOf("/"), providerId = assignment.slice(0, slash), modelId = assignment.slice(slash + 1);
  if (routing === "native" && (!options.provider || providerId !== options.provider.id)) return { ok: false, code: "unsupported_provider" };
  // OAuth/custom providers need separately proven auth/header forwarding.
  if (routing === "headroom" && providerId !== "openai") return { ok: false, code: "unsupported_provider" };
  if (resolved.loadout.isolation === "worktree" && (!options.worktreeLease || options.cwd !== options.worktreeLease.path || !(await validateWorktree(options.worktreeLease)))) return { ok: false, code: "unsupported_resource" };
  const research = options.role === "researcher";
  const extensionPath = research ? new URL("../web-research/index.ts", import.meta.url).pathname : options.fffPath;
  if (!extensionPath || (!research && !["code-mapper", "reviewer", "builder"].includes(options.role))) return { ok: false, code: "unsupported_resource" };
  const skillPaths = research ? { "my-web-search": new URL("../../../skills/my-web-search/SKILL.md", import.meta.url).pathname } : options.skillPaths ?? {};
  if (Object.keys(skillPaths).sort().join() !== [...resolved.loadout.skills].sort().join()) return { ok: false, code: "unsupported_resource" };
  const expectedExtensions = research ? ["web_fetch", "web_search"] : ["fffind", "ffgrep", "fff-multi-grep"];
  const expectedTools = research ? expectedExtensions : ["read", "grep", "find", "ls", ...expectedExtensions, ...(options.role === "builder" ? ["edit", "write"] : [])];
  let lease: HeadroomChildLease | undefined, session: AgentSession | undefined, transferred = false;
  try {
    if (routing === "headroom") {
      const { acquireHeadroomChildRoute } = await import("../headroom/index.ts");
      const route = await acquireHeadroomChildRoute({ registry: options.headroom!.registry, model: assignment, proxyUrl: options.headroom!.proxyUrl });
      if (!route.ok) return route;
      lease = route.lease;
    }
    const texts: string[] = [];
    for (const name of resolved.loadout.skills) {
      const path = skillPaths[name];
      if (!(await lstat(path)).isFile()) return { ok: false, code: "unsupported_resource" };
      const text = await readFile(path, "utf8");
      if (!new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`, "m").test(text) && !research) return { ok: false, code: "unsupported_resource" };
      texts.push(`<approved-skill name="${name}">\n${text}\n</approved-skill>`);
    }
    if (!(await lstat(extensionPath)).isFile()) return { ok: false, code: "unsupported_resource" };
    // The actual FFF 0.10.5 reads this flag at factory load. We do not mutate
    // process.env; callers must opt in before invoking the loader.
    if (!research && options.fffMultigrepEnabled && process.env.PI_FFF_MULTIGREP !== "1") return { ok: false, code: "unsupported_resource" };
    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
      disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"], extensionFactories: [],
      additionalExtensionPaths: [extensionPath], additionalSkillPaths: Object.values(skillPaths),
      systemPrompt: resolved.prompt, appendSystemPrompt: texts });
    await loader.reload();
    const loaded = loader.getExtensions(), skills = loader.getSkills();
    if (loaded.errors.length || loaded.extensions.length !== 1 ||
      [...loaded.extensions[0].tools.keys()].sort().join() !== expectedExtensions.sort().join() ||
      skills.diagnostics.length || skills.skills.map(skill => skill.name).sort().join() !== [...resolved.loadout.skills].sort().join()) return { ok: false, code: "unsupported_resource" };
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => {} } });
    if (routing === "native") runtime.registerNativeProvider(options.provider!);
    else {
      const { proxyBaseUrlForApi } = await import("../headroom/index.ts");
      const { installGuardedHeadroomRoute } = await import("./route-transport.ts");
      const canonical = runtime.getModel(providerId, modelId);
      if (!canonical) return { ok: false, code: "unsupported_provider" };
      await runtime.setRuntimeApiKey(providerId, options.headroom!.apiKey);
      if (!installGuardedHeadroomRoute({ runtime, model: assignment,
        proxyBaseUrl: proxyBaseUrlForApi(new URL(options.headroom!.proxyUrl).origin, canonical.api), lease: lease! })) return { ok: false, code: "unsupported_routing" };
    }
    const model = runtime.getModel(providerId, modelId);
    if (!model || !(await runtime.checkAuth(providerId)) || !(await runtime.getAuth(model))) return { ok: false, code: "unsupported_provider" };
    const customTools = options.role === "builder" ? [createWriteToolDefinition(options.cwd), createEditToolDefinition(options.cwd)].map(tool => ({ ...tool,
      execute: async (id: string, params: any, signal: AbortSignal | undefined, update: any, ctx: any) => {
        if (ctx && ctx.cwd !== options.worktreeLease!.path) throw Error("forbidden changed worktree cwd");
        const path = await assertWritable(options.worktreeLease!, params.path);
        return tool.execute(id, { ...params, path }, signal, update, ctx);
      } })) : [];
    const sessionManager=SessionManager.inMemory(options.cwd);
    for(const message of options.context?.messages??[])sessionManager.appendMessage(structuredClone(message));
    ({ session } = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, modelRuntime: runtime, model,
      resourceLoader: loader, settingsManager, sessionManager,
      tools: expectedTools, customTools, thinkingLevel: options.thinking ?? resolved.thinking }));
    await session.bindExtensions({});
    if (session.getActiveToolNames().sort().join() !== expectedTools.sort().join() ||
      session.getCallableToolNames().sort().join() !== expectedTools.sort().join()) return { ok: false, code: "unsupported_resource" };
    const backend = new NativeBackend(session, lease ? () => lease!.release() : undefined,options.worktreeLease?async()=>Object.freeze([await inspectWorktree(options.worktreeLease!)]):undefined);
    transferred = true;
    return { ok: true, backend };
  } catch { return { ok: false, code: "initialization_failed" }; }
  finally {
    if (!transferred) {
      try { session?.dispose(); } finally { await lease?.release(); }
    }
  }
}
