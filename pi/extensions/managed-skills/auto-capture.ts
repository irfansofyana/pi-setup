export const AUTO_CAPTURE_TYPE = "managed-skills-autocapture";

export interface AutoCaptureConfig {
  enabled: boolean;
  learnEnabled: boolean;
  autoContinue: boolean;
  minToolCalls: number;
}

export interface AutoCaptureState {
  pendingToolCalls: number | null;
  captureChainActive: boolean;
  dispatchPending: boolean;
}

export interface AutoCaptureDecision {
  state: AutoCaptureState;
  prompt?: string;
  toolCalls?: number;
}

export const EMPTY_AUTO_CAPTURE_STATE: AutoCaptureState = Object.freeze({
  pendingToolCalls: null,
  captureChainActive: false,
  dispatchPending: false,
});

interface AgentEndInput {
  config: AutoCaptureConfig;
  messages: unknown[];
  toolCalls: number;
  postCaptureToolCalls?: number;
}

interface SettlementInput {
  config: AutoCaptureConfig;
  isIdle: boolean;
  hasPendingMessages: boolean;
}

function isCaptureMarker(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const value = message as { role?: unknown; customType?: unknown };
  return value.role === "custom" && value.customType === AUTO_CAPTURE_TYPE;
}

function automationEnabled(config: AutoCaptureConfig): boolean {
  return config.enabled && config.autoContinue;
}

export function recordAgentEnd(state: AutoCaptureState, input: AgentEndInput): AutoCaptureState {
  const postCaptureCandidate = input.postCaptureToolCalls !== undefined
    && input.postCaptureToolCalls >= input.config.minToolCalls
    ? input.postCaptureToolCalls
    : null;
  if (input.messages.some(isCaptureMarker)) {
    return { pendingToolCalls: postCaptureCandidate, captureChainActive: true, dispatchPending: false };
  }
  if (state.captureChainActive) {
    return {
      ...state,
      pendingToolCalls: postCaptureCandidate === null
        ? state.pendingToolCalls
        : Math.max(state.pendingToolCalls ?? 0, postCaptureCandidate),
    };
  }
  if (!automationEnabled(input.config)) return EMPTY_AUTO_CAPTURE_STATE;
  const availableState = state.dispatchPending ? { ...state, dispatchPending: false } : state;
  if (input.toolCalls < input.config.minToolCalls) return availableState;
  return {
    pendingToolCalls: Math.max(availableState.pendingToolCalls ?? 0, input.toolCalls),
    captureChainActive: false,
    dispatchPending: false,
  };
}

export function buildAutoCapturePrompt(config: Pick<AutoCaptureConfig, "learnEnabled">): string {
  const lines = [
    "Automated managed-skills capture turn - not a user reply.",
    "The user has not answered any pending question. Do not treat this as approval to continue prior work.",
  ];
  if (config.learnEnabled) {
    lines.push(
      "If the preceding work produced a durable fact, convention, user preference, or non-obvious fix, call `learn` to retain it in Hindsight.",
      "If it also produced a genuinely reusable procedure, call `learn` with a `skill` object or call `manage_skill` separately.",
    );
  } else {
    lines.push("If the preceding work produced a genuinely reusable procedure, call `manage_skill` to capture it.");
  }
  lines.push(
    "Skip secrets, credentials, one-off facts, and vague lessons.",
    "After any useful capture, stop. Do not run other tools or continue the prior task.",
  );
  return lines.join("\n");
}

export function settleAutoCapture(state: AutoCaptureState, input: SettlementInput): AutoCaptureDecision {
  const availableState = state.captureChainActive
    ? { pendingToolCalls: state.pendingToolCalls, captureChainActive: false, dispatchPending: false }
    : state;
  if (!automationEnabled(input.config)) return { state: EMPTY_AUTO_CAPTURE_STATE };
  if (availableState.pendingToolCalls === null) return { state: EMPTY_AUTO_CAPTURE_STATE };
  if (availableState.dispatchPending) return { state: availableState };
  if (!input.isIdle || input.hasPendingMessages) return { state: availableState };
  return {
    state: { ...availableState, dispatchPending: true },
    prompt: buildAutoCapturePrompt(input.config),
    toolCalls: availableState.pendingToolCalls,
  };
}
