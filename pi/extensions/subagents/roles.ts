// Trusted definitions are supplied by an approved global resolver in M1, never discovered from cwd here.
export type Definition = { provenance: string; enabled: boolean; tools: string[]; extensions: string[]; skills: string[]; maxTurns: number; inheritContext: boolean; persistSession: boolean; outputTranscript: boolean; isolation?: string; model?: string };
export type Available = { tools: string[]; extensions: string[]; skills: string[]; models: string[] };
export type Options = { model?: string; parentModel?: string; maxTurns?: number; evaluator?: boolean; routing?: "native" | "headroom" };
const web = ["ext:web-research/web_search", "ext:web-research/web_fetch"];
const local = ["read", "grep", "find", "ls", "ext:fff/fffind", "ext:fff/ffgrep", "ext:fff/fff-multi-grep"];
const ceilings: Record<string, { tools: string[]; extensions: string[]; skills: string[]; maxTurns: number; isolation?: string }> = {
  researcher: { tools: web, extensions: ["web-research", "headroom"], skills: ["my-web-search"], maxTurns: 20 },
  "code-mapper": { tools: local, extensions: ["headroom", "fff"], skills: ["mermaid", "teach"], maxTurns: 25 },
  builder: { tools: [...local, "edit", "write"], extensions: ["headroom", "fff"], skills: ["code-review"], maxTurns: 60, isolation: "worktree" },
  reviewer: { tools: local, extensions: ["headroom", "fff"], skills: ["code-review"], maxTurns: 25 },
};
export type Loadout = Readonly<{ role: string; provenance: "trusted-global"; routing: "native" | "headroom"; tools: readonly string[]; extensions: readonly string[]; skills: readonly string[]; model?: string; softTurns: number; graceTurns: number; hardTurns: number; isolation?: string; inheritContext: false; persistSession: false; outputTranscript: false }>;
export type Resolution = { loadout?: Loadout; error?: "unknown_role" | "disabled_role" | "untrusted_role" | "authority_expansion" | "missing_resource" | "invalid_model" | "model_unavailable" | "turn_ceiling" | "evaluator_role" };
const equalSet = (actual: string[], expected: string[]) => actual.length === expected.length && new Set(actual).size === actual.length && actual.every((item) => expected.includes(item));
export function resolveLoadout(role: string, definitions: Record<string, Definition>, available: Available, options: Options): Resolution {
  const ceiling = ceilings[role], def = definitions[role];
  if (!ceiling || !def) return { error: "unknown_role" };
  if (!def.enabled) return { error: "disabled_role" };
  if (def.provenance !== "trusted-global") return { error: "untrusted_role" };
  if (options.evaluator) return { error: "evaluator_role" }; // Explore evaluator is not authorized until dedicated reviewed loadout exists.
  if (!equalSet(def.tools, ceiling.tools) || !equalSet(def.extensions, ceiling.extensions) || !equalSet(def.skills, ceiling.skills) ||
    def.maxTurns !== ceiling.maxTurns || def.isolation !== ceiling.isolation || def.inheritContext !== false || def.persistSession !== false || def.outputTranscript !== false)
    return { error: "authority_expansion" };
  const routing = options.routing ?? "headroom"; // Existing unconfigured callers stay fail-closed, never silently native.
  const effectiveExtensions = routing === "native" ? def.extensions.filter(extension => extension !== "headroom") : def.extensions;
  for (const [required, supplied] of [[def.tools, available.tools], [effectiveExtensions, available.extensions], [def.skills, available.skills]]) {
    if (!(required as string[]).every((item) => (supplied as string[]).includes(item))) return { error: "missing_resource" };
  }
  const model = def.model ?? options.model ?? options.parentModel;
  if (model !== undefined && !/^[^\s/]+\/[^\s/]+$/.test(model)) return { error: "invalid_model" };
  if (model === undefined || !available.models.includes(model)) return { error: "model_unavailable" };
  if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > def.maxTurns)) return { error: "turn_ceiling" };
  const softTurns = options.maxTurns ?? def.maxTurns;
  return { loadout: Object.freeze({ role, provenance: "trusted-global", routing, tools: Object.freeze([...def.tools]), extensions: Object.freeze([...effectiveExtensions]), skills: Object.freeze([...def.skills]), model, softTurns, graceTurns: 5, hardTurns: softTurns + 5, isolation: def.isolation, inheritContext: false, persistSession: false, outputTranscript: false }) };
}
