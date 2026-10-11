# Subagent Manager (pi-setup fork)

Package-owned, default-enabled adaptation of [pi-subagent-manager](https://github.com/championswimmer/pi-subagent-manager), pinned at `1f037b1` (0.20.0, MIT). [Provenance and local patches](upstream/UPSTREAM.md).
Native Pi child sessions; no child Pi subprocesses,
shell/test authority, ambient extension discovery or automatic live migration.
Production runtime loads through `index.ts` and `runtime.ts`. No private-preview
launcher or synthetic demo command is shipped.

## Behavior

- Upstream ThreadManager owns named paths, retained thread lifecycle, root controls,
  tree navigation and the live transcript viewer. One policy supervisor beneath
  its driver owns FIFO admission, per-thread serialization, bounded result
  reservations, deadlines, shared turn/usage budgets and cooperative shutdown.
- Bundled defaults are researcher/scout/builder/reviewer; `code-mapper` aliases
  scout. Upstream-format custom Markdown types and settings-only YAML overrides
  live under `<agent-dir>/subagent-manager/agents/`. Trusted projects may supply
  `.pi/agent/subagent-manager/agents/`; untrusted project definitions never load.
  Retained threads keep their admitted definition snapshots across `/agents reload`;
  package `/reload` drains workers and replaces the runtime.
  Ordered exact model preferences and the configured picker policy apply; missing
  required custom resources fail, never widen authority silently. Bundled local
  roles need no companion package or external skill: built-in read/grep/find/ls
  remain available. Compatible parent FFF tools are optional, reviewed bridges;
  third-party packages and skills are not loaded into bundled child runtimes.
  Worktree children use their own built-ins rather than the parent's search index.
  Parent public provider/auth APIs feed a separate in-memory child runtime;
  credentials are not copied.
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
  `/agents tasks` opens the dedicated transcript/composer panel. `/agents` opens
  settings; `/agents types`, `import`, `reload`, `reap`
  and `tree` expose its editor, selected migration, reload, confirmed cleanup and
  live viewer. `/agents fleet` retains exact-run controls and consume/close.
  Import asks the current root model to migrate only selected sources; originals
  remain unchanged. It is not an automatic or model-free conversion.
  The task panel replaces the upstream count widget and browser chords;
  the advanced tree remains explicitly available. Icon/loader preferences still
  apply to the tree; costs and mode guidance remain wired. No automatic context
  inheritance or persisted child sessions activate.
  Tool details and receipts are bounded; terminal controls are stripped. RPC uses
  text widgets/native dialogs, not terminal components; use `/agents fleet` in RPC
  (the default upstream tree requires a terminal).
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

## Presentation defaults

Bundled role colors: `syntaxVariable` (researcher), `success` (scout),
`mdCodeBlockBorder` (builder), and `mdLink` (reviewer). Themes resolve these
semantic tokens. Default widget mode is `minimal`; existing user/project
settings and agent overrides remain authoritative.

## Inline navigation

```text
Subagents · 1 running · 1 queued
  ● research · Tool: web_fetch
  ○ review · Waiting for an execution slot
```

- At rest, Main shows a compact summary and one activity row per visible active
  subagent. Completed/stopped agents immediately fold into the heading, including
  unread counts, e.g. `Subagents · 2 completed · 2 unread`. Failed/paused agents
  get priority. Retention/budget explanations live in details; navigation hints
  appear only while selecting. Expanding restores retained tasks in creation order,
  with roles, state, unread counts and elapsed time. Selection and open details
  stay stable as agents finish.
- Todos and Subagents use a [shared presentation component](../shared/README.md):
  Todos first, at most six resting rows total, up to ten while selecting agents,
  fewer on short terminals. Either extension also works alone. Full/Minimal caps
  the resting Subagents section at six/three rows, subject to the shared budget;
  selection can reach every retained agent. Other sections keep a summary during
  navigation. No editor replacement or new global keybindings.
- In the integrated theme, an empty focused prompt's **←** or **↓** focuses the
  list at Main. **↑/↓** select without wrapping; **Enter** opens a task. **Esc**,
  **→**, or **↑** above Main returns prompt focus. Typing/paste returns to Main
  input. Autocomplete, dialogs, registered shortcuts and remapped keys take priority.
- **Left-click a task** in fullscreen mode, or use **`/agents tasks`** from any
  theme. `/agents tasks /root/name` opens a specific task. The panel uses Pi's
  public TUI overlay handle; cleanup removes only this panel. The theme retains
  its root editor and footer. Clicking the completed summary expands selection.
  Folding rows never reaps sessions, consumes outcomes or frees capacity.
- Details show full target path, task, actual model/thinking level, metrics and hard turn cap when
  known, wrapped user/assistant messages and tool names/states. Thinking content,
  raw tool payloads and provider error bodies are excluded. Tokens are cumulative
  usage; tool count covers the current run, not context fullness.
- In the panel, **↑/↓**, **PgUp/PgDn** scroll; **End** follows live output.
  Reading older messages suspends tail following. **←/→** switches tasks in
  stable order while browsing or with an empty steering draft. Scroll anchors,
  follow mode and drafts survive switching and reopening per task lifetime.
  New agent text increments unread indicators without jumping the viewport;
  following the tail marks the current projection seen. Counts cover the bounded
  recent text projection, not an archival message total. The session-owned UI
  store retains hashes and reading metadata, never raw snapshots or disk transcripts.
- **Enter** or **Tab** starts composing in the panel's dedicated multiline editor.
  While browsing, **S** chooses **Steer current work** and **F** chooses
  **Follow up after completion**. Follow-up queues a distinct run behind active
  work or continues a retained session. The initial mode is steer for active tasks,
  follow-up for settled tasks; subsequent selections remember the chosen mode.
  The configured submit binding sends; the configured newline binding inserts a newline. **Tab** or
  **Esc** leaves the composer with its draft kept; **Esc** from browsing closes
  the panel. Main's prompt always remains Main. Commands and `!bash` typed into
  the steering editor are literal agent text. Remapped submit/newline bindings
  take priority over panel shortcuts while composing.
- Both modes use the reviewed root service and bind lifetime/thread/run when
  composing. A changed run rejects; reopen the composer to capture the new target.
  Follow-up/resume controls with `expectedRunId` also reject stale runs after
  waiting for another continuation. Unfenced formal queueing remains supported.
  Queued, accepted, handled/applied, rejected and unknown delivery retain their
  receipt status; no receipt proves model consumption. Rejected/uncertain sends
  retain the draft. Unknown delivery blocks retry until **R** while browsing;
  inspect the task first to avoid duplicate instructions. Lifetime budgets still
  apply. Reading state, receipts and drafts clear on session replacement/reload.
- Key releases never navigate or submit; held movement keys repeat, but held
  Enter does not open/send twice. Stale clicks and replaced identities reject.
  Small docks keep the selected recipient visible.
- Render/input/observer failures close the affected detail panel and remove only
  its overlay, retaining the last saved draft. A dock failure releases navigation
  input and shows a command fallback. Diagnostics identify the failing UI phase
  and error class without exposing raw provider errors. `/agents tasks` retries.
- Active elapsed time and the brief completion grace refresh once per second;
  settled fleets stop the clock after the final collapsed render. Messages arrive through the
  live observer. Off, shutdown and session changes dispose overlays, observers,
  clocks and input hooks. Navigation never stops workers; `/agents fleet` owns
  additional stop/close/budget controls and `/agents reap` confirms cleanup.

Interaction reference: [Tintinweb's fleet and conversation UI](https://github.com/tintinweb/pi-subagents/tree/bb7d2082235a61169c30d6e05de370cba95da62d/src/ui).
This package implements a Claude-style task panel with its existing native manager
and stricter display projection. It does not install the Tintinweb runtime.
After updating the package, run `/reload` or restart Pi.

The task-panel projection omits thinking, tool payloads and provider error fields.
This is not whole-transcript sanitization: SDK/live-manager snapshots may retain
raw messages/error fields in memory; advanced viewers and retained result text
can contain private data. Child transcripts are not persisted by this adapter.

## Optional-resource failures

Broken or missing optional parent search tools do not block bundled local roles.
Invalid optional metadata is skipped; optional-tool initialization failure narrows
fresh bundled sessions to built-ins before any model request. A failed optional
search call returns a tool error with a built-in fallback hint, not a fleet failure.
Explicit custom resource requirements still fail closed. Structured startup
outcomes retain known, bounded error codes; live snapshots are a separate surface.

Children do not discover ambient third-party extensions or inherit their session
hooks. This is same-process isolation, not an OS/process sandbox: an extension that
crashes, hangs or corrupts the Pi process can still affect every session.

## Ownership and activation

Normal package loading registers `/agents` and native tools without environment
flags or a config file. Missing global `subagents-native.json` uses in-memory
caps of 3 executing, 4 threads, 8 result slots and 4 pending; nothing is written.
Existing validated configuration is preserved. `PI_SETUP_SUBAGENTS_NATIVE=0` or
`{"version":1,"enabled":false}` in the global config disables registration.
Known configured Tintinweb sources suppress default registration; explicit
`PI_SETUP_SUBAGENTS_NATIVE=1` instead rejects the conflict. No companion is removed.
Malformed configuration fails closed. Project configuration cannot enable native
features. Configuration and reviewed legacy cutover belong to
[Subagents](../../../docs/setup/subagents.md#native-runtime-cutover).
Removed preview flags have no effect. The old `PI_SETUP_SUBAGENTS_ENABLED` flag
also has no effect. Tintinweb is no longer required.

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

Development SDKs are exact Pi 1.1.0; advertised Pi floor is 1.0.0. SDK session checks
require fresh serial, hard-capped processes and offline providers. Inline controller
and mocked-editor fixtures do not instantiate SDK sessions or call providers;
real SDK/TUI acceptance remains separate. Broad regressions and the Node/Pi matrix
belong to CI. Do not run repeated broad suites on a
shared VM; see [Operations](../../../docs/setup/operations.md#repository-validation-on-shared-hosts).
The inherited UI uses pinned `fuzzysort`, `shell-quote`, and `yaml` libraries.
Dialogs validate deployment ceilings before saving. Only explicitly reviewed
child tools are selectable; broader upstream tool-filtering modes reject with a
diagnostic rather than silently widening canonical roles.

Config-file defaults: 3 executing, 16 threads, 32 pending/reserved results; without a
config file, conservative caps above apply. Common limits:
1 MiB queued input, 128 KiB snapshot, 256 KiB result detail, 64 KiB inspector per
thread. Concurrency counts executing children, not retained threads or nesting.
`/agents` settings can lower execution limits, but cannot exceed the deployment
ceiling. A global `subagents-native.json` can explicitly set a higher ceiling
(for example `concurrency: 6`, `threads: 8`, `slots: 16`, `pending: 8`); preserve
existing user caps and review host/provider capacity before raising them.
Unconsumed outcomes are never evicted for admission. Consumed history is bounded
and may be pruned. One optional state document is capped at 32 MiB, accounting for
separate outcome/outbox/workflow shelves. Persistence failure blocks new work and
preserves in-memory outcomes plus original file evidence.

Allowlisted tools/worktrees are not an OS sandbox, billing cap or secret detector.
Parent history, tool/provider logs and explicitly retained result text may still
contain private data. Real model/auth, optional parent FFF, web requests and terminal
acceptance remain the user's manual gates. Run `/reload` after package/config
changes; restart after environment changes. Separate launcher sessions need no global reload.

## Upstream feature audit

The UI and permitted runtime features are implemented. See the
[feature-by-feature audit and exact setup differences](parity.md), not the original
upstream README, for effective behavior. Interactive terminal/provider acceptance
and broad CI regression remain pending; no live device cutover has been applied.
