import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_CAPTURE_TYPE,
  EMPTY_AUTO_CAPTURE_STATE,
  buildAutoCapturePrompt,
  recordAgentEnd,
  settleAutoCapture,
} from "./auto-capture.ts";

const enabledConfig = {
  enabled: true,
  learnEnabled: true,
  autoContinue: true,
  minToolCalls: 5,
};

test("agent_end records eligible work without dispatching", () => {
  const state = recordAgentEnd(EMPTY_AUTO_CAPTURE_STATE, {
    config: enabledConfig,
    messages: [],
    toolCalls: 5,
  });

  assert.deepEqual(state, { pendingToolCalls: 5, captureChainActive: false, dispatchPending: false });
});

test("agent_end keeps the largest candidate across continuation runs", () => {
  const first = recordAgentEnd(EMPTY_AUTO_CAPTURE_STATE, {
    config: enabledConfig,
    messages: [],
    toolCalls: 8,
  });
  const second = recordAgentEnd(first, {
    config: enabledConfig,
    messages: [],
    toolCalls: 2,
  });

  assert.deepEqual(second, { pendingToolCalls: 8, captureChainActive: false, dispatchPending: false });
});

test("settlement defers while Pi is busy or has pending messages", () => {
  const state = { pendingToolCalls: 7, captureChainActive: false, dispatchPending: false };

  assert.deepEqual(settleAutoCapture(state, {
    config: enabledConfig,
    isIdle: false,
    hasPendingMessages: false,
  }), { state });
  assert.deepEqual(settleAutoCapture(state, {
    config: enabledConfig,
    isIdle: true,
    hasPendingMessages: true,
  }), { state });
});

test("idle settlement dispatches one config-aware capture prompt", () => {
  const state = { pendingToolCalls: 7, captureChainActive: false, dispatchPending: false };
  const decision = settleAutoCapture(state, {
    config: enabledConfig,
    isIdle: true,
    hasPendingMessages: false,
  });

  assert.equal(decision.toolCalls, 7);
  assert.match(decision.prompt ?? "", /call `learn`/);
  assert.deepEqual(decision.state, { pendingToolCalls: 7, captureChainActive: false, dispatchPending: true });
});

test("capture marker suppresses its run and retries until settled", () => {
  const markerRun = recordAgentEnd(EMPTY_AUTO_CAPTURE_STATE, {
    config: { ...enabledConfig, minToolCalls: 0 },
    messages: [{ role: "custom", customType: AUTO_CAPTURE_TYPE }],
    toolCalls: 3,
  });
  const retryRun = recordAgentEnd(markerRun, {
    config: { ...enabledConfig, minToolCalls: 0 },
    messages: [],
    toolCalls: 4,
  });

  assert.deepEqual(markerRun, { pendingToolCalls: null, captureChainActive: true, dispatchPending: false });
  assert.deepEqual(retryRun, markerRun);
  assert.deepEqual(settleAutoCapture(retryRun, {
    config: enabledConfig,
    isIdle: true,
    hasPendingMessages: false,
  }), { state: EMPTY_AUTO_CAPTURE_STATE });
});

test("disabled automation clears stale candidates", () => {
  const state = { pendingToolCalls: 7, captureChainActive: false, dispatchPending: false };
  const config = { ...enabledConfig, autoContinue: false };

  assert.deepEqual(recordAgentEnd(state, { config, messages: [], toolCalls: 9 }), EMPTY_AUTO_CAPTURE_STATE);
  assert.deepEqual(settleAutoCapture(state, {
    config,
    isIdle: true,
    hasPendingMessages: false,
  }), { state: EMPTY_AUTO_CAPTURE_STATE });
});

test("capture prompt omits unavailable learn tool", () => {
  const prompt = buildAutoCapturePrompt({ learnEnabled: false });

  assert.doesNotMatch(prompt, /`learn`/);
  assert.match(prompt, /`manage_skill`/);
});

test("dispatch candidate is cleared only after the capture marker is observed", () => {
  const candidate = { pendingToolCalls: 7, captureChainActive: false, dispatchPending: false };
  const dispatched = settleAutoCapture(candidate, {
    config: enabledConfig,
    isIdle: true,
    hasPendingMessages: false,
  }).state;
  const unrelatedRun = recordAgentEnd(dispatched, {
    config: enabledConfig,
    messages: [],
    toolCalls: 0,
  });
  const retry = settleAutoCapture(unrelatedRun, {
    config: enabledConfig,
    isIdle: true,
    hasPendingMessages: false,
  });

  assert.deepEqual(unrelatedRun, { pendingToolCalls: 7, captureChainActive: false, dispatchPending: false });
  assert.match(retry.prompt ?? "", /Automated managed-skills capture turn/);
});

test("capture chain preserves eligible tool work after a queued user follow-up", () => {
  const markerRun = recordAgentEnd(
    { pendingToolCalls: 7, captureChainActive: false, dispatchPending: true },
    {
      config: { ...enabledConfig, minToolCalls: 2 },
      messages: [{ role: "custom", customType: AUTO_CAPTURE_TYPE }, { role: "user" }],
      toolCalls: 4,
      postCaptureToolCalls: 2,
    },
  );
  const decision = settleAutoCapture(markerRun, {
    config: { ...enabledConfig, minToolCalls: 2 },
    isIdle: true,
    hasPendingMessages: false,
  });

  assert.deepEqual(markerRun, { pendingToolCalls: 2, captureChainActive: true, dispatchPending: false });
  assert.equal(decision.toolCalls, 2);
  assert.match(decision.prompt ?? "", /Automated managed-skills capture turn/);
});
