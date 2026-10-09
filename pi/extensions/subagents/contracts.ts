// M0 wire vocabulary only: no runner, registration, storage or execution here.
export const limits = Object.freeze({
  pendingRunsPerRoot: 32, followUpsPerThread: 8, queuedBytes: 1024 * 1024,
  mailboxPerThread: 32, mailboxBytesPerThread: 256 * 1024, mailboxBytesTotal: 4 * 1024 * 1024,
  threadsPerRoot: 16, contextBytes: 128 * 1024,
  inspectorBytesPerThread: 256 * 1024, inspectorBytesTotal: 4 * 1024 * 1024,
  resultSlots: 32, resultBytesPerRun: 256 * 1024, resultBytesTotal: 8 * 1024 * 1024,
});
export type Domain = "pending_runs" | "follow_ups" | "queued_bytes" | "mailbox" | "threads" | "context" | "inspector" | "results";
export type Rejection = { ok: false; code: "invalid_request" | "unsupported_field" | "stale_run" | "backpressure" | "cleanup_unconfirmed" | "invalid_context" | "privacy_sensitive_context" | "context_too_large" | "unsupported_fork"; domain?: Domain; recovery?: "consume_or_close" | "retry_after_drain" };
export const accepted = { ok: true } as const;
const reject = (code: Rejection["code"]): Rejection => ({ ok: false, code });
export function backpressure(domain: Domain, used: number, limit: number): typeof accepted | Rejection {
  return used >= limit ? { ok: false, code: "backpressure", domain, recovery: domain === "results" ? "consume_or_close" : "retry_after_drain" } : accepted;
}
export function newRunIds(next: () => string): { agentId: string; threadId: string; runId: string; controlId: string } {
  // The caller owns a collision-resistant generator and checks uniqueness before admission.
  return { agentId: `agent-${next()}`, threadId: `thread-${next()}`, runId: `run-${next()}`, controlId: `control-${next()}` };
}
const id = (value: unknown, prefix: string) => typeof value === "string" && new RegExp(`^${prefix}-[A-Za-z0-9_-]{1,128}$`).test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown) => typeof value === "string" && value.length > 0;
const model = (value: unknown) => typeof value === "string" && /^[^\s/]+\/[^\s/]+$/.test(value);
export const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
export type Operation = "create" | "message" | "steer" | "follow_up" | "interrupt" | "wait" | "result" | "consume" | "resume" | "close";
export type Control = { version: 1; operation: Operation; threadId: string; expectedRunId?: string; message?: string; controlId?: string };
const operations: readonly Operation[] = ["create", "message", "steer", "follow_up", "interrupt", "wait", "result", "consume", "resume", "close"];
export function validateControl(value: unknown, currentRunId?: string): typeof accepted | Rejection {
  if (!record(value)) return reject("invalid_request");
  if (!fields(value, ["version", "operation", "threadId", "expectedRunId", "message", "controlId"])) return reject("unsupported_field");
  if (value.version !== 1 || !operations.includes(value.operation as Operation) || !id(value.threadId, "thread") || (value.controlId !== undefined && !id(value.controlId, "control"))) return reject("invalid_request");
  if (value.expectedRunId !== undefined && !id(value.expectedRunId, "run")) return reject("invalid_request");
  const needsRun = value.operation === "steer" || value.operation === "interrupt";
  const needsMessage = value.operation === "message" || value.operation === "steer" || value.operation === "follow_up" || value.operation === "resume";
  if (needsRun && !id(value.expectedRunId, "run")) return reject("invalid_request");
  if (needsMessage !== (value.message !== undefined) || (needsMessage && (!text(value.message) || utf8Bytes(value.message as string) > limits.mailboxBytesPerThread))) return reject("invalid_request");
  if (needsRun && value.expectedRunId !== currentRunId) return reject("stale_run");
  return accepted;
}
const legacyFields = {
  Agent: ["prompt", "description", "subagent_type", "name", "model", "thinking", "max_turns", "run_in_background", "resume", "isolated", "inherit_context", "isolation"],
  get_subagent_result: ["agent_id", "wait", "verbose"],
  steer_subagent: ["agent_id", "message"],
} as const;
export function validateLegacy(tool: keyof typeof legacyFields, value: unknown): typeof accepted | Rejection {
  if (!record(value)) return reject("invalid_request");
  if (!fields(value, legacyFields[tool])) return reject("unsupported_field");
  if (tool === "Agent") {
    if (!text(value.prompt) || !text(value.description) || !text(value.subagent_type) ||
      (value.model !== undefined && !model(value.model)) ||
      (value.name !== undefined && (typeof value.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.name))) ||
      (value.thinking !== undefined && (typeof value.thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value.thinking))) ||
      (value.isolation !== undefined && value.isolation !== "worktree") ||
      (value.max_turns !== undefined && (!Number.isSafeInteger(value.max_turns) || (value.max_turns as number) < 1)) ||
      (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") ||
      (value.inherit_context !== undefined && value.inherit_context !== false) ||
      (value.isolated !== undefined && value.isolated !== false) ||
      (value.resume !== undefined && !id(value.resume, "agent"))) return reject("invalid_request");
  } else if (!text(value.agent_id) || (tool === "steer_subagent" && !text(value.message)) ||
    (tool === "get_subagent_result" && ((value.wait !== undefined && typeof value.wait !== "boolean") || (value.verbose !== undefined && typeof value.verbose !== "boolean")))) return reject("invalid_request");
  return accepted;
}
export type RunState = "queued" | "initializing" | "running" | "stopping" | "terminal" | "quarantined";
export type Outcome = "completed" | "failed" | "interrupted" | "cancelled" | "budget_exhausted" | "orphaned";
export type Receipt = { version: 1; controlId: string; runId?: string; status: "accepted" | "queued" | "handled" | "applied" | "rejected" | "unknown_delivery"; error?: Rejection; result?: RunResult };
export type RunResult = { version: 1; agentId: string; threadId: string; runId: string; outcome: Outcome; complete: boolean; truncated: boolean; text?: string };
export interface Supervisor {
  start(request: unknown): Promise<Receipt>;
  control(request: Control): Promise<Receipt>;
  inspect(threadId: string): unknown;
  wait(runIds: readonly string[], signal?: AbortSignal): Promise<readonly RunResult[]>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): Promise<void>;
}
