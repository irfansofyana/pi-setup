# loop for Pi

Repo-owned Pi extension implementing Cursor-style `/loop` behavior: repeat a prompt on a fixed local interval, or let the agent choose a time or safe correlated event wake until it decides the outcome is complete.

## Requirements

- Pi `>=0.80.4`
- repo-owned `goal-loop` extension
- `@tintinweb/pi-subagents` RPC protocol version 2 from the canonical README package manifest

## Install

Use the private backup-and-replace procedure in [`docs/setup/installation.md`](../../../docs/setup/installation.md#install-local-templates), copying both local templates:

```text
pi/extensions/goal-loop
pi/extensions/loop
```

Then run `/reload` or restart Pi.

## Commands

```text
/loop                         # show current status or latest receipt
/loop <prompt>                # dynamic: agent selects next time/event wake
/loop <N><unit> <prompt>      # fixed: immediate run, then fixed interval
/loop stop                    # stop active loop
```

Fixed units are positive integer seconds, minutes, hours, or days, bounded to seven days. Compact, leading-natural, and trailing-natural forms work:

```text
/loop 5m check whether the deployment finished
/loop every 5 minutes check whether the deployment finished
/loop check whether the deployment finished every 5 minutes
/loop work on this feature until tests pass
```

`stop` is case-insensitive. Other text without a recognized interval is treated as a dynamic prompt.

## Behavior

- First iteration runs immediately.
- Fixed schedules use absolute one-shot timers to avoid drift.
- Busy ticks coalesce into one pending wake and dispatch only when Pi is idle.
- Dynamic continuation requires one `schedule_loop_wakeup` call during the current iteration.
- Omitting a dynamic wake means the agent considers the loop complete.
- Agent owns completion: `complete_loop` stops either mode when iteration settles; omitting a dynamic wake also stops.
- Goal Loop coordinates working-root ownership but does not evaluate each Loop iteration.
- Queued user interruption stops safely and reports reason.
- `/goal` and `/loop` are mutually exclusive for the same working root inside one Pi process; persisted active `/goal` state also blocks a new loop in another process.
- Loop ownership is process-local. Launch concurrent Pi processes only from distinct Git worktree roots; a loop in one process cannot reserve same root against `/goal` in another process.
- `/reload`, session replacement, shutdown, or Pi exit stops the loop.

## Dynamic wake tool

`schedule_loop_wakeup` accepts exactly one wake source:

```text
delaySeconds=<1..86400>
subagentId=<background Agent ID created during this iteration>
filePath=<project-relative path> fileEvent=<any|change|create|delete>
eventName=<allowlisted event> correlationId=<matching ID>
```

Allowlisted shared events are `monitor:done`, `monitor:error`, `tasks:completed`, `tasks:failed`, and `loop:wake`. Correlation accepts payload fields `correlationId`, `id`, `monitorId`, or `taskId`. Arbitrary event names, unrelated IDs, foreground agents, and file paths outside current working root are rejected. Events arriving before iteration settles are buffered and delivered once after agent commits wake intent. Raw event payload and background-agent output never enter system prompt.

## Safety

- One active loop per Pi process.
- Cross-process same-root exclusion is not provided; use distinct Git worktrees for parallel sessions.
- New loops are refused until the current loop stops.
- Goal Loop continuation authority must be claimed before start.
- Timer and event callbacks carry a loop generation; stale callbacks do nothing.
- Stop and shutdown clear timers, file watchers, queues, buffers, event subscriptions, and Goal ownership.
- Pi permissions remain authoritative. This extension does not bypass tool approval.
- No cron daemon, offline scheduler, task manager, shell monitor, external dependency, or automatic retry.

## Smoke test

```text
/loop 5m check whether the deployment finished
/loop
/loop stop
/loop work on this feature until tests pass
```

For an event wake, start a background `Agent`, then let the loop call `schedule_loop_wakeup` with returned agent ID.

Run tests:

```bash
node --test pi/extensions/loop/*.test.ts
node --test pi/extensions/goal-loop/*.test.ts
```
