# goal-loop for Pi

Local Pi extension template that adds a project-scoped `/goal` command inspired by Codex Goal mode and Claude Code `/goal`.

## Install

Copy this template into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/goal-loop ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
```

## Commands

```text
/goal <objective>          # create a project goal and start auto-continuing
/goal status               # show objective, status, turn count, verification
/goal pause                # stop auto-continuing but keep state
/goal resume               # resume a paused or stopped goal
/goal clear                # remove this project's goal
/goal edit <objective>     # replace the goal text
/goal verify <command>     # add an explicit verification command
```

## Agent tools

The extension also registers model-callable tools:

```text
get_goal       # inspect objective, status, verification commands, and evidence
create_goal    # create or replace the current project goal
update_goal    # record evidence, add verification commands, or stop the goal
```

Use `/goal` for human commands. The agent uses the tools while it is working inside a loop.

## How it works

- Stores one active goal per project.
- Persists state in `~/.pi/agent/goal-loop/state.json`.
- Keeps the last 10 evidence entries from verification, notes, or tool observations.
- Injects goal instructions into each agent turn.
- Tells the agent to call `get_goal` and `update_goal` when it needs persisted goal state.
- Requires the agent to end responses with:

```text
GOAL_STATUS: complete | continue | blocked | needs_user
GOAL_REASON: one short sentence
```

- Reads that marker after `agent_end`.
- Calls `sendUserMessage` to continue automatically when status is `continue`.
- Omits `deliverAs: "followUp"` while Pi is idle so continuation starts a new turn reliably.
- Stops when the goal is complete, blocked, needs user input, or reaches the turn budget.

## Defaults

```json
{
  "maxTurns": 10,
  "maxFailedVerificationAttempts": 3
}
```

The extension does not bypass Pi permissions. Keep `pi-permission-system` enabled so writes, shell commands, MCP calls, and external directories stay gated by your policy.

## Limitations

- The evaluator is still marker-based. The same working agent reports the status marker, and the extension enforces the loop from that marker.
- It does not yet spawn a separate evaluator subagent.
- It does not schedule goals after Pi exits.
- It does not run verification commands by itself; it tells the agent which commands to run.

## Smoke test

Inside Pi:

```text
/goal Update README.md with a short test sentence, then stop when the diff is ready.
/goal status
/goal pause
/goal clear
```

For local helper tests from this repository:

```bash
node --test pi/extensions/goal-loop/index.test.ts
```
