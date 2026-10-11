import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export interface ResolvedAgentSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
}
export interface AgentType {
  name: string;
  description: string;
  models?: string[];
  /** @deprecated Use ordered models instead. */
  model?: string;
  /** Advisory display names. Not provider/model pins and never used for selection. */
  modelSuggestions?: string[];
  thinkingLevel?: ThinkingLevel;
  /** Pi semantic token for the type pill background and task path foreground. */
  color?: string;
  /** Optional literal Nerd Font glyph; displayed only when the labs setting is enabled. */
  icon?: string;
  tools?: { allow?: string[]; block?: string[] };
  systemPrompt: string;
  filePath?: string;
  source?: "bundled" | "user" | "project";
  /**
   * How this definition is customized relative to its base.
   * - fork: a full `<name>.md` copy (owns the system prompt).
   * - override: a settings-only `<name>.yml` merged on top of the base
   *   (no Markdown body; unset fields follow the base).
   * Absent for pure bundled definitions and brand-new drafts.
   */
  customization?: {
    kind: "fork" | "override";
    scope: "user" | "project";
    filePath: string;
  };
  /** Source of the base definition under the customization, if any. */
  baseSource?: "bundled" | "user" | "project";
  /** File path of the base definition under the customization, if any. */
  baseFilePath?: string;
}
export type ThreadState = "starting" | "running" | "paused" | "completed" | "failed" | "stopped";
export interface ThreadView {
  path: string;
  parent: string | null;
  owner: string;
  type: string;
  color?: string;
  icon?: string;
  /** Actual runtime selection, not the type's model preferences. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  state: ThreadState;
  task: string;
  status: string;
  output?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  sessionFile?: string;
  /** Frozen active time. Renderer adds `Date.now() - startedAt` while a run is active. */
  elapsedMs?: number;
  /** Current run start. Live only; omitted from saved views so reloads do not count offline time. */
  startedAt?: number;
  /** Most recent run start (spawn or resume). Persisted; orders the agent tree newest-first. */
  lastStartedAt?: number;
  /** Cumulative input tokens, including cache read/write. Live views include the in-progress message. */
  inputTokens?: number;
  /** Cumulative output tokens. Live views include the in-progress message. */
  outputTokens?: number;
  /** Cumulative estimated USD cost for this agent's own messages. */
  costUsd?: number;
  /** Stable lifetime identity for cost accounting, retained across resumes/reloads. */
  costId?: string;
}
export type DriverEvent =
  | { kind: "settings"; model: string; thinkingLevel: ThinkingLevel }
  | { kind: "activity" | "error"; text: string }
  | {
      kind: "checkpoint";
      text: string;
      sessionFile?: string;
      sessionLeafId?: string | null;
    }
  | {
      kind: "usage";
      /** Cumulative own-assistant tokens for this driver instance, excluding inherited history. */
      inputTokens: number;
      outputTokens: number;
      /** Cumulative estimated USD cost, when reported by the runtime. */
      costUsd?: number;
      /** Streaming message_update snapshot. Omit for authoritative message_end. */
      partial?: boolean;
    };
/** Ephemeral read-only transcript state; never part of registry/delivery events. */
export interface TranscriptToolState {
  toolCallId: string;
  toolName: string;
  parentToolCallId?: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  state: "running" | "completed";
}
export interface TranscriptSnapshot {
  revision: number;
  /** Changes when a driver is replaced; revisions remain monotonic within the manager. */
  generation: number;
  messages: readonly AgentMessage[];
  assistant: AgentMessage | null;
  tools: readonly TranscriptToolState[];
  inheritedCount: number;
  thread?: ThreadView;
  error?: string;
}
export interface TranscriptObservation {
  snapshot: TranscriptSnapshot;
  unsubscribe(): void;
}
export type TranscriptListener = (snapshot: TranscriptSnapshot) => void;

export interface AgentDriver {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  snapshot(): AgentMessage[];
  observeTranscript?(listener: TranscriptListener): TranscriptObservation;
  output(): string;
  abort(): Promise<void>;
  dispose(): void;
  sendUpdate(content: string): Promise<void> | void;
  sessionFile?: string;
  sessionLeafId?: string | null;
}
export interface DriverOptions {
  path: string;
  type: AgentType;
  inherited: AgentMessage[];
  tools: ToolDefinition[];
  onEvent(event: DriverEvent): void;
  shouldPause(): boolean;
  parentPath: string | null;
  sessionFile?: string;
  /** Retained transcript of a nested lexical parent. Absent for /root and independent roots. */
  parentSessionFile?: string;
  sessionLeafId?: string | null;
  signal: AbortSignal;
}
export interface SavedThreadView {
  path: string;
  parent: string | null;
  owner: string;
  type: string;
  color?: string;
  icon?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  state: ThreadState;
  task: string;
  status: string;
  output?: string;
  error?: string;
  createdAt: number;
  sessionFile?: string;
  sessionLeafId?: string | null;
  /** Frozen cumulative active time. `startedAt` is intentionally not persisted. */
  elapsedMs?: number;
  lastStartedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costId?: string;
}
export interface SavedThread {
  view: SavedThreadView;
  definition: AgentType;
  /** Reserved threads may not have a transcript yet; preserve their initial context. */
  inherited?: AgentMessage[];
}
export interface ThreadService {
  list(): ThreadView[];
  get(path: string): ThreadView;
  output(path: string): string;
  transcript(path: string): Promise<string>;
  /** Optional for portable adapters; the runtime manager always implements this. */
  observeTranscript?(path: string, listener: TranscriptListener): Promise<TranscriptObservation>;
  spawn(
    args: { path: string; type: string; task: string; wait?: boolean; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<ThreadView>;
  /** message and/or timeoutMs (30s–5min). timeoutMs alone only re-arms a running child's report-only timeout. */
  steer(path: string, message?: string, timeoutMs?: number): Promise<ThreadView>;
  wait(path: string, timeoutMs?: number, signal?: AbortSignal): Promise<ThreadView>;
  update(message: string): ThreadView;
  pause(reason: string): ThreadView;
  stop(path: string): Promise<ThreadView>;
}
export type DriverFactory = (options: DriverOptions) => Promise<AgentDriver>;
export type ThreadEvent =
  | { kind: "change"; thread: ThreadView }
  | { kind: "metrics"; thread: ThreadView }
  | { kind: "update"; thread: ThreadView; message: string; recipient: string }
  | { kind: "settled"; thread: ThreadView; recipient: string; async: boolean }
  /** A spawn timeout elapsed while the child is still running. The child is NOT stopped. */
  | {
      kind: "timeout";
      thread: ThreadView;
      recipient: string;
      timeoutMs: number;
      recentOutput: string;
    };
export interface ManagerOptions {
  /** pi-setup: false preserves fresh-context specialist policy; upstream defaults to inheritance. */
  inheritContext?: boolean;
  createDriver: DriverFactory;
  rootSnapshot(): AgentMessage[];
  getType(name: string): AgentType;
  toolsFor(path: string): ToolDefinition[];
  onEvent?(event: ThreadEvent): void;
  /** Notification failures are diagnostic only; they must never interrupt a runner. */
  onEventError?(error: unknown, event: ThreadEvent): void;
  /** Maximum levels including the main conversation as L1; defaults to 3. */
  maxLevels?: number;
  /** @deprecated Internal legacy path-depth override; prefer maxLevels. */
  maxDepth?: number;
  maxThreads?: number;
  maxConcurrent?: number;
}

