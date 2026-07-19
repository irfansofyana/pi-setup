import type { GoalDecision, GoalDecisionRecord, GoalRunCandidate } from "./state.ts";

export interface CurrentRunIds {
  goalId: string;
  goalRevision: number;
  runId: string;
  evaluationRequestId: string;
}

type MessageRecord = {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  message?: unknown;
};

const WORKER_PREFIX = "GOAL_WORKER_DECISION: ";
const EVALUATOR_PREFIX = "GOAL_EVALUATOR_DECISION: ";
const DECISIONS = new Set<GoalDecision>(["complete", "continue", "blocked", "needs_user"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);

function unwrapMessage(message: unknown): MessageRecord | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as MessageRecord;
  return record.message && typeof record.message === "object" ? record.message as MessageRecord : record;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!part || typeof part !== "object") return [] as string[];
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

function evaluatorToolCallIds(messages: unknown[], expected: CurrentRunIds): Set<string> {
  const ids = new Set<string>();
  for (const item of messages) {
    const message = unwrapMessage(item);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== "toolCall" || call.name !== "Agent" || typeof call.id !== "string" || !call.id) continue;
      if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) continue;
      const argumentsRecord = call.arguments as { description?: unknown; prompt?: unknown };
      if (argumentsRecord.description !== "Evaluate goal status" || typeof argumentsRecord.prompt !== "string") continue;
      if (!argumentsRecord.prompt.includes(expected.evaluationRequestId)) continue;
      ids.add(call.id);
    }
  }
  return ids;
}

function markerPayloads(text: string, prefix: string): { payloads: string[]; malformed: boolean } {
  const marker = prefix.trimEnd();
  const payloads: string[] = [];
  let malformed = false;
  let fence: "```" | "~~~" | undefined;

  for (const line of text.split(/\r?\n/)) {
    const trimmedStart = line.trimStart();
    const fenceToken = trimmedStart.startsWith("```") ? "```" : trimmedStart.startsWith("~~~") ? "~~~" : undefined;
    if (fenceToken) {
      fence = fence === fenceToken ? undefined : fence ?? fenceToken;
      continue;
    }
    if (!line.startsWith(marker)) continue;
    if (fence || !line.startsWith(prefix)) {
      malformed = true;
      continue;
    }
    const payload = line.slice(prefix.length);
    if (!payload || payload !== payload.trim()) malformed = true;
    else payloads.push(payload);
  }
  return { payloads, malformed };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseRecord(payload: string, role: "worker" | "evaluator"): GoalDecisionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const keys = role === "worker"
    ? ["goalId", "goalRevision", "runId", "evaluationRequestId", "decision", "reason"]
    : ["goalId", "goalRevision", "runId", "evaluationRequestId", "decision", "reason", "confidence"];
  if (!hasExactKeys(value, keys)) return undefined;
  if (typeof value.goalId !== "string" || !value.goalId || typeof value.goalRevision !== "number" || !Number.isInteger(value.goalRevision)) return undefined;
  if (typeof value.runId !== "string" || !value.runId || typeof value.evaluationRequestId !== "string" || !value.evaluationRequestId) return undefined;
  if (typeof value.reason !== "string" || !value.reason.trim() || typeof value.decision !== "string" || !DECISIONS.has(value.decision as GoalDecision)) return undefined;
  if (role === "evaluator" && (typeof value.confidence !== "string" || !CONFIDENCES.has(value.confidence))) return undefined;
  return {
    goalId: value.goalId,
    goalRevision: value.goalRevision,
    runId: value.runId,
    evaluationRequestId: value.evaluationRequestId,
    decision: value.decision as GoalDecision,
    reason: value.reason.trim(),
    confidence: role === "evaluator" ? value.confidence as GoalDecisionRecord["confidence"] : "medium",
  };
}

function matchesCurrentRun(record: GoalDecisionRecord, expected: CurrentRunIds): boolean {
  return record.goalId === expected.goalId &&
    record.goalRevision === expected.goalRevision &&
    record.runId === expected.runId &&
    record.evaluationRequestId === expected.evaluationRequestId;
}

function protocolError(protocol: Exclude<GoalRunCandidate["protocol"], "valid">, reason: string): GoalRunCandidate {
  return { protocol, reason, source: "assistant_message" };
}

/** Parse one evaluator response produced outside the worker transcript. */
export function parseEvaluatorDecision(text: string, expected: CurrentRunIds): GoalDecisionRecord {
  const markers = markerPayloads(text, EVALUATOR_PREFIX);
  if (markers.malformed || markers.payloads.length !== 1) {
    throw new Error("Evaluator output must contain exactly one well-formed decision marker.");
  }
  const evaluator = parseRecord(markers.payloads[0], "evaluator");
  if (!evaluator) throw new Error("Evaluator decision JSON does not match the required schema.");
  if (!matchesCurrentRun(evaluator, expected)) {
    throw new Error("Evaluator decision does not match the active goal run.");
  }
  return evaluator;
}

/** Parse only the messages supplied for the run being settled. */
export function parseCurrentRunCandidate(messages: unknown[], expected: CurrentRunIds): GoalRunCandidate {
  const assistantTexts = messages
    .map(unwrapMessage)
    .filter((message): message is MessageRecord => message?.role === "assistant")
    .map((message) => textFromContent(message.content));
  const workerText = assistantTexts.at(-1) ?? "";
  const evaluatorCallIds = evaluatorToolCallIds(messages, expected);
  const evaluatorTexts = [
    ...messages.map(unwrapMessage)
      .filter((message): message is MessageRecord => message?.role === "toolResult" && message.toolName === "Agent" && typeof message.toolCallId === "string" && evaluatorCallIds.has(message.toolCallId))
      .map((message) => textFromContent(message.content)),
  ];

  const workerMarkers = markerPayloads(workerText, WORKER_PREFIX);
  if (workerMarkers.malformed || workerMarkers.payloads.length > 1) {
    return protocolError(workerMarkers.payloads.length > 1 ? "duplicate" : "malformed", "Worker decision marker is malformed or duplicated.");
  }
  if (!workerMarkers.payloads.length) return protocolError("missing", "Worker decision marker is missing.");
  const worker = parseRecord(workerMarkers.payloads[0], "worker");
  if (!worker) return protocolError("malformed", "Worker decision JSON does not match the required schema.");
  if (!matchesCurrentRun(worker, expected)) return protocolError("stale", "Worker decision does not match the active goal run.");

  const evaluatorMarkers = evaluatorTexts.flatMap((text) => {
    const result = markerPayloads(text, EVALUATOR_PREFIX);
    return result.malformed ? ["__MALFORMED__"] : result.payloads;
  });
  if (evaluatorMarkers.includes("__MALFORMED__")) return protocolError("malformed", "Evaluator decision marker is malformed.");
  if (evaluatorMarkers.length > 1) return protocolError("duplicate", "Evaluator decision marker is duplicated.");
  if (!evaluatorMarkers.length) return { protocol: "valid", worker, source: "assistant_message" };
  const evaluator = parseRecord(evaluatorMarkers[0], "evaluator");
  if (!evaluator) return protocolError("malformed", "Evaluator decision JSON does not match the required schema.");
  if (!matchesCurrentRun(evaluator, expected)) return protocolError("stale", "Evaluator decision does not match the active goal run.");
  return { protocol: "valid", worker, evaluator, source: "assistant_message" };
}
