# Goal Loop Subagent Evaluator Design

## Goal

Improve the Pi `/goal` loop by adding an evaluator subagent pattern. The working agent should ask a read-only subagent to review terminal decisions before the extension stops or completes a goal.

## Approach

Use prompt-mediated subagents for v3. The extension will not directly emit `subagents:rpc:spawn` yet. Instead, goal prompts will instruct the working agent to call the installed `Agent` tool when it is about to claim `complete`, `blocked`, or `needs_user`, or when repeated verification failures suggest it may be stuck.

The evaluator should return explicit markers:

```text
GOAL_EVAL_STATUS: complete | continue | blocked | needs_user
GOAL_EVAL_REASON: one short sentence
GOAL_EVAL_CONFIDENCE: low | medium | high
```

The extension will parse evaluator markers first. If they are absent, it will fall back to the existing worker markers:

```text
GOAL_STATUS: complete | continue | blocked | needs_user
GOAL_REASON: one short sentence
```

## Subagent Prompt Contract

The working agent should call `Agent` with a read-only evaluator task shaped like:

```text
Agent({
  subagent_type: "Explore",
  description: "Evaluate goal status",
  run_in_background: false,
  prompt: "Review this goal, recent evidence, and the worker's proposed status. Return only GOAL_EVAL_* markers."
})
```

The evaluator must not edit files. It should inspect evidence and verification output, then judge whether the worker's proposed status is justified.

## Completion Rules

- Evaluator markers are source of truth when present.
- Worker markers remain the fallback when `Agent` is unavailable or the model did not call it.
- Normal `continue` turns should not require evaluator review.
- Terminal states should request evaluator review.
- Repeated verification failures should request evaluator review.

## Files

- `pi/extensions/goal-loop/index.ts`: add evaluator marker parsing and prompt instructions.
- `pi/extensions/goal-loop/index.test.ts`: cover evaluator parsing and prompt content.
- `pi/extensions/goal-loop/README.md`: document v3 evaluator behavior and fallback.
- `README.md`: document the evaluator subagent pattern.
- `docs/superpowers/plans/2026-06-26-goal-loop-subagent-evaluator.md`: implementation plan.

## Non-Goals

- No direct `subagents:rpc:spawn` call in v3.
- No background evaluator jobs.
- No automatic result polling.
- No standalone evaluator model configuration.

## Risks

- The worker may ignore the evaluator instruction. The fallback keeps the loop functional.
- The evaluator may be unavailable if `@tintinweb/pi-subagents` is not installed or the `Agent` tool is disabled.
- Prompt-mediated evaluation costs more tokens only on terminal or suspicious states, not on every loop turn.
