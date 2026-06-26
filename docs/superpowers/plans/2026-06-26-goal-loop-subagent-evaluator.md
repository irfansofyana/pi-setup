# Goal Loop Subagent Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add prompt-mediated evaluator subagent support to the Pi `/goal` extension.

**Architecture:** Keep the goal-loop extension self-contained. Add helper functions for evaluator marker parsing and evaluator prompt construction, then update the goal system/continuation prompts to request a foreground read-only `Agent` evaluator before terminal decisions. Runtime behavior still parses the final assistant text after `agent_end`; evaluator markers win over worker markers.

**Tech Stack:** TypeScript, Pi extension API, `@tintinweb/pi-subagents` Agent tool contract, Node.js built-in test runner.

---

### Task 1: Evaluator Marker Parsing

**Files:**
- Modify: `pi/extensions/goal-loop/index.test.ts`
- Modify: `pi/extensions/goal-loop/index.ts`

- [x] **Step 1: Write failing parser test**

Add a test that passes text containing both worker markers and evaluator markers:

```text
GOAL_STATUS: complete
GOAL_REASON: Worker thinks done.
GOAL_EVAL_STATUS: continue
GOAL_EVAL_REASON: Verification output is missing.
GOAL_EVAL_CONFIDENCE: high
```

Assert the parsed decision is `continue`, reason is the evaluator reason, and confidence is `high`.

Run:

```bash
node --test pi/extensions/goal-loop/index.test.ts
```

Expected: FAIL because evaluator markers are not parsed yet.

- [x] **Step 2: Implement evaluator-first parsing**

Export `parseEvaluationFromText`, prefer `GOAL_EVAL_*` markers, and preserve worker marker fallback.

- [x] **Step 3: Verify**

Run:

```bash
node --test pi/extensions/goal-loop/index.test.ts
```

Expected: PASS.

### Task 2: Evaluator Prompt Guidance

**Files:**
- Modify: `pi/extensions/goal-loop/index.test.ts`
- Modify: `pi/extensions/goal-loop/index.ts`

- [x] **Step 1: Write failing prompt tests**

Assert `buildContinuationPrompt(goal)` includes:

```text
Agent({
GOAL_EVAL_STATUS
Evaluate goal status
```

Also assert the system prompt includes evaluator fallback rules.

- [x] **Step 2: Implement prompt helpers**

Add `buildEvaluatorInstructions(goal)` and include it in continuation/system prompts. Keep instructions clear that evaluator is required only for terminal decisions or repeated failures.

- [x] **Step 3: Verify**

Run:

```bash
node --test pi/extensions/goal-loop/index.test.ts
```

Expected: PASS.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `pi/extensions/goal-loop/README.md`

- [x] **Step 1: Document v3 evaluator**

Document that the loop asks the worker to use the `Agent` tool for evaluator review before terminal states, and falls back to worker markers if subagents are unavailable.

- [x] **Step 2: Verify docs and whitespace**

Run:

```bash
node --test pi/extensions/goal-loop/index.test.ts
git diff --check
```

Expected: both commands exit 0.
