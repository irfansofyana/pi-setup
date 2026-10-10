# Native Subagents

Package-owned, default-inert native Pi child sessions. No child Pi subprocesses,
shell/test authority, ambient extension discovery or automatic live migration.
Use the [isolated manual-test launcher](preview.md); it leaves installed Pi
packages, global configuration, credentials and selected theme untouched.

## Behavior

- One supervisor owns FIFO admission, per-thread serialization, bounded result
  reservations, deadlines, shared turn/usage budgets and cooperative shutdown.
- Canonical researcher/code-mapper/builder/reviewer loadouts remain mechanically
  scoped. Trusted global role pins precede invocation and parent models; missing
  models/resources fail, never fall back silently. Parent public provider/auth
  APIs feed a separate in-memory child runtime; credentials are not copied.
- Builder writes only explicit scopes in a privately recorded worktree from
  committed HEAD. Artifacts survive failed/interrupted runs. Human-only recovery
  validates the retained lease; fresh artifact tasks do not restore conversations.
- Message is context-only; steer reports native disposition; follow-up/resume
  admits a distinct run. Receipts do not attest model consumption. Waiter
  cancellation leaves execution running. Technical completion is not verification.
- Explicit identified snapshots are bounded, coherent and destination-loadout
  filtered; researcher rejects local inheritance. True native fork is unsupported.
- Legacy tools plus version 1 advanced start/control/wait and protocol-v2 event
  adapters share admission. Explore has a dedicated fresh read-only hard-two
  evaluator. Background events are run/generation correlated; no automatic
  parent model turn. Prompt Loop rejects stale resumed-run completions.
- Compact text fleet and `/agents` inspector preserve editor/theme input ownership.
  Tool details and receipts are bounded; terminal controls are stripped. RPC uses
  text widgets/native dialogs, not terminal components. `/agents-demo` is synthetic.
- Persistence, schedules and declarative workflows are independently off by
  default. Private revisioned storage retains outcomes/outbox/journals, not child
  sessions/transcripts. Restart never replays; jobs/workflows recover paused.
- Scheduling is finite one-shot/interval/five-field UTC cron, without overlap or
  catch-up bursts. Failed launch pauses. Workflow graphs have at most 16 steps,
  three ready tasks, three attempts per step and 128 reserved turns. Local schema
  validation and human-owned verification cannot grant shell/test authority.
- Reload/session replacement drains. Unconfirmed cleanup quarantines the owner;
  seamless worker reattachment and persisted conversation resume are unsupported.

## Ownership and activation

`PI_SETUP_SUBAGENTS_PREVIEW=1` is set by the exclusive private-profile launcher.
Normal package auto-loading does nothing. The old `PI_SETUP_SUBAGENTS_ENABLED`
flag remains inert. Reviewed normal activation requires **both**
`PI_SETUP_SUBAGENTS_NATIVE=1` and global user-owned `subagents-native.json`, after
known companion sources are excluded before tool registration. Configuration and
cutover proposal/rollback belong to [Subagents](../../../docs/setup/subagents.md#native-runtime-cutover).
Repository implementation does not authorize that migration. Tintinweb remains a
required companion until an explicit repository-policy decision.

Native-mode CLI is supported by this implementation. Headroom CLI mode fails
closed; the [historical routed backend experiment](offline-evidence.md) is limited
to Pi 1.1.0, OpenAI API-key researcher, real parent lease and loopback fake transport.
No direct-provider fallback is permitted for a routed request.

## Validation and limits

Development SDKs are exact Pi 1.1.0; advertised Pi floor is 1.0.0. Targeted checks
use fresh serial, hard-capped processes and offline providers. Broad regressions
and Node/Pi version matrix belong to CI. Do not run repeated broad suites on a
shared VM; see [Operations](../../../docs/setup/operations.md#repository-validation-on-shared-hosts).

Default reviewed native caps: 3 executing, 16 threads, 32 pending/reserved results,
1 MiB queued input, 128 KiB snapshot, 256 KiB result detail, 64 KiB inspector per
thread. Launcher lowers execution to 1, threads to 4 and live result slots to 8.
Unconsumed outcomes are never evicted for admission. Consumed history is bounded
and may be pruned. One optional state document is capped at 32 MiB, accounting for
separate outcome/outbox/workflow shelves. Persistence failure blocks new work and
preserves in-memory outcomes plus original file evidence.

Allowlisted tools/worktrees are not an OS sandbox, billing cap or secret detector.
Parent history, tool/provider logs and explicitly retained result text may still
contain private data. Real model/auth, installed FFF, web requests and terminal
acceptance remain the user's manual gates. `/reload` or restart follows only an
approved normal activation; separate launcher sessions need no global reload.
