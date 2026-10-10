import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveContext } from "./context.ts";

function source() {
  const manager = SessionManager.inMemory("/fixture");
  const root = manager.appendMessage({ role: "user", content: "public question", timestamp: 1 });
  const call = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "fixture.txt" } }], provider: "fixture", model: "offline", api: "fixture", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 });
  const result = manager.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "public result" }], isError: false, timestamp: 3 });
  return { manager, root, call, result };
}
const request = (m: SessionManager, anchor: string, mode: "snapshot" | "fork" = "snapshot") => ({ mode, sourceSessionId: m.getSessionId(), branchLeafId: m.getLeafId()!, entryAnchorId: anchor });

test("snapshot uses authoritative active branch and anchor, with exact lineage and coherent tool pair", () => {
  const { manager, root, result } = source();
  const selected = resolveContext(request(manager, result), () => manager, "code-mapper");
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(selected.snapshot.sourceSessionId, manager.getSessionId());
  assert.equal(selected.snapshot.branchLeafId, result);
  assert.equal(selected.snapshot.entryAnchorId, result);
  assert.deepEqual(selected.snapshot.sourceEntryIds, [root, manager.getBranch()[1].id, result]);
  assert.deepEqual(selected.snapshot.messages.map(m => m.role), ["user", "assistant", "toolResult"]);
  assert.ok(selected.snapshot.serializedBytes <= 128 * 1024);
  assert.deepEqual(selected.snapshot.policy.excludedCategories, ["system", "model_change", "thinking_level_change", "usage", "custom", "label", "session_info"]);
});

test("missing, abandoned, mismatched and incoherent anchors fail closed", () => {
  const { manager, root, call, result } = source();
  assert.deepEqual(resolveContext(request(manager, "missing"), () => manager, "code-mapper"), { ok: false, code: "invalid_context" });
  assert.deepEqual(resolveContext({ ...request(manager, result), sourceSessionId: "other" }, () => manager, "code-mapper"), { ok: false, code: "invalid_context" });
  assert.deepEqual(resolveContext(request(manager, call), () => manager, "code-mapper"), { ok: false, code: "invalid_context" });
  manager.branch(root);
  manager.appendMessage({ role: "user", content: "new branch", timestamp: 4 });
  assert.deepEqual(resolveContext(request(manager, result), () => manager, "code-mapper"), { ok: false, code: "invalid_context" });
});

test("fork unsupported and Ciung rejects automatic local context without touching source", () => {
  const { manager, result } = source(); let lookups = 0;
  const lookup = () => { lookups++; return manager; };
  assert.deepEqual(resolveContext(request(manager, result, "fork"), lookup, "code-mapper"), { ok: false, code: "unsupported_fork" });
  assert.deepEqual(resolveContext(request(manager, result), lookup, "researcher"), { ok: false, code: "privacy_sensitive_context" });
  assert.equal(lookups, 0);
});
test("snapshot refuses tool history outside the destination role loadout",()=>{
 const {manager}=source();
 manager.appendMessage({role:"assistant",content:[{type:"toolCall",id:"unsafe",name:"bash",arguments:{command:"secret"}}],provider:"fixture",model:"offline",api:"fixture",stopReason:"toolUse",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0,input:0,output:0,cacheRead:0,cacheWrite:0}},timestamp:4});
 const leaf=manager.appendMessage({role:"toolResult",toolCallId:"unsafe",toolName:"bash",content:[{type:"text",text:"private"}],isError:false,timestamp:5});
 assert.deepEqual(resolveContext(request(manager,leaf),()=>manager,"reviewer"),{ok:false,code:"privacy_sensitive_context"});
});

test("private categories, image payloads and oversized serialized snapshots reject without truncation", () => {
  const { manager } = source();
  const hidden = manager.appendCustomMessageEntry("secret", "private", false);
  assert.deepEqual(resolveContext(request(manager, hidden), () => manager, "code-mapper"), { ok: false, code: "privacy_sensitive_context" });
  manager.branch(manager.getBranch()[2].id);
  const image = manager.appendMessage({ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 5 });
  assert.deepEqual(resolveContext(request(manager, image), () => manager, "code-mapper"), { ok: false, code: "privacy_sensitive_context" });
  manager.branch(manager.getBranch()[2].id);
  const huge = manager.appendMessage({ role: "user", content: "x".repeat(128 * 1024), timestamp: 6 });
  assert.deepEqual(resolveContext(request(manager, huge), () => manager, "code-mapper"), { ok: false, code: "context_too_large" });
});
