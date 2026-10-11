import assert from "node:assert/strict";
import test from "node:test";
import { resolveLoadout } from "./roles.ts";
const registry = {
  researcher: { provenance: "trusted-global", enabled: true, tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research", "headroom"], skills: ["my-web-search"], maxTurns: 20, inheritContext: false, persistSession: false, outputTranscript: false },
  builder: { provenance: "trusted-global", enabled: true, tools: ["read", "grep", "find", "ls", "edit", "write", "ext:fff/fffind", "ext:fff/ffgrep", "ext:fff/fff-multi-grep"], extensions: ["headroom", "fff"], skills: ["code-review"], maxTurns: 60, inheritContext: false, persistSession: false, outputTranscript: false, isolation: "worktree" },
};
const available = { tools: [...registry.researcher.tools, ...registry.builder.tools], extensions: ["web-research", "headroom", "fff"], skills: ["my-web-search", "code-review"], models: ["openai/model-a"] };
test("explicit native routing keeps canonical Ciung tools and skill without requiring Headroom", () => {
  const native = resolveLoadout("researcher", registry, { ...available, extensions: ["web-research"] }, { model: "openai/model-a", routing: "native" });
  assert.equal(native.error, undefined);
  assert.deepEqual(native.loadout?.extensions, ["web-research"]);
  assert.deepEqual(native.loadout?.tools, registry.researcher.tools);
  assert.deepEqual(native.loadout?.skills, ["my-web-search"]);
  assert.equal(native.loadout?.routing, "native");
  assert.equal(resolveLoadout("researcher", registry, { ...available, extensions: ["web-research"] }, { model: "openai/model-a", routing: "headroom" }).error, "missing_resource");
});
test("unknown and disabled roles fail closed rather than inheriting general-purpose", () => {
  assert.equal(resolveLoadout("unknown", registry, available, {}).error, "unknown_role");
  assert.equal(resolveLoadout("researcher", { ...registry, researcher: { ...registry.researcher, enabled: false } }, available, {}).error, "disabled_role");
});
test("effective loadout requires trusted provenance, exact resources and no expanded role authority", () => {
  assert.equal(resolveLoadout("researcher", { ...registry, researcher: { ...registry.researcher, provenance: "project" } }, available, {}).error, "untrusted_role");
  assert.equal(resolveLoadout("researcher", registry, { ...available, tools: ["read"] }, {}).error, "missing_resource");
  assert.equal(resolveLoadout("researcher", registry, { ...available, extensions: ["headroom"] }, {}).error, "missing_resource");
  assert.equal(resolveLoadout("researcher", registry, { ...available, skills: [] }, {}).error, "missing_resource");
  assert.equal(resolveLoadout("researcher", { ...registry, researcher: { ...registry.researcher, tools: ["read"] } }, available, {}).error, "authority_expansion");
  assert.equal(resolveLoadout("researcher", { ...registry, researcher: { ...registry.researcher, inheritContext: true } }, available, {}).error, "authority_expansion");
  assert.equal(resolveLoadout("builder", { ...registry, builder: { ...registry.builder, isolation: undefined } }, available, {}).error, "authority_expansion");
});
test("model pin precedes invocation and parent; explicit unavailable model fails", () => {
  assert.equal(resolveLoadout("researcher", registry, available, {}).error, "model_unavailable");
  assert.equal(resolveLoadout("researcher", registry, available, { model: "openai/missing" }).error, "model_unavailable");
  assert.equal(resolveLoadout("researcher", registry, available, { model: "fuzzy" }).error, "invalid_model");
  assert.equal(resolveLoadout("researcher", registry, available, { parentModel: "openai/model-a" }).loadout?.model, "openai/model-a");
  assert.equal(resolveLoadout("researcher", { ...registry, researcher: { ...registry.researcher, model: "openai/missing" } }, available, { model: "openai/model-a" }).error, "model_unavailable");
});
test("invocation may lower turns, never enlarge ceiling; evaluator has no grace", () => {
  assert.equal(resolveLoadout("builder", registry, available, { parentModel: "openai/model-a", maxTurns: 61 }).error, "turn_ceiling");
  const resolved = resolveLoadout("builder", registry, available, { parentModel: "openai/model-a", maxTurns: 2 });
  assert.equal(resolved.loadout?.softTurns, 2);
  assert.equal(resolved.loadout?.hardTurns, 7);
  assert.equal(resolveLoadout("reviewer", registry, available, { evaluator: true }).error, "unknown_role");
  assert.equal(resolveLoadout("researcher", registry, available, { evaluator: true }).error, "evaluator_role");
});