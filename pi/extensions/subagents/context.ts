import { SessionManager, buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { limits, utf8Bytes } from "./contracts.ts";

export type ContextRequest = { mode: "snapshot" | "fork"; sourceSessionId: string; branchLeafId: string; entryAnchorId: string };
type TransferMessage = UserMessage | AssistantMessage | ToolResultMessage;
export type ContextSnapshot = Readonly<{ sourceSessionId: string; branchLeafId: string; entryAnchorId: string; sourceEntryIds: readonly string[]; messages: readonly TransferMessage[]; serializedBytes: number; policy: Readonly<{ maxBytes: number; excludedCategories: readonly string[] }> }>;
export type ContextResolution = { ok: true; snapshot: ContextSnapshot } | { ok: false; code: "invalid_context" | "privacy_sensitive_context" | "context_too_large" | "unsupported_fork" };
const excludedCategories = Object.freeze(["system", "model_change", "thinking_level_change", "usage", "custom", "label", "session_info"]);
const reject = (code: Exclude<ContextResolution, { ok: true }>["code"]): ContextResolution => ({ ok: false, code });

/** The resolver is a trusted host callback, never an untrusted path or ambient current session. */
export function resolveContext(request: ContextRequest, resolveSource: (sessionId: string) => SessionManager | undefined, role: string): ContextResolution {
  if (!request || typeof request !== "object" || Object.keys(request).some(k => !["mode", "sourceSessionId", "branchLeafId", "entryAnchorId"].includes(k)) || !["snapshot", "fork"].includes(request.mode) || ![request.sourceSessionId, request.branchLeafId, request.entryAnchorId].every(v => typeof v === "string" && v.length > 0)) return reject("invalid_context");
  if (request.mode === "fork") return reject("unsupported_fork");
  if (role === "researcher") return reject("privacy_sensitive_context");
  let source: SessionManager | undefined;
  try { source = resolveSource(request.sourceSessionId); } catch { return reject("invalid_context"); }
  if (!source || source.getSessionId() !== request.sourceSessionId || source.getLeafId() !== request.branchLeafId) return reject("invalid_context");
  const branch = source.getBranch();
  if (!branch.some(e => e.id === request.entryAnchorId)) return reject("invalid_context");
  const projection = buildSessionProjection(source.getEntries(), request.entryAnchorId);
  const messages: TransferMessage[] = [], ids: string[] = [];
  const allowedTools=new Set(["read","grep","find","ls","fffind","ffgrep","fff-multi-grep",...(role==="builder"?["write","edit"]:[])]);
  const pending = new Map<string,string>();
  for (const projected of projection.entries) {
    const entry = projected.sourceEntry;
    if (entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction" || entry.type === "context_edit") return reject("privacy_sensitive_context");
    if (entry.type !== "message") continue;
    if (projected.messages.length !== 1) return reject("invalid_context");
    const m = projected.messages[0];
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") return reject("privacy_sensitive_context");
    if (m.role === "user" && !(typeof m.content === "string" || (Array.isArray(m.content) && m.content.every(c => c.type === "text")))) return reject("privacy_sensitive_context");
    if (m.role === "assistant" && !m.content.every(c => c.type === "text" || c.type === "toolCall")) return reject("privacy_sensitive_context");
    if (m.role === "toolResult" && !m.content.every(c => c.type === "text")) return reject("privacy_sensitive_context");
    if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") {
      if(!allowedTools.has(c.name))return reject("privacy_sensitive_context");
      if (!c.id || pending.has(c.id)) return reject("invalid_context");
      pending.set(c.id,c.name);
    }
    if (m.role === "toolResult") {
      if(pending.get(m.toolCallId)!==m.toolName)return reject("invalid_context");
      if (!pending.delete(m.toolCallId)) return reject("invalid_context");
    }
    messages.push(structuredClone(m)); ids.push(entry.id);
  }
  if (!messages.length || pending.size) return reject("invalid_context");
  const serializedBytes = utf8Bytes(JSON.stringify({ sourceSessionId: request.sourceSessionId, branchLeafId: request.branchLeafId, entryAnchorId: request.entryAnchorId, sourceEntryIds: ids, messages, policy: { maxBytes: limits.contextBytes, excludedCategories } }));
  if (serializedBytes > limits.contextBytes) return reject("context_too_large");
  return { ok: true, snapshot: Object.freeze({ sourceSessionId: request.sourceSessionId, branchLeafId: request.branchLeafId,
    entryAnchorId: request.entryAnchorId, sourceEntryIds: Object.freeze(ids), messages: Object.freeze(messages), serializedBytes,
    policy: Object.freeze({ maxBytes: limits.contextBytes, excludedCategories }) }) };
}
