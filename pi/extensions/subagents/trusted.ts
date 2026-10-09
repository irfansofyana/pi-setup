// Global definitions are user-owned. Never discover roles or factories from the project cwd.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { Available, Definition, Options, Loadout, Resolution } from "./roles.ts";
import { resolveLoadout } from "./roles.ts";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { NativeBackend } from "./backend.ts";
import type { BackendResult } from "./backend.ts";

export type TrustedResolution = { ok: true; loadout: Loadout; prompt: string } |
  { ok: false; code: NonNullable<Resolution["error"]> | "invalid_definition" };
const keys = new Set(["description", "display_name", "tools", "extensions", "disallowed_tools", "skills", "thinking", "max_turns", "prompt_mode", "inherit_context", "run_in_background", "isolation", "persist_session", "output_transcript", "model"]);
const list = (value: string): string[] => value.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "").split(",").map(item => item.trim()).filter(Boolean);
/** Parse only the audited canonical template grammar; never execute YAML tags or imports. */
function parseRole(text: string): { definition: Definition; prompt: string } | undefined {
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
    isolation: fields.get("isolation"), model: fields.get("model") }, prompt: match[2] };
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
  let parsed;
  try { parsed = parseRole(await readFile(path, "utf8")); }
  catch { return { ok: false, code: "invalid_definition" }; }
  if (!parsed) return { ok: false, code: "invalid_definition" };
  const result = resolveLoadout(role, { [role]: parsed.definition }, available, options);
  if (!result.loadout) return { ok: false, code: result.error! };
  return { ok: true, loadout: result.loadout, prompt: parsed.prompt };
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

/** No canonical role is runnable until *all* approved factories, skills and Headroom
 * routing leases are safely bound. A successful read-only fixture is not a role run. */
export async function createTrustedRoleBackend(options: { role: string; agentDir: string; cwd: string; model: string; provider: Provider; available: Available;
  routing?: "native" | "headroom"; reviewedHeadroom?: Readonly<{ enabled: boolean }>;
  extensionFactories?: Record<string, () => unknown>;
  fffPath?: string; skillPaths?: Record<string, string>; fffMultigrepEnabled?: boolean;
  /** Only an owner-issued worktree lease may enable builder; ownership is not implemented in M1. */
  worktreeLease?: never }): Promise<BackendResult> {
  if (options.reviewedHeadroom && typeof options.reviewedHeadroom.enabled !== "boolean") return { ok: false, code: "unsupported_routing" };
  const routing = options.reviewedHeadroom ? (options.reviewedHeadroom.enabled ? "headroom" : "native") : options.routing;
  if (options.routing && routing !== options.routing) return { ok: false, code: "unsupported_routing" };
  if (routing !== "native") return { ok: false, code: "unsupported_routing" };
  const resolved = await resolveTrustedRole(options.role, options.agentDir, options.available, { model: options.model, routing });
  if (!resolved.ok) return { ok: false, code: resolved.code === "model_unavailable" || resolved.code === "invalid_model" ? "unsupported_provider" : "unsupported_resource" };
  if (resolved.loadout.model?.split("/")[0] !== options.provider.id) return { ok: false, code: "unsupported_provider" };
  // Enabled (or unreviewed) routing never constructs a native child.
  if (resolved.loadout.routing !== "native") return { ok: false, code: "unsupported_routing" };
  if (resolved.loadout.isolation === "worktree") return { ok: false, code: "unsupported_resource" };
  const research = options.role === "researcher";
  const extensionPath = research ? new URL("../web-research/index.ts", import.meta.url).pathname : options.fffPath;
  if (!extensionPath || (!research && !["code-mapper", "reviewer"].includes(options.role))) return { ok: false, code: "unsupported_resource" };
  const skillPaths = research ? { "my-web-search": new URL("../../../skills/my-web-search/SKILL.md", import.meta.url).pathname } : options.skillPaths ?? {};
  if (Object.keys(skillPaths).sort().join() !== [...resolved.loadout.skills].sort().join()) return { ok: false, code: "unsupported_resource" };
  const expectedExtensions = research ? ["web_fetch", "web_search"] : ["fffind", "ffgrep", "fff-multi-grep"];
  const expectedTools = research ? expectedExtensions : ["read", "grep", "find", "ls", ...expectedExtensions];
  try {
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
    runtime.registerNativeProvider(options.provider);
    const providerId = options.provider.id, modelId = options.model.slice(providerId.length + 1);
    const model = runtime.getModel(providerId, modelId);
    if (!model || !(await runtime.checkAuth(providerId)) || !(await runtime.getAuth(model))) return { ok: false, code: "unsupported_provider" };
    const { session } = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, modelRuntime: runtime, model,
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(options.cwd),
      tools: expectedTools, thinkingLevel: "off" });
    try {
      await session.bindExtensions({});
      if (session.getActiveToolNames().sort().join() !== expectedTools.sort().join() ||
        session.getCallableToolNames().sort().join() !== expectedTools.sort().join()) return { ok: false, code: "unsupported_resource" };
      return { ok: true, backend: new NativeBackend(session) };
    } finally {
      if (session.getActiveToolNames().sort().join() !== expectedTools.sort().join() ||
        session.getCallableToolNames().sort().join() !== expectedTools.sort().join()) session.dispose();
    }
  } catch { return { ok: false, code: "initialization_failed" }; }
}
