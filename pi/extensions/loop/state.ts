export const MIN_LOOP_INTERVAL_MS = 1_000;
export const MAX_LOOP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_LOOP_PROMPT_CHARS = 4_000;
export const MAX_WAKE_DELAY_SECONDS = 24 * 60 * 60;

export const ALLOWED_LOOP_EVENTS = [
  "monitor:done",
  "monitor:error",
  "tasks:completed",
  "tasks:failed",
  "loop:wake",
] as const;

export type AllowedLoopEvent = (typeof ALLOWED_LOOP_EVENTS)[number];
export type LoopFileEvent = "any" | "change" | "create" | "delete";

export type FixedLoopMode = {
  kind: "fixed";
  intervalMs: number;
  intervalText: string;
};

export type DynamicLoopMode = {
  kind: "dynamic";
};

export type LoopMode = FixedLoopMode | DynamicLoopMode;

export type ParsedLoopArgs =
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "error"; message: string }
  | { kind: "start"; prompt: string; mode: LoopMode };

export type LoopWakeIntent =
  | { kind: "time"; delaySeconds: number; reason?: string }
  | { kind: "subagent"; subagentId: string; reason?: string }
  | { kind: "file"; filePath: string; fileEvent: LoopFileEvent; reason?: string }
  | { kind: "event"; eventName: AllowedLoopEvent; correlationId: string; reason?: string };

export type LoopStatus =
  | "running"
  | "evaluating"
  | "waiting_time"
  | "waiting_event"
  | "wake_pending"
  | "paused";

export interface LoopState {
  id: string;
  generation: number;
  prompt: string;
  mode: LoopMode;
  status: LoopStatus;
  iteration: number;
  createdAt: number;
  startedAt?: number;
  nextWakeAt?: number;
  waitingSubagentId?: string;
  waitingFilePath?: string;
  waitingEventName?: AllowedLoopEvent;
  waitingCorrelationId?: string;
  wakeIntent?: LoopWakeIntent;
  completionReason?: string;
  pendingWakeReason?: string;
}

const DURATION_RE = /^([1-9]\d*)([smhd])$/;
const DURATION_SHAPED_RE = /^\d+(?:\.\d+)?(?:s|m|h|d|seconds?|minutes?|hours?|days?)$/i;
const HUMAN_DURATION_RE = /^([1-9]\d*)\s*(s|m|h|d|seconds?|minutes?|hours?|days?)$/i;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 60 * 60_000,
  hour: 60 * 60_000,
  hours: 60 * 60_000,
  d: 24 * 60 * 60_000,
  day: 24 * 60 * 60_000,
  days: 24 * 60 * 60_000,
};
const CANONICAL_UNIT: Record<string, string> = {
  s: "s", second: "s", seconds: "s",
  m: "m", minute: "m", minutes: "m",
  h: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
};

function parsedDuration(text: string): { intervalMs: number; intervalText: string } | undefined {
  const match = HUMAN_DURATION_RE.exec(text.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const duration = amount * UNIT_MS[unit];
  if (!Number.isSafeInteger(duration)) return undefined;
  if (duration < MIN_LOOP_INTERVAL_MS || duration > MAX_LOOP_INTERVAL_MS) return undefined;
  return { intervalMs: duration, intervalText: `${amount}${CANONICAL_UNIT[unit]}` };
}

export function parseDurationToken(token: string): number | undefined {
  const match = DURATION_RE.exec(token);
  if (!match) return undefined;
  return parsedDuration(token)?.intervalMs;
}

function fixedStart(prompt: string, durationText: string): ParsedLoopArgs {
  const duration = parsedDuration(durationText);
  if (!duration) {
    return {
      kind: "error",
      message: `Invalid loop interval ${durationText.trim()}; use a positive integer s, m, h, or d value up to 7d.`,
    };
  }
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) return { kind: "error", message: "Usage: /loop <interval> <prompt>" };
  if (trimmedPrompt.length > MAX_LOOP_PROMPT_CHARS) {
    return { kind: "error", message: `Loop prompt exceeds ${MAX_LOOP_PROMPT_CHARS} characters.` };
  }
  return { kind: "start", prompt: trimmedPrompt, mode: { kind: "fixed", ...duration } };
}

export function parseLoopArgs(raw: string): ParsedLoopArgs {
  const text = raw.trim();
  if (!text) return { kind: "status" };
  if (text.toLowerCase() === "stop") return { kind: "stop" };

  const leadingEvery = /^every\s+(\d+\s*(?:s|m|h|d|seconds?|minutes?|hours?|days?))\s+(.+)$/i.exec(text);
  if (leadingEvery) return fixedStart(leadingEvery[2], leadingEvery[1]);

  const trailingEvery = /^(.+?)\s+every\s+(\d+\s*(?:s|m|h|d|seconds?|minutes?|hours?|days?))$/i.exec(text);
  if (trailingEvery) return fixedStart(trailingEvery[1], trailingEvery[2]);

  const leadingDuration = /^(\d+\s*(?:s|m|h|d|seconds?|minutes?|hours?|days?))\s+(.+)$/i.exec(text);
  if (leadingDuration) return fixedStart(leadingDuration[2], leadingDuration[1]);

  const separator = text.search(/\s/);
  const first = separator === -1 ? text : text.slice(0, separator);
  if (DURATION_SHAPED_RE.test(first)) {
    const prompt = separator === -1 ? "" : text.slice(separator).trim();
    return fixedStart(prompt, first);
  }

  if (text.length > MAX_LOOP_PROMPT_CHARS) {
    return { kind: "error", message: `Loop prompt exceeds ${MAX_LOOP_PROMPT_CHARS} characters.` };
  }
  return { kind: "start", prompt: text, mode: { kind: "dynamic" } };
}

export function createLoopState(input: {
  id: string;
  generation: number;
  prompt: string;
  mode: LoopMode;
  now: number;
}): LoopState {
  return {
    id: input.id,
    generation: input.generation,
    prompt: input.prompt,
    mode: input.mode,
    status: "running",
    iteration: 0,
    createdAt: input.now,
  };
}

export function parseWakeIntent(input: {
  delaySeconds?: unknown;
  subagentId?: unknown;
  filePath?: unknown;
  fileEvent?: unknown;
  eventName?: unknown;
  correlationId?: unknown;
  reason?: unknown;
}): LoopWakeIntent | { error: string } {
  const sources = [input.delaySeconds, input.subagentId, input.filePath, input.eventName]
    .filter((value) => value !== undefined).length;
  if (sources !== 1) {
    return { error: "Provide exactly one of delaySeconds, subagentId, filePath, or eventName." };
  }

  const reason = typeof input.reason === "string" && input.reason.trim()
    ? input.reason.trim().slice(0, 500)
    : undefined;

  if (input.delaySeconds !== undefined) {
    if (!Number.isInteger(input.delaySeconds)) return { error: "delaySeconds must be an integer." };
    const delaySeconds = input.delaySeconds as number;
    if (delaySeconds < 1 || delaySeconds > MAX_WAKE_DELAY_SECONDS) {
      return { error: `delaySeconds must be between 1 and ${MAX_WAKE_DELAY_SECONDS}.` };
    }
    return { kind: "time", delaySeconds, reason };
  }

  if (input.subagentId !== undefined) {
    if (typeof input.subagentId !== "string" || !input.subagentId.trim()) {
      return { error: "subagentId must be a non-empty string." };
    }
    return { kind: "subagent", subagentId: input.subagentId.trim(), reason };
  }

  if (input.filePath !== undefined) {
    if (typeof input.filePath !== "string" || !input.filePath.trim()) {
      return { error: "filePath must be a non-empty string." };
    }
    const fileEvent = input.fileEvent ?? "any";
    if (fileEvent !== "any" && fileEvent !== "change" && fileEvent !== "create" && fileEvent !== "delete") {
      return { error: "fileEvent must be any, change, create, or delete." };
    }
    return { kind: "file", filePath: input.filePath.trim(), fileEvent, reason };
  }

  if (!ALLOWED_LOOP_EVENTS.includes(input.eventName as AllowedLoopEvent)) {
    return { error: `eventName must be one of: ${ALLOWED_LOOP_EVENTS.join(", ")}.` };
  }
  if (typeof input.correlationId !== "string" || !input.correlationId.trim()) {
    return { error: "correlationId is required for an allowlisted event wake." };
  }
  return {
    kind: "event",
    eventName: input.eventName as AllowedLoopEvent,
    correlationId: input.correlationId.trim(),
    reason,
  };
}

export function formatDuration(durationMs: number): string {
  if (durationMs % 86_400_000 === 0) return `${durationMs / 86_400_000}d`;
  if (durationMs % 3_600_000 === 0) return `${durationMs / 3_600_000}h`;
  if (durationMs % 60_000 === 0) return `${durationMs / 60_000}m`;
  return `${Math.ceil(durationMs / 1_000)}s`;
}

export function advanceFixedDeadline(previousDeadline: number, intervalMs: number, now: number): number {
  if (previousDeadline > now) return previousDeadline;
  const missed = Math.floor((now - previousDeadline) / intervalMs) + 1;
  return previousDeadline + missed * intervalMs;
}
