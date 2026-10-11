# Subagent Manager (pi-setup fork)

Package-owned, default-inert adaptation of [pi-subagent-manager](https://github.com/championswimmer/pi-subagent-manager), pinned at `1f037b1` (0.20.0, MIT). [Provenance and local patches](upstream/UPSTREAM.md).
Native Pi child sessions; no child Pi subprocesses,
shell/test authority, ambient extension discovery or automatic live migration.
Use the [isolated manual-test launcher](preview.md); it leaves installed Pi
packages, global configuration, credentials and selected theme untouched.

## Behavior

- Upstream ThreadManager owns named paths, retained thread lifecycle, root controls,
  tree navigation and the live transcript viewer. One policy supervisor beneath
  its driver owns FIFO admission, per-thread serialization, bounded result
  reservations, deadlines, shared turn/usage budgets and cooperative shutdown.
- Bundled defaults are researcher/scout/builder/reviewer; `code-mapper` aliases
  scout. Upstream-format custom Markdown types and settings-only YAML overrides
  live under `<agent-dir>/subagent-manager/agents/`. Trusted projects may supply
  `.pi/agent/subagent-manager/agents/`; untrusted project definitions never load.
  Retained threads keep their admitted definition snapshots across reload.
  Ordered exact model preferences and the configured picker policy apply; missing
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
  evaluator. Detached manager events coalesce into a hidden idle-parent wake;
  optional Final Recap waits for all outstanding asynchronous agents. Off mode,
  busy roots and closing generations suppress delivery. Foreground completion
  does not start another turn. Prompt Loop rejects stale resumed-run completions.
- Upstream `agent_types`, `agent_spawn`, `agent_wait`, `agent_steer`, `agent_status`,
  `agent_stop`, `agent_output` share the same manager as legacy tools/protocol.
  `/agents` opens upstream settings; `/agents types`, `import`, `reload`, `reap`
  and `tree` expose its editor, selected migration, reload, confirmed cleanup and
  live viewer. `/agents fleet` retains exact-run controls and consume/close.
  Import asks the current root model to migrate only selected sources; originals
  remain unchanged. It is not an automatic or model-free conversion.
  Ctrl+Shift+A opens the browser; Ctrl+Shift+C collapses/expands the widget.
  Full/minimal widgets, icon/loader preferences, costs and mode guidance are wired.
  Theme/editor input ownership is preserved; upstream editor-owned arrows are
  replaced by cooperative shortcuts. No automatic context inheritance or
  persisted child sessions activate.
  Tool details and receipts are bounded; terminal controls are stripped. RPC uses
  text widgets/native dialogs, not terminal components; use `/agents fleet` in RPC
  (the default upstream tree requires a terminal). `/agents-demo` is synthetic.
- Children receive progress and pause controls. Pause ends at the tool boundary
  without another model request, hands back no final answer and retains the
  in-memory context for `agent_steer`. Lifetime turns/deadlines/usage do not reset.
  Explicit exact-run turn grants are bounded to two per lifetime, each no larger
  than the initial allowance. Usage/deadlines never reset; exhausted backends,
  evaluators and schedule/workflow-reserved tasks cannot obtain these grants.
- Custom types can explicitly allow scoped `agent_*` delegation verbs. Built-ins
  cannot. Nested waits yield and reacquire the single shared model-execution slot;
  ancestors retain context, deadlines and cumulative usage. Relative paths are
  children; root-only absolute `/task` paths create independent trees. Depth is
  bounded to four levels including the main agent; all trees share thread/results
  caps. Child reports are context-only, not an automatic child-run scheduler.
  Scheduled/workflow-reserved tasks must use non-delegating types.
- Persistence, schedules and declarative workflows are independently off by
  default. Private revisioned storage retains outcomes/outbox/journals, not child
  sessions/transcripts. Restart never replays; jobs/workflows recover paused.
- Scheduling is finite one-shot/interval/five-field UTC cron, without overlap or
  catch-up bursts. Failed launch pauses. Workflow graphs have at most 16 steps,
  three ready tasks, three attempts per step and 128 reserved turns. Local schema
  validation and human-owned verification cannot grant shell/test authority.
- Reload/session replacement drains. Unconfirmed cleanup quarantines the owner;
  seamless worker reattachment and persisted conversation resume are unsupported.
  Root navigation drains before changing branches/sessions, then attaches a fresh
  generation. Settled cost records survive branch navigation and reaping.

## Ownership and activation

`PI_SETUP_SUBAGENTS_PREVIEW=1` is set by the exclusive private-profile launcher.
Normal package auto-loading does nothing. The old `PI_SETUP_SUBAGENTS_ENABLED`
flag remains inert. Reviewed normal activation requires **both**
`PI_SETUP_SUBAGENTS_NATIVE=1` and global user-owned `subagents-native.json`, after
known companion sources are excluded before tool registration. Configuration and
cutover proposal/rollback belong to [Subagents](../../../docs/setup/subagents.md#native-runtime-cutover).
Repository implementation does not authorize that migration. Tintinweb remains a
required companion until an explicit repository-policy decision.

`headroom-preferred` is the default routing policy: before each request, prefer the
parent's healthy compatible Headroom route; otherwise use the exact upstream
provider with a visible warning. Parent public auth APIs refresh API keys/OAuth
and headers per request. A submitted/streaming failure is never replayed. Child
agent/provider automatic retries are disabled; an explicit later continuation is
new work, not an automatic retry. Parent retry settings are unchanged. Child
sessions do not own/start a proxy or receive Headroom tools. Explicit `native`
routing bypasses Headroom. The [historical private lease experiment](offline-evidence.md)
remains separate and pinned; its fail-closed semantics do not govern this adapter.

## Validation and limits

Development SDKs are exact Pi 1.1.0; advertised Pi floor is 1.0.0. Targeted checks
use fresh serial, hard-capped processes and offline providers. Broad regressions
and Node/Pi version matrix belong to CI. Do not run repeated broad suites on a
shared VM; see [Operations](../../../docs/setup/operations.md#repository-validation-on-shared-hosts).
The inherited UI uses pinned `fuzzysort`, `shell-quote`, and `yaml` libraries.
Dialogs validate deployment ceilings before saving. Only explicitly reviewed
child tools are selectable; broader upstream tool-filtering modes reject with a
diagnostic rather than silently widening canonical roles.

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

## Upstream feature audit

The UI and permitted runtime features are implemented. See the
[feature-by-feature audit and exact setup differences](parity.md), not the original
upstream README, for effective behavior. Interactive terminal/provider acceptance
and broad CI regression remain pending; no live device cutover has been applied.
