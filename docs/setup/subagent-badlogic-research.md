# Badlogic subagent implementation: adoption review

Reviewed 2026-10-11. Upstream: [badlogic/pi-subagent at
4fc1fe5](https://github.com/badlogic/pi-subagent/tree/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c),
committed 2026-09-30. Local baseline: `44962ee`.

This is a source review and proposal, not an installation, benchmark, runtime
acceptance result, or approval to change local configuration. Read the extension,
CLI, shared helpers, bundled skill, manifest and complete repository tree.

## Recommendation

Adopt explicit message-delivery choices, clearer identity and lifecycle presentation,
and greater use of Pi's public controls. Keep the existing native runtime as the
default. Investigate persistent child processes separately: that change affects
resource use, ownership, credentials, transcript retention and recovery policy.

The immediate implementation should combine UI failure containment and compatibility
tests with a receipt-preserving task-control interface. A tmux backend would not
fix errors in the parent task panel, including the recent wrapping crash.

## Comparison

| Area | Badlogic implementation | Current pi-setup implementation |
| --- | --- | --- |
| Execution | Launches a Pi process in a detached tmux session with its own JSONL session. [Launcher](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/shared.ts) | Child SDK sessions share the parent process; one supervisor enforces admission and lifetime budgets. [Runtime](../../pi/extensions/subagents/runtime.ts), [supervisor](../../pi/extensions/subagents/supervisor.ts) |
| Lifecycle | Reload preserves children; parent departure suspends them; returning relaunches saved sessions. [Hooks](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/index.ts) | Reload/session replacement drains workers. Optional storage retains outcomes and journals, not child conversations. [Lifecycle and persistence](../../pi/extensions/subagents/README.md#behavior) |
| Delivery | CLI exposes ordinary send and explicit follow-up. Busy children receive steering or follow-up through Pi's messaging API. [CLI](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/subagent.ts), [bridge](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/index.ts) | Panel exposes automatic steering/continuation; the lower protocol already distinguishes steer, follow-up and context messages. [Root controls](../../pi/extensions/subagents/root-service.ts), [protocol types](../../pi/extensions/subagents/contracts.ts) |
| Terminal UI | Compact status widget, native SelectList and direct child-TUI attachment. [Extension](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/index.ts) | Integrated task dock and transcript/composer overlay, guarded arrows, stable task identity and drafts. [Presentation](../../pi/extensions/subagents/manager-presentation.ts), [panel](../../pi/extensions/subagents/task-panel.ts) |
| Identity | Mutable display names accompany stable generated handles. [CLI](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/subagent.ts) | Paths plus lifetime identities protect selection; labels currently derive from paths. [Fleet view](../../pi/extensions/subagents/fleet-view.ts) |
| Results | Wait checks lifecycle/inbox state and reads the active JSONL branch. [Wait](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/subagent.ts), [branch reader](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/shared.ts) | Structured exact-run outcomes, bounded result reservations and explicit consumption already exist. Keep these. [Supervisor](../../pi/extensions/subagents/supervisor.ts), [protocol](../../pi/extensions/subagents/protocol.ts) |

## Adopt next

### 1. Explicit delivery modes and useful receipts

Offer **Steer current work** and **Follow up after completion** in the task composer.
Keep context-only messages an advanced action because they do not necessarily
trigger work. Show the selected mode beside the recipient before submission.

Our root service currently selects `follow_up` when a result exists and `steer`
otherwise. It returns a thread view, losing the receipt's delivery status. Expose a
small task-control interface returning the receipt and current view while keeping
the same reviewed protocol, generation checks and expected run identity.

The policy supervisor already reserves distinct runs for follow-ups. This is
nevertheless more than a UI toggle: test active-run follow-ups through the manager
driver, transcript observer, parent notifications and cumulative budgets together.

Distinguish sending, queued, accepted, rejected and unknown delivery. Never infer
model consumption. Retain rejected drafts; do not automatically retry uncertain
delivery. Upstream's inbox uses temporary-file rename, but the sender prints its
success verb before child acceptance, and the bridge removes the entry after
calling Pi. That is not evidence of exactly-once delivery or model consumption.
[Sender](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/subagent.ts),
[receiver](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/index.ts).

### 2. Native controls with our navigation guarantees

Adopt public Pi selection/editor primitives and binding-derived hints where they
fit. Keep the integrated dock and dedicated composer. A native picker can provide
a simple cross-theme entry point, but replacing all navigation with SelectList
would change behavior: installed Pi 1.1.0's SelectList wraps at both ends.

Preserve clamped movement, release filtering, movement-only repeats, identity
revalidation and independent drafts. Resolve configurable editor actions before
hard-coded panel shortcuts. Keep render/input failure recovery local to the panel
and retain diagnostics; a constructor-level catch cannot contain later rendering.

### 3. Separate display identity and lifecycle concepts

Allow a short display name to change without changing path, thread ID, run ID or
draft ownership. Show the exact target on demand and keep stable row order.

Present the latest run's outcome separately from the retained session's ability
to accept more work. A completed run may still be resumable; a failed run may have
retained artifacts; a reaped thread is unavailable. Preserve our distinction between
interrupting work and confirmed cleanup. Upstream `stop` kills the session and
removes its stored run directory. [Stop implementation](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/subagent.ts).

Per-agent scroll/follow state and unread counts complement these changes. Those are
our proposed task-panel improvements, not features verified in this upstream UI.

### 4. Consider persistent workers as a separate project

Inference: separate child processes can contain many child crashes and make
attachment/recovery possible, at the cost of additional process memory and lifecycle
management. They do not isolate OS authority or contain failures in the parent UI.

Start with a disposable read-only worker prototype behind the existing backend
interface. Measure memory/startup cost and test interruption, parent loss and
ownership transfer under hard resource limits. tmux should be an optional attachment
transport, with the integrated task panel remaining the normal entry point.

Keep bundled roles fresh-context and without persisted output transcripts. Full
conversation recovery requires an explicitly designed separate policy: owner-only
files, retention limits, role/tool fingerprint validation, worktree lease checks,
remaining budgets, and a visible recovered-idle state. Pending messages must not
silently replay on recovery. Recovery of an interrupted tool is not implied by
reopening its conversation.

### 5. Improve delegation instructions

Upstream's bundled skill explains naming, tool authority, steering versus follow-up,
waiting for structured results and explicit cleanup. [Skill](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/skills/subagent/SKILL.md).

Adapt that operational clarity to our existing tools and prompt. Encourage task
packets with objective, owned files, constraints, output and completion criteria.
Explain when to keep a retained worker for concrete follow-up. Keep our asynchronous
parent notifications and result collection; another CLI is not needed for this UX.

## Preserve our existing policies

- Our reviewed roles, network/tool restrictions, builder worktrees, admission caps,
  cumulative budgets and exact-run controls remain authoritative.
- Upstream isolation flags are opt-outs; its CLI defaults those flags to false.
  Keep our explicit resource allowlists. [Spawn options](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/subagent.ts).
- Upstream's launcher prefers an executable `pi-test.sh` in the task directory.
  Do not adopt automatic repository-local launcher selection. Keep launcher identity
  explicit. [Launcher](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/shared.ts).
- Avoid synchronous process/filesystem polling on our render path. Retain event
  subscriptions and the bounded elapsed-time clock.
- The pinned tree contains no tests, CI configuration or LICENSE file, and its
  manifest is private `0.1.0` without test scripts. Use it as design evidence;
  review provenance before any source vendoring. [Tree](https://api.github.com/repos/badlogic/pi-subagent/git/trees/9b587a1e762d98094183ab8489137e952ef27d04?recursive=1),
  [manifest](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/package.json).

## Implementation order and acceptance

1. Contain render/callback failures and execute public-export/type and real panel
   render tests on resource-limited CI across supported Pi versions.
2. Add explicit delivery choice with preserved receipts; verify active follow-ups,
   unknown delivery, duplicate submissions and stale/replaced recipients.
3. Consolidate input routing; test remapped submit/newline keys, Kitty releases and
   repeats, pasted controls, resize, overlay stacking and both terminal modes.
4. Add completion collapse and retained-task browsing, then display names,
   actionable lifecycle labels, per-agent scroll state and unread indicators
   without changing the selected task or stealing prompt input.
5. Evaluate a separate persistent-process backend only after the current UI gates pass.

### Report-only timeout follow-up

The reported `report-only timeout; still running` notification is emitted by
[runtime.ts](../../pi/extensions/subagents/runtime.ts) for the manager's timeout
event. [armTimeout](../../pi/extensions/subagents/upstream/src/orch/manager.ts)
starts a one-shot timer at spawn or explicit re-arm, checks that the task remains
active, and emits a status event. It does not stop execution or inspect inactivity.
Progress does not reset this timer. Startup and waiting for an execution slot can
consume its elapsed interval.

`agent_spawn.timeoutMs` is optional, accepts 30 seconds through 5 minutes, and has no
implicit reporting timer when omitted. Re-arming replaces the pending timer from
the time of the call. This differs from `agent_wait.timeoutMs`, which bounds a wait,
and from supervisor turn/usage/deadline limits. The reported warning does not reveal
the actual timeout value or establish whether this particular worker was stalled.
[Tool schemas](../../pi/extensions/subagents/upstream/src/orch/tools.ts),
[root control](../../pi/extensions/subagents/root-service.ts).

Add this to the next UI phase: present elapsed reminders as informational task
status, include time since observed progress and current tool/queue state, and
reserve warnings for separately detected prolonged inactivity or an actual error.
Do not claim a definitive stall solely because a provider/tool emits no updates.
Coalesce parent reminders and keep execution budgets independent. Changing reminder
presentation must not silently stop, resume or extend worker execution authority.

## Completion behavior across implementations

Reviewed 2026-10-11. Documentation describes current versions; these observations
are source-backed, not hands-on acceptance tests of the other clients.

| Implementation | After a task finishes |
| --- | --- |
| Our native extension | All retained workers remain eligible for the dock; completion has no expiry filter. The widget clears when there are no workers or it is disabled. [Rows](../../pi/extensions/subagents/fleet-view.ts), [presentation](../../pi/extensions/subagents/manager-presentation.ts) |
| Tintinweb | Finished agents linger briefly in FleetView, then disappear. An already-open viewer stays open. Finished handles can resume retained sessions. [Upstream UI documentation](https://github.com/tintinweb/pi-subagents#fleetview) |
| Badlogic | Settled workers become idle. The compact widget and picker exclude exited processes, so idle workers remain available. [Pinned implementation](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/index.ts) |
| Claude Code | Current docs say successful background rows disappear immediately, with a 30-second footer hint and completed entry in `/tasks`. Open details stay open. Failed/stopped rows linger for 30 seconds. Older versions behaved differently. [Official completion behavior](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background) |
| Codex CLI | `/agent` inspects/switches threads; the main thread collects results. Official documentation describes asking Codex to close completed threads, but does not specify a CLI auto-hide duration. The web Active/Done lists are a different surface. [Official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) |

The reported screenshot has task selection active: the selected marker, Main row
and Esc hint indicate browsing. Expanded completed rows are useful in that state.
The missing distinction is between actively browsing tasks and the idle prompt.

## Proposed terminal experience

Draft recommendation only; this section does not implement or activate behavior.

### Default dock

- Show active, queued and attention-required tasks within a bounded dock.
- Give successful completion a brief visible transition (proposed default: five
  seconds), then fold it into a completed count while focus is on the root prompt.
- When every task is done, use one line instead of several completed rows:

  ```text
  ✓ 4 tasks completed · ←/↓ review
  ```

- Show `/agents tasks` as the fallback entry point when editor navigation is
  unavailable. Derive key hints from supported bindings. Enter at the root prompt
  must keep its normal editor meaning.
- Omit zero counts and repeated completion text. Put detailed turn/tool/token
  metrics in the expanded list or detail view.
- Keep failed or attention-required tasks visible until acknowledged or resolved.
  Acknowledging a failure does not make its result successful. User-stopped tasks
  can follow the normal completed-summary presentation, with their outcome intact.

### Retained tasks and stable navigation

- Add an expandable completed group to task browsing. This is a new view, not an
  existing `/agents history` command. Retain inspection and permitted follow-up
  for as long as the underlying session remains available.
- Do not remove, regroup or reorder rows while the user navigates the list. Defer
  completion collapse until returning to the root prompt. Live status may update.
- Keep the detail view open when its task finishes. Preserve each task's scroll,
  follow mode and draft when switching away and returning.
- Bind selection and actions to lifetime identity and expected run, never row
  position. If a task is removed externally, invalidate its actions explicitly;
  do not silently retarget Enter or a pending message to another worker.
- Preserve clamped arrows, key-release filtering, movement-only key repeats,
  paste handling, remapped editor actions and small-terminal behavior.
- Track unseen UI results independently from protocol result consumption. Opening
  the list alone should not mark every result seen or consume parent evidence.

### Session retention is a separate decision

Collapsing a row changes presentation only. It must not reap a thread, consume its
result, discard a draft or start another turn. The default in-memory configuration
retains at most four threads, so a tidy dock does not itself free admission capacity.
Offer the existing confirmed cleanup flow when capacity is full, with explicit
loss-of-follow-up wording. [Caps](../../pi/extensions/subagents/config.ts),
[cleanup](../../pi/extensions/subagents/manager-ui.ts).

Completed-task browsing is limited to the current runtime's retained information.
Do not promise transcript recovery after reload: bundled roles disable persisted
child sessions and output transcripts. Durable history remains a separate design.
[Role policy](../../pi/extensions/subagents/registry.ts).

### Recommended delivery slices

1. **Reliability:** contain render/input/callback failures and verify public Pi
   exports, real rendering and editor bindings across supported versions.
2. **Completion and status:** implement the compact idle dock, completed group,
   focus-aware collapse and factual elapsed-time reminders described above.
3. **Inspection and control:** add per-task scroll/unread state, explicit steering
   versus follow-up and delivery receipts without weakening existing run checks.
4. **Optional lifecycle work:** evaluate durable or separate-process workers only
   after the integrated experience passes acceptance checks.

Acceptance must cover completion during held-arrow navigation, completion while
reading details, several simultaneous completions, stale/replaced recipients,
resize, narrow terminals, draft preservation, repeated submit, overlay stacking
and full retained capacity. Confirm that collapsing affects neither notifications
nor results, budgets or worker execution. Use bounded CI and manual terminal
acceptance before claiming these behaviors work.

This review executed no upstream code, installed no package and changed no runtime
or user configuration. The local UI regression suite and interactive acceptance
remain outstanding as documented in [parity](../../pi/extensions/subagents/parity.md#verification-boundary).
