import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  TranscriptListener,
  TranscriptObservation,
  TranscriptSnapshot,
  TranscriptToolState,
} from "../types.ts";

/** Clone once at the ownership boundary, then share immutable state across observers. */
export function immutableTranscriptValue<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    // Freezing populated typed-array views throws. Their storage was already cloned.
    if (!ArrayBuffer.isView(item)) Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

/** SDK event projection. Committed history is copied at boundaries, never for each token. */
export class TranscriptChannel {
  private revision = 0;
  private messages: readonly AgentMessage[];
  private assistant: AgentMessage | null = null;
  private tools = new Map<string, TranscriptToolState>();
  private listeners = new Set<TranscriptListener>();
  private current: TranscriptSnapshot;
  private disposed = false;
  private error: string | undefined;

  constructor(
    private readMessages: () => readonly AgentMessage[],
    private inheritedCount: number,
  ) {
    this.messages = immutableTranscriptValue(readMessages());
    this.current = this.snapshot();
  }

  observe(listener: TranscriptListener): TranscriptObservation {
    if (this.disposed) throw new Error("Transcript channel is disposed");
    // No await between registration and snapshot: a finalization cannot fall in a gap.
    const registered: TranscriptListener = (snapshot) => listener(snapshot);
    this.listeners.add(registered);
    return { snapshot: this.current, unsubscribe: () => this.listeners.delete(registered) };
  }

  accept(event: AgentSessionEvent): void {
    if (this.disposed) return;
    try {
      this.reduce(event);
    } catch (error) {
      // Custom tool details can be non-cloneable. Observation must still never fail the run.
      this.error = error instanceof Error ? error.message : String(error);
      this.publish();
    }
  }

  private reduce(event: AgentSessionEvent): void {
    this.error = undefined;
    switch (event.type) {
      case "message_start":
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.assistant = immutableTranscriptValue(event.message);
        break;
      case "message_end":
        if (event.message.role === "assistant") this.assistant = null;
        if (event.message.role === "toolResult") this.tools.delete(event.message.toolCallId);
        this.messages = immutableTranscriptValue(this.readMessages());
        break;
      case "tool_execution_start":
        this.tools.set(
          event.toolCallId,
          immutableTranscriptValue({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            parentToolCallId: event.parentToolCallId,
            args: event.args,
            state: "running" as const,
          }),
        );
        break;
      case "tool_execution_update":
        this.tools.set(
          event.toolCallId,
          immutableTranscriptValue({
            ...this.tools.get(event.toolCallId),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            parentToolCallId: event.parentToolCallId,
            args: event.args,
            result: event.partialResult,
            state: "running" as const,
          }),
        );
        break;
      case "tool_execution_end":
        this.tools.set(
          event.toolCallId,
          immutableTranscriptValue({
            ...this.tools.get(event.toolCallId),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            parentToolCallId: event.parentToolCallId,
            args: this.tools.get(event.toolCallId)?.args,
            result: event.result,
            isError: event.isError,
            state: "completed" as const,
          }),
        );
        // Nested calls have no transcript message. Bound their transient completed retention.
        for (const [id, tool] of this.tools) {
          if (this.tools.size <= 128) break;
          if (tool.state === "completed") this.tools.delete(id);
        }
        break;
      case "compaction_end":
        // Compaction may replace/reorder history; do not approximate it with append-only deltas.
        if (event.result && !event.aborted) this.inheritedCount = 0;
        this.messages = immutableTranscriptValue(this.readMessages());
        break;
      case "agent_end":
      case "agent_settled":
        this.assistant = null;
        this.tools.clear();
        this.messages = immutableTranscriptValue(this.readMessages());
        break;
      case "auto_retry_start":
      case "auto_retry_end":
        this.messages = immutableTranscriptValue(this.readMessages());
        break;
      default:
        return;
    }
    this.publish();
  }

  /** Non-turn custom delivery is not guaranteed to use core message events. */
  reconcile(): void {
    if (this.disposed) return;
    try {
      this.messages = immutableTranscriptValue(this.readMessages());
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.tools.clear();
    this.assistant = null;
  }

  private snapshot(): TranscriptSnapshot {
    return Object.freeze({
      revision: this.revision,
      generation: 0,
      messages: this.messages,
      assistant: this.assistant,
      tools: Object.freeze([...this.tools.values()]),
      inheritedCount: Math.min(this.inheritedCount, this.messages.length),
      ...(this.error ? { error: this.error } : {}),
    });
  }

  private publish(): void {
    this.revision++;
    this.current = this.snapshot();
    for (const listener of this.listeners) {
      // Watching is read-only: a broken renderer must not fail the agent's execution.
      try {
        listener(this.current);
      } catch {
        /* observer owns its error reporting */
      }
    }
  }
}

