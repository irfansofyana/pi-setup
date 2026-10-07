# First-party subagents: implementation design

**Status:** proposed implementation contract; runtime implementation not started.
**Branch:** `feat/first-party-subagents`.
**Execution plan:** [dependency-ordered tasks](../plans/2026-10-07-first-party-subagents.md).
**Evidence:** [due diligence](../../setup/subagents-extension-research.md), checked against installed Pi `1.0.4` and Tintinweb `0.14.3`.

## Product scope and authorization

Build a package-owned, Codex-inspired agent system inside Pi: visible threads, explicit controls, parallel specialists, inspectable results, safe worktrees, recovery, and advanced orchestration.

The user expanded the original narrow-console proposal: “everything that we can possible do on pi ... as close as possible to codex ... fits to my setup,” then requested a new branch and implementation planning. Milestones order delivery; they do not permanently exclude advanced features. This design supersedes the earlier research document's suggested scope ceiling, not its factual evidence.

This step creates planning documents only. Repository implementation, provider-backed smoke tests, live activation, authority changes, configuration migration, and companion removal are distinct actions. No live mutation is authorized by this document. Do not commit, publish, deploy, or change installed roles/settings as part of planning.

“Codex-like” describes capabilities and workflows, not identical branding, hidden reasoning, desktop/cloud hosting, operating-system sandboxing, or identical version-specific tool names. Pi remains the host; native limitations are visible contracts.

## Full capability ledger

Delivery labels: **native** = Pi primitive; **build** = extension responsibility; **gate** = implementation must prove behavior; **optional** = on the roadmap, disabled unless selected. No row is a claim of shipped functionality.

| Capability | Delivery | Milestone | Fit and qualification |
| --- | --- | --- | --- |
| Specialized agents and independent conversations | Native + build | M1–M2 | Preserve four canonical role IDs and effective loadouts |
| Foreground/background and parallel admission | Build | M2 | Foreground waiting does not bypass concurrency |
| List/search fleet, task/model/status/current-tool views | Native events + build | M3 | Show queued and stopped work, not just active sessions |
| Inspect/switch threads; live output and tool details | Native events + build | M3 | Bounded expandable detail; preserve existing editor |
| Context-only messages and mailboxes | Gate + build | M1–M3 | No implicit new model turn; record actual delivery status |
| Steering, follow-ups, interrupt/stop | Native + build | M1–M3 | Steering waits for assistant/tool batch; interrupt is cooperative |
| Wait, result retrieval, consumption, close and resume | Native + build | M2–M5 | Completed is not closed; wait cancellation is not worker cancellation |
| Exact models/thinking, effective assignment, role skills | Native + build | M1–M2 | Model-neutral canonical templates; fail on unavailable explicit assignments |
| Fresh/snapshot/forked context and lineage | Native + build | M2/M5 | Fresh default; bounded opt-in inheritance; no automatic local context for Ciung |
| Turn/time/token/cost guardrails and usage display | Native usage + build | M2 | Usage estimates are not a billing guarantee or hard in-flight token ceiling |
| Worktree creation, diff/branch handoff and resumption | Build | M4 | Retain failed/dirty work; parent owns tests and integration |
| Result shelf, private optional transcripts and history | Native storage + build | M5 | Defaults preserve current nonpersistent child loadouts |
| Reload/session-switch/quit/restart reconciliation | Gate + build | M5 | No automatic replay; durable context required for cross-restart resume |
| Seamless same-process live reload reattachment | Gate + optional | M5b | Only after stable ownership/lease rebind tests; not assumed from native sessions |
| One-shot/interval/cron scheduling | Build + optional | M6 | Existing Prompt Loop scheduling remains separate; no new daemon by default |
| Graph/parallel/pipeline workflows; pause/retry/skip | Build + optional | M7 | Declarative plans and journals; no arbitrary JavaScript sandbox promise |
| Bounded nested delegation and parent-child trees | Build + optional | M7 | Explicit coordinator capability; canonical specialists remain nondelegating |
| Structured outputs and verification handoff | Gate + build | M7 | Local schema validation; provider constraints only when supported; tests remain parent-owned |
| TUI/RPC/headless programmatic control | Native + build | M3 | RPC does not support arbitrary TUI custom widgets |
| Goal Loop, Prompt Loop, Headroom and theme integration | Build | M1/M3/M8 | Preserve current contracts, provider routing and single-editor ownership |
| Setup audit, cutover and rollback | Build | M8 | Proposal-first, backups, drift checks; no install-time mutation |

An external always-on scheduler, cloud execution, operating-system sandbox, desktop/web client, and automatic publishing are not native Pi parity claims. They require separate infrastructure/product decisions. Do not recreate Pi's provider, memory, native MCP, or existing Goal/Prompt Loop systems.

## Architecture and file ownership

One deep supervisor module owns execution policy and lifecycle. Callers cross its interface rather than reproducing queue, cancellation, retention, or notification logic.

Suggested implementation layout; split further only when behavior warrants it:

| File under `pi/extensions/subagents/` | Responsibility |
| --- | --- |
| `index.ts` | Thin activation and native tool/command/event adapters; inert until deliberately enabled |
| `contracts.ts` | Versioned requests, snapshots, outcomes, control receipts, legacy mappings |
| `roles.ts` | Resolve trusted definitions into immutable effective loadouts before execution |
| `backend.ts` | SDK session adapter; a deterministic fake adapter supports tests; RPC only if selected by M1 |
| `supervisor.ts` | Identities, state transitions, admission, budgets, controls, results and parent delivery |
| `worktrees.ts` | Owned Git artifact leases, validation, preservation and recovery |
| `storage.ts` | Bounded result shelf, opt-in private durable state/outbox and schema migration |
| `presentation.ts` | Fleet/inspector projections and focus-safe targeted controls |
| `scheduler.ts` / `workflows.ts` | Optional callers of the supervisor; never alternate execution paths |
| `README.md` and adjacent tests | Implemented behavior, configuration ownership, limitations and verification |

The supervisor's proposed interface is `start`, `control`, `inspect`, `wait`, `subscribe`, and `dispose`. `control` accepts tagged operations; native tools translate into the same interface. Internal role/backend/storage/artifact seams remain private to the implementation. Do not expose SDK internals through tool results.

Dependencies injected at the seam: backend adapter, clock, ID generator, approved resource resolver, artifact store and notification sink. Production SDK plus deterministic test adapter justify the backend seam. Do not ship two production backends before one is proven.

## Backend/provider decision: M1 release blocker

Prefer in-process SDK for smallest native session/control integration, using explicit public construction of child `ModelRuntime`, controlled `ResourceLoader`, `SettingsManager.inMemory()` and `SessionManager.inMemory()` where the approved loadout requests no persistence.

`ExtensionContext` exposes a registry facade; installed `ModelRegistry.runtime` is private. Existing Tintinweb uses a cast to reuse it. Do not silently inherit that workaround or assume a newly constructed runtime automatically inherits parent extension providers.

M1 must prove exact model/auth resolution, extension-owned/custom-provider handling, Headroom ownership/routing/lease disposal, event ordering, resource restrictions and absence of unintended writes. Never dump credential stores into fixtures or reports. Test with fake credentials/transports in a temporary Pi home first.

Decision order:

1. Public child-runtime construction with explicitly approved provider/Headroom setup.
2. If insufficient, investigate native long-lived RPC with equivalent controlled resources/routing.
3. A narrow, version-checked compatibility bridge is an explicit reviewed exception, not the default.

Failure produces a typed unsupported-provider/backend result. Do not fall back to a different provider or direct upstream routing silently. One-shot CLI JSON cannot satisfy live controls. Process separation does not establish a sandbox.

Pi `1.0.4` is the evidence version, not an automatic package minimum. Test advertised Pi `>=1.0.0` or propose a deliberate minimum-version change with metadata/docs/tests aligned. Keep Node `>=22.19.0` compatibility unless separately changed.

## Role/loadout contract

Preserve authority through effective resources, not just frontmatter parsing:

| Role | Allowed work | Preserved exclusions |
| --- | --- | --- |
| `researcher` / Ciung | Sanitized public research; native `web_search`/`web_fetch`; `my-web-search` | Local filesystem tools/context inheritance, shell, arbitrary network tools, delegation |
| `code-mapper` / Laya | Local read/search plus approved FFF; current skills | Mutation, shell, network tools, delegation |
| `builder` / Sangkur | Read/edit/write/search in owned Git worktree plus FFF | Shell/test execution, network tools, delegation, merge/push/deploy/publish/secrets |
| `reviewer` / Prabu | Independent local read/search plus FFF; current review skill | Mutation, shell, network tools, delegation |

Headroom loads for routing, not tools. Preserve exact FFF tool exposure and approved skills. Every canonical role stays model-neutral, bounded, fresh-context and child-session/output-transcript disabled.

Trusted global definitions remain user-owned; inert package templates stay under `pi/agents/`. Project roles/extensions/skills are not silently preferred. Any project-loadout capability is explicit opt-in for reviewed trusted projects, with provenance in the effective snapshot.

Unknown/disabled roles and unavailable required tools/extensions/explicit models fail closed. No fallback to general-purpose. Load only approved extension factories; post-load filtering is too late. Omit ambient MCP/codemode/tool-search unless expressly included in an approved loadout. Registration/deferred exposure must not bypass tool ceilings.

Proposed precedence: role model pin → invocation → parent; display requested and effective assignment. Preserve current `scopeModels` guardrail semantics initially; stricter policies require an explicit migration choice. Reject missing explicit assignments instead of silently changing providers/models.

Proposed turn policy: role limits are authority ceilings; invocation/evaluator may request a lower cap, never enlarge it. Freeze the soft/grace/hard meaning in M0. Goal evaluator's two-turn hard cap has no inherited grace. Explain any intentional difference from old frontmatter-overrides-caller behavior; do not advertise unqualified drop-in compatibility.

## Context transfer contract: M2/M5 delivery gate

Fresh context remains the canonical default. Explicit snapshot/fork requests must select a source session, active branch and entry anchor; never copy whichever parent history happens to be current when a queued task starts. Record source lineage and the effective filtering/budget policy in the resolved loadout.

M2 constructs bounded, coherent snapshots and proves opt-in fork behavior with native session managers: preserve valid message/tool-call/result relationships, exclude disallowed source categories and reject a transfer that cannot produce valid allowed context. Do not assign raw `session.agent.state.messages` as a substitute for authoritative session-manager context. A transferred history never transfers model/tool/extension authority.

Ciung rejects automatic local parent-context transfer. Coordinator task packets still require sanitization; filtering is not a guarantee of detecting every secret or proprietary passage. M5 tests restored/forked lineage, missing anchors/context, abandoned branches and persisted-context availability. No silent switch from unavailable fork to broader/full history. Snapshot and true fork are distinct capabilities; unsupported backend behavior is labelled explicitly.

## Identity, lifecycle and control semantics

Separate stable `agentId`, conversation `threadId`, execution `runId`, input `controlId`, and parent ownership (`parentSessionId`, branch anchor, generation). Never reuse an old run promise, controller, turn counter or notification receipt during resume.

Thread state: `open → closing → closed`, with recovery/load state recorded separately.

Run state: `queued → initializing → running → stopping → terminal`; optional `quarantined` retains unresolved execution ownership. Terminal outcomes: `completed`, `failed`, `interrupted`, `cancelled`, `budget_exhausted`, or `orphaned`. Tool/model/retry/compaction/approval-wait activity is detail, not false terminal settlement.

Technical run completion does not prove substantive task acceptance. Parent tests/review remain mandatory before integration. Partial interrupted, failed, stopped or budget-exhausted output is explicitly incomplete.

| Operation | Required contract |
| --- | --- |
| Create/start | Allocate identity/thread; enqueue an identified task only when requested and admitted |
| Message | Store/deliver context without starting a model run; no implicit fallback to follow-up |
| Steer | Target current `expectedRunId`; native assistant/tool-batch delivery; no model/cwd/authority change |
| Follow-up | New run queued behind current work; idle thread may start after normal admission |
| Interrupt/stop | Cancel pending task continuations, clear/audit native queues, request abort; keep conversation available |
| Wait | Await named run(s) with timeout/cancellation; cancelling waiter never cancels worker |
| Result/consume | Immutable per-run outcome and artifact references; consuming suppresses matching pending notification, not history |
| Resume | Reopen retained context if available; executing another task creates a new run and undergoes admission |
| Close | Interrupt/drain before disposal; no implicit artifact/result deletion |

Control receipts distinguish acceptance, queueing, extension handling, proven injection/application, rejection and unknown delivery. A native `queued` response is not proof the model read the message. Input transformations and repeated identical text cannot be assumed to preserve correlation. M1 must verify context-only messaging and delivery receipts; unsupported behavior remains explicit, not silently emulated as a new turn.

Own follow-up admission in the supervisor initially. Blind forwarding to native `followUp()` can continue before `agent_settled`, obscure per-task run boundaries and bypass budgets. A queued follow-up enters native prompting only after its identified run is admitted.

One active run per thread; controls serialize and reject stale targets. Interrupt remains `stopping` until settlement. Unresolved abort does not release its concurrency slot or claim stopped execution. SDK abort cannot guarantee arbitrary tool side effects were stopped or undone; RPC escalation, if implemented, needs explicit process-ownership policy.

Subscribe before prompting. Handle prompts/input consumed by extensions without inventing a model run. `agent_end` may record finalized messages/usage; settle only at `agent_settled` or a typed pre-run failure. Record immutable terminal outcome once.

## Admission, budgets, nesting and parent delivery

- One FIFO admission module covers foreground, background, event RPC, resume, scheduling and workflows. Default concurrency remains 3. No bypass pool.
- Foreground means caller waits. Open idle threads do not occupy active-execution slots; separate caps bound retained threads/sessions.
- Canonical roles cannot delegate. Optional coordinator roles receive explicit descendant-role allowlists, depth/ancestry/shared-budget limits and workspace restrictions; no implicit authority expansion.
- M7 must solve parent-waits-child admission deadlock before enabling nested execution. A waiting parent cannot reserve all slots needed by its children; never solve this by unbounded bypass.
- Turn budgets, elapsed-time deadlines and shared ancestry budgets are supervisor-owned. Models cannot enlarge/reset them. Human budget changes are explicit controls.
- Token/cost thresholds use observed finalized usage. In-flight requests may overshoot; disclose missing usage, estimates and provider differences. Do not claim hard billing caps.
- Deduplicate usage by run/message identity; preserve input/output/cache categories and avoid counting descendants twice when reporting parent totals.
- Publish run-correlated completion once per owner generation; coalesce previews, keep retained results inspectable under the declared capacity policy and acknowledge consumption. No routine polling.
- Durable recovery uses an outbox plus receipts. Exactly-once application is a local invariant; transport/crash delivery may require retry/deduplication, not an exactly-once network guarantee.
- Provider/tool output is untrusted data. XML/control delimiters, terminal sequences, large arguments/results and private values cannot become instructions or terminal control.

### Capacity and backpressure: M0/M2/M5 delivery gate

Concurrency alone does not bound queued requests or retained output. Proposed extension-owned defaults below must be frozen and tested in M0; reviewed human configuration may change them. They are not a bound on SDK internals or process RSS.

| Domain | Proposed count ceiling | Proposed encoded-byte ceiling |
| --- | --- | --- |
| Pending runs, including follow-ups | 32 per owning root; 8 follow-ups per thread | 1 MiB aggregate queued payload |
| Pending mailbox/control input | 32 per thread | 256 KiB per thread; 4 MiB aggregate |
| Open/retained threads | 16 per owning root | Context governed by native compaction plus explicit transfer limits |
| Context snapshot | One coherent snapshot per start/fork request | 128 KiB serialized transfer |
| Live inspector buffers | One bounded buffer per thread | 256 KiB per thread; 4 MiB aggregate |
| Retained result reservations | 32 accepted-run slots | 256 KiB per retained result; 8 MiB aggregate |

Validate count and byte caps before accepting payloads; all launch paths share them. Typed `backpressure` receipts identify the exhausted domain and recovery options. Reserve result capacity before execution so a completed run is not silently evicted to admit another. Output beyond retained detail limits has explicit truncation/availability metadata; output completeness is separate from technical run completion.

At saturation, pause/reject new admission rather than silently spilling to disk or dropping unconsumed outcomes. Read/result retrieval and interrupt/close/consume controls remain available. Consumed-detail eviction follows a visible bounded retention policy; consuming a result is not authority to delete its worktree or rewrite parent history. M2/M5 acceptance tests cover saturation, reservation release, repeated follow-ups, large payloads and disabled persistence. M6/M7 cannot bypass backpressure or retry in a hot loop.

## Worktree/artifact contract

Use explicit committed base SHA and recorded canonical repository identity. Parent dirty/untracked state is not silently copied. Offer any snapshot-of-dirty-parent feature only with an explicit reviewed policy; do not treat a HEAD checkout as the current parent diff.

Record ownership, base, branch, path and run references before editing starts. Use asynchronous argv-based Git operations; validate paths/ownership and capture failures. Do not auto-commit with `--no-verify`, merge, push, or run gates on behalf of shell-free builder.

Retain changed worktrees by default. A branch alone does not preserve uncommitted edits. Return retained path, dirty state, diff/base and available branch/commit references. Resume uses the retained lease or a validated reconstruction, never a deleted cwd. Preservation or cleanup failure keeps recovery material and produces an explicit error; never force-remove unpreserved work.

Explicit discard/cleanup verifies ownership and reviewed dirty-state policy. Cover binary, untracked/ignored data, symlinks, dirty parent, renamed paths, signing/hooks, interrupted startup and multiple resumes. Worktrees/tool allowlists are not OS filesystem/network isolation.

## UI and modes

Recommended default: persistent compact fleet plus explicit `/agents` thread inspector, with main thread and children, queue/current activity, effective models, budgets, usage, results and artifact links. This combines Codex-style thread navigation with Pi's terminal layout.

Inspector offers separate Message/Steer/Follow-up/Stop/Resume/Close actions, selected target and delivery/outcome history. Tool details expand within bounded buffers with explicit truncation; show only provider/runtime-emitted information, never promise hidden reasoning. Stop confirmation must not be confused with closing the viewer.

No editor replacement or parent-arrow interception in the initial implementation. Respect focus, questionnaires, autocomplete, paste, Unicode/IME and regular/fullscreen resize. Existing theme retains editor/header/footer ownership; task content outranks decorative welcome artwork. Commands/shortcuts are namespaced and reviewed for collisions.

TUI may use custom widgets/viewers. RPC exposes typed controls/events plus native dialogs/status/string widgets; headless exposes programmatic controls and framed output. Do not use `ctx.hasUI` alone as a custom-TUI check or write raw logs to RPC stdout.

An offline, user-invoked demo uses fake sessions and disposable state, no credentials/model calls/global writes. Additional desktop/web clients are later clients of the same interface, not prerequisites.

## Retention, reload and recovery

Child session/output transcripts stay off by default for canonical roles. Live buffers/result shelf are bounded; result previews and normal parent Pi history may still persist. Never describe transcript-disable as erasing all disk/provider copies.

Optional durable storage: versioned private files (`0700` directories / `0600` files), same-directory atomic replacement, ownership/revision checks, corruption quarantine, retention controls, migrations that preserve originals. Never collect credentials. Transcripts/tool output remain sensitive even with redaction; no retention or cleanup activation without approval.

M5 baseline on reload, session replacement, `/new` and quit: interrupt/drain, preserve artifacts and mark unfinished work accurately; do not auto-rerun. Detached work is not silently orphaned. A restart can reconstruct metadata; conversation resume requires persisted context. Rebuild parent view from the active branch and lineage, not abandoned history.

M5b investigates retaining same-process workers across `/reload`, rebinding the host/UI/subscriptions without script replay or changed provider leases. It must prove generation ownership, notification buffering, grace timeout cleanup and discarded-activation disposal before being offered. Process-restart recovery is not live execution continuation.

## Advanced execution: retained roadmap, optional activation

M6 adds persisted one-shot/interval/cron jobs. Jobs enter ordinary loadout validation/admission/budgets. Define timezone/DST, overlap (default no overlap), missed-run policy (default no catch-up storm), cancellation and stable job ownership. Timers exist only while an owning Pi process runs unless a separate daemon is expressly approved.

M7 adds declarative versioned workflow graphs: parallel, pipeline, dependency outputs, structured result schemas, pause/retry/skip/cancel and replay journals. Cycles/caps/unknown roles fail validation before execution. Retries get new run IDs and never replay failed work automatically after restart. Do not add arbitrary executable scripts and call a VM an OS sandbox.

Verification steps produce explicit parent-owned verification requests/evidence or invoke an explicitly authorized executor. Workflow gates cannot smuggle shell/test authority into Sangkur. Optional broader worker/coordinator roles require separately reviewed definitions; current specialists are unchanged.

## Native integration and activation

Preserve legacy `Agent`, `get_subagent_result`, `steer_subagent` fields with explicit supported-field validation; add a versioned extended control interface rather than polluting legacy tools with ambiguous behavior. Give legacy invocation/result IDs an explicit mapping to new run/thread identity.

Preserve same-process `pi.events` protocol v2: `subagents:rpc:ping/spawn/stop`, request-correlated reply channels, `{success,data}` / `{success:false,error}`, and background `subagents:created/completed/failed` envelopes. These are not native Pi process RPC commands.

Goal evaluator needs `Explore`, fresh context, explicit cwd and a hard two-turn cap. Provide a reviewed dedicated internal evaluator loadout or a compatible read-only alias with verified authority; do not accidentally inherit mapper's larger budget. Current evaluator does not issue stop on timeout. Deliberately specify cancellation/late-result cleanup, including spawn-timeout orphans, rather than merely copying behavior.

Prompt Loop wakes only for correlated background work. A resumed run cannot be confused with a previous terminal event. Keep generated state, Todos, Hindsight, Managed Skills and other user-owned data untouched. Parent usage integration uses native usage fields without double-counting pi-stats totals.

Root package auto-loads `pi/extensions/*/index.ts`. New code must be inert by default during development: no competing tools, `/agents`, scheduler, workers, provider registrations or disk writes. Activation must be a pre-registration choice with isolated loader tests; do not rely on late tool discovery to prevent conflicts. M0 must fix the gate mechanism and configuration ownership before adding `index.ts`.

After approved cutover, update executable manifest, package tests, `README.md`, `AGENTS.md`, component guidance, `docs/setup/` and procedural setup skill together. Remove only the Tintinweb companion requirement/source through reviewed actions; FFF/stats remain separate companions. No auto-uninstall, postinstall deployment, state deletion or unknown-key rewrite. Live cutover backs up/re-reads targets, stops on drift and has a tested reverse procedure. `/reload` or restart follows approved activation.

## Decisions to freeze before implementation

| Decision | Recommended default | Gate |
| --- | --- | --- |
| Backend/provider reuse | Public child SDK runtime first; RPC fallback | M1, no private access assumption |
| Activation mechanism | Explicit inert pre-registration gate and isolated loader profile | M0; avoid duplicate sources |
| Models/scope | Keep pin/invocation/parent order and scope guardrail; reject unavailable explicit assignments | M0 compatibility fixtures |
| Turn limits/grace | Canonical ceiling, caller can lower; evaluator hard 2 | M0 explicit semantic change |
| Context-only messaging | No new turn; bounded mailbox if native delivery unavailable | M1 receipts and adapted-parity label |
| Worktree preservation | Retain changed worktrees; no automatic commit/discard | M4 artifact tests |
| Retention/recovery | Child persistence off; opt-in durable storage; no automatic replay | M5 lifecycle tests |
| Nested/scheduled/workflow authority | Implement capabilities; off for existing roles/default runtime | M6–M7 reviewed loadouts/settings |
| Live reload reattachment | Baseline safe shutdown; seamless mode only after proof | M5b |
| Pi minimum | Test `>=1.0.0` or deliberately revise floor | M1/M8 |

These defaults are proposed interface decisions, not approval to modify installed configuration or role authority. The execution plan records acceptance tests and review gates for each milestone.
