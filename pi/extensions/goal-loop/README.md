# goal-loop for Pi

Local Pi extension template that adds a Pi-working-root-scoped `/goal` command inspired by Codex Goal mode and Claude Code `/goal`.

Requires Pi >=0.80.4 and `pi install npm:@tintinweb/pi-subagents`. It uses `agent_end` only to record the result of a run, then uses `agent_settled` for one authoritative decision after retries, compaction, and queued follow-ups have finished.

## Install

Copy this template into Pi's global extension directory:

```bash
pi install npm:@tintinweb/pi-subagents
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/goal-loop ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
```

## Commands

```text
/goal                      # show objective, duration, evaluated runs, usage, and latest reason
/goal status               # explicit status alias
/goal <objective>          # start immediately; objective accepts at most 4,000 characters
/goal list                 # list active goal slots across stored working roots
/goal pause                # stop auto-continuing but keep state
/goal resume               # resume a paused or human-released limited goal
/goal clear                # remove this working root's active goal
/goal edit <objective>     # replace the goal text
/goal verify <command>     # add an explicit verification command
/goal budget <tokens|off>  # set or disable an opt-in token budget
```

`/goal stop`, `/goal off`, `/goal reset`, `/goal none`, and `/goal cancel` are aliases for `/goal clear`.

## Agent tools

The extension registers these model-callable tools by default:

```text
get_goal       # inspect objective, status, verification commands, and evidence
update_goal    # record evidence, add verification commands, or propose a terminal status
```

Use `/goal` for human goal creation. Model-created goals are disabled by default so YOLO mode cannot silently start a goal during brainstorming.

Optional opt-in:

```json
{
  "allowModelCreateGoal": true
}
```

Store it at `~/.pi/agent/goal-loop/config.json`, then `/reload`. This re-enables the model-callable `create_goal` tool.

## Structured worker and evaluator decisions

The worker must end an autonomous run with one correlated JSON record:

```text
GOAL_WORKER_DECISION: {"goalId":"...","goalRevision":1,"runId":"...","evaluationRequestId":"...","decision":"continue","reason":"one short sentence"}
```

After every valid worker run settles, the coordinator calls a separate read-only `Explore` agent through `subagents:rpc:spawn`. That evaluator receives bounded transcript context, verification evidence, and the same run identifiers, then returns:

```text
GOAL_EVALUATOR_DECISION: {"goalId":"...","goalRevision":1,"runId":"...","evaluationRequestId":"...","decision":"complete","reason":"one short sentence","confidence":"high"}
```

The coordinator evaluates every settled autonomous run, including worker `continue` proposals. The evaluator is authoritative about `continue`, `complete`, `blocked`, or `needs_user`; the worker record exists for correlation and progress reporting. An evaluator RPC failure or a missing, malformed, duplicate, or stale decision fails closed at `needs_user` and never becomes an automatic continuation. Completion additionally requires high-confidence evaluator approval and fresh passed evidence for every configured verification command.

## How it works

- Keys scope by the normalized Pi working root (`ctx.cwd`), not a discovered Git worktree root or filesystem realpath. Each exact root key has one active goal and lease-exclusive execution.
- Parallel safety requires launching each Pi session from a distinct Git worktree root. Different subdirectory launches or symlink spellings are distinct keys, so the extension does not detect them as the same worktree.
- `/goal list` discovers active goal slots across stored working roots. Bare `/goal` remains local to the current root key.
- A normal follow-up during an active run becomes durable goal steering. It revisions the objective context, invalidates proof from the interrupted run, and automatically resumes with the steering after the user turn settles.
- Persists active state atomically in `~/.pi/agent/goal-loop/state/<root-key>.json` and appends audit entries to `~/.pi/agent/goal-loop/logs/<root-key>.jsonl`.
- On completion, persists `complete`, writes one idempotent snapshot per goal ID at `~/.pi/agent/goal-loop/archive/<root-key>/<goal-id>.json`, then clears the active slot. A failed archive or clear leaves a recoverable completed active receipt.
- Reads old `~/.pi/agent/goal-loop/state.json` entries once and migrates them without changing that legacy file. A malformed active state file is quarantined under `~/.pi/agent/goal-loop/corrupt/` instead of being silently discarded.
- Keeps a renewable four-hour, session-owned lease. Another Pi session can inspect status but cannot dispatch a goal with a fresh lease.
- Shows compact animated footer status like `goal ◐ 0/8`; the counter is auto-continue loops used, not total assistant turns.
- Keeps the last 10 evidence entries from verification, notes, or tool observations.
- Injects goal instructions into each agent turn.
- Tells the agent to call `get_goal` and `update_goal` when it needs persisted goal state.
- Keeps activation, pause/resume, objective edits, and budget changes human-owned. `update_goal` can only record evidence, add verification, or set `proposedStatus` (`complete`, `blocked`, or `needs_user`).
- Bounds evaluator input to 50 verification commands, 500 characters per command, and 2,000 characters per evidence summary. Verification evidence with a command must reference a configured command.
- Records worker candidates and bounded transcript context at `agent_end`, evaluates independently, then settles and (if safe) dispatches at `agent_settled` exactly once.
- Never queues a continuation while Pi is non-idle or user messages are pending.
- Sums finalized Pi assistant usage (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost.total`) once per autonomous low-level run. Reasoning is not added separately because Pi already includes it in `output`; normal user turns are not counted.
- Token budgets are human-owned, opt-in, and cumulative. A valid `continue` that reaches the configured budget becomes `token_budget_limited`; completion may still succeed. Raise or disable the budget before `/goal resume`.
- A correlated provider HTTP 429 only becomes `usage_limited` when that autonomous run ends with `error` or `aborted`; successful retries remain transient. `/goal resume` from `usage_limited` is an explicit human retry.
- Stops when the goal is complete, blocked, needs user input, reaches the turn budget, reaches its token budget, or ends on a terminal provider usage limit.

## Defaults

```json
{
  "maxTurns": 10,
  "maxFailedVerificationAttempts": 3,
  "allowModelCreateGoal": false
}
```

The extension does not bypass Pi permissions. Pi permissions remain authoritative; keep `pi-permission-system` enabled so writes, shell commands, MCP calls, and external directories stay gated by your policy.

## Limitations

- Independent evaluation requires the `@tintinweb/pi-subagents` RPC protocol version 2. If it is unavailable, the run stops at `needs_user`.
- Stale writer locks with a confirmed dead process are recovered automatically. Malformed locks without process identity and orphaned recovery claims fail closed; the error notification gives the exact file to remove after confirming no Pi process is using that goal.
- It does not schedule goals after Pi exits.
- It does not run verification commands by itself; it tells the agent which commands to run.
- Same-worktree detection is not automatic across subdirectory or symlink roots. For concurrent goals, create a distinct Git worktree and launch Pi from that worktree root.

## Smoke test

Inside Pi:

```text
/goal Update README.md until node --test pi/extensions/goal-loop/*.test.ts passes.
Keep the existing headings unchanged.
/goal
/goal pause
/goal resume
/goal stop
```

For local helper tests from this repository:

```bash
node --test pi/extensions/goal-loop/*.test.ts
```
