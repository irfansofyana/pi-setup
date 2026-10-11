# First-party subagents: implementation plan

**Status:** supported native runtime and optional scheduling/workflows implemented and ready for manual acceptance in the uncommitted working tree. M8 broad CI/version-floor, repository companion-policy and live cutover gates remain pending. Milestone checkboxes are historical exit gates, not a claim that the implementation is absent or the full roadmap has been accepted.
**Branch:** `feat/first-party-subagents`.
**Design:** [full capability and interface contract](../specs/2026-10-07-first-party-subagents-design.md).
**Research:** [source-backed due diligence](../../setup/subagents-extension-research.md).

## Full implementation continuation — 2026-10-09

User requests the full planned implementation before manual acceptance, superseding the preview-only packet below. Execute inline and serially in the current feature checkout; preserve previous edits. No commits, paid calls, live migration, publication or installed-source removal are authorized.

Execution tasks, in order:

1. M3: protocol-v2 lifecycle/RPC adapters, legacy supported fields, dedicated hard-two Explore evaluator, timeout/orphan cleanup and owner-generation consumption. Test fast completion, stale/duplicate events, stop/timeout and Loop compatibility.
2. M4: run-correlated artifact references, validated retained ownership recovery and explicit cleanup with dirty-state review. Tests must prevent unrelated/moved/symlinked worktree removal and retain failed evidence.
3. M5: optional private atomic revisioned storage, result/outbox recovery, lifecycle ownership, retention controls and authoritative-context availability. No automatic replay or metadata-only conversation resume; safe drain is the M5b baseline unless native seamless proof succeeds.
4. M6: disabled-by-default one-shot/interval/cron scheduling, finite parser policy, fake-clock tests, no overlap/catch-up storm, single-owner launch through normal admission; no daemon or new runtime dependency.
5. M7: disabled-by-default declarative bounded graphs, local structured output validation, pause/retry/skip/cancel and journals; verification stays parent-owned. Specialists do not gain delegation authority. Broader model coordinator loadouts require their separate review gate.
6. M0/M1/M2/M8 closure: integrate tools/UI/context/budgets/configuration and migration rehearsal, update exact feature/version ledger and owning docs/manifest contracts as appropriate. Serial capped targeted regression and offline loader/PTY validation; broad suite on separate CI/manual runner, not this VM.

Ruling: the existing design/roadmap is the implementation brief; do not restart design approvals for already specified features. Explicitly gated authority expansion/live operations remain separate. Unsupported native fork/seamless-reload semantics must stay explicit, not be simulated by broader history or replay.

Progress: implementation and the single independent review/five-fix pass are finished for the supported native manual-test target. See the final handoff ledger below for fresh evidence and exclusions; no full-roadmap/release acceptance claim.

Continuation ledger (2026-10-09, inline; no commits/live activation):

- Workflow terminal-journal/budget regressions RED/GREEN 4/4: completed journals survive disposal, model plans cannot raise the reviewed 128-turn cap. Recovered workflows remain paused, with in-flight steps orphaned, never replayed.
- Scheduler recovery/hot-retry and evaluator-final-at-hard-cap RED/GREEN 14/14 combined focused cases. Restored jobs are actionable paused objects; failed admission/lease pauses rather than retrying forever. Final `stop` at the exact hard turn cap succeeds, but cannot admit a follow-up.
- Role-filtered context and per-run (not lifetime) accounting RED/GREEN 16/16. Native trusted backend accepts an explicit identified snapshot; forbidden tool history fails closed. True fork remains explicitly unsupported.
- Opt-in atomic storage/revision/corruption/dead-lease tests 3/3; stale reconciliation requires human UI and a verified dead PID, preserves original lock evidence. Process-wide reload ownership is sticky on unconfirmed cleanup (1/1). Safe drain baseline, not seamless worker reattachment.
- Orchestration drain/restart/follow-up tests 2/2: persistence-off writes nothing, final interruptions survive shutdown, restart launches nothing, schedules restore paused, new same-thread runs reserve orphan metadata. Storage permits a finite 32 MiB document for independently bounded results/outbox/journals; live result shelf remains 32 × 256 KiB.
- Launcher/presentation/ownership tests 4/4; prepare-only/reuse preserves private role pins. Native eight-tool loader/real offline child/workflow/store integration 2/2, including pre-registration companion conflict. CLI persistence/schedules/workflows/integration are explicit flags; no live profile was changed.
- Native human controls added for outcomes, notifications, jobs, workflows, verification, and artifact recovery/discard. Real artifact discard remains human-only; model tools cannot approve it. Actual terminal/provider/FFF acceptance remains pending.
- Ruling: retain the three required companions until the explicit AGENTS/M8 conflict receives user direction. Native implementation can be rehearsed exclusively without uninstalling or changing live configuration. New native activation uses both a dedicated environment opt-in and user-owned global `subagents-native.json`; old enable flag remains inert.
- Exact Pi 1.1.0 development dependencies/lock now replace stale 0.84.x development resolutions; lock-only update ran under 512 MiB/no-swap/25% CPU/180 s with scripts disabled. Host runtime peers and companions remain separate. Broad Node/Pi floor matrix is CI-owned, not run as a full suite on the shared VM.
- Historical closure work at this checkpoint: offline demo/PTY, SDK boundary regressions, optional-feature coverage, version-floor evidence, docs/cutover rehearsal, independent review and focused regression. Current disposition is recorded in the final handoff ledger below; do not mistake this checkpoint for current status.

- Protocol module RED/GREEN 2 cases; real dedicated evaluator backend RED/GREEN plus backend regressions 7/7; Goal evaluator spawn/terminal-timeout cleanup RED/GREEN 5/5. Native adapter now registers protocol on session start, supports supported legacy fields/resume and explicit Explore hard-two preparation. Native adapter regression 2/2; full Goal/Loop integration still being completed.
- Worktree recovery/discard RED/GREEN 2/2 with exact private ownership, status-drift checks, ignored/untracked dirty review and preservation of the parent checkout. Discard is an API, not model-exposed approval. Settled artifact result capture RED/GREEN; supervisor 23/23, builder 1/1, protocol 2/2. Runtime artifact recovery/cleanup presentation remains to wire.
- Private store RED/GREEN 2/2: off means no files, private directories/files, exclusive lease, atomic revisioned state, corruption/future/foreign-owner preservation. Recovery and retention integration remains to wire.
- Scheduler core RED/GREEN 2/2 fake-clock cases: disabled by default, ordinary launch callback, one-shot/interval/UTC cron, no overlap/catch-up burst, separate future-pause/active-stop, bounded timers. Ruling: dependency-free cron is explicitly UTC with finite five-field grammar; non-UTC/DST zones reject rather than silently run at the wrong time. Restored-job ownership/paused integration remains to wire.
- Workflow core RED/GREEN 3 cases plus journal recovery RED/GREEN (4/4): finite acyclic graphs, existing specialist roles only, dependency evidence as data, bounded local JSON-schema subset, shared reserved turn budget, parent-owned verification seam, explicit retry/skip/cancel, recovered running steps fail as orphaned and remain paused. Ruling: declarative host coordination holds no model execution slot, avoiding parent-waits-child deadlock without widening specialist tools; broader model coordinator roles remain separately reviewed/off. Runtime tools/UI, additional edge coverage and final review remain required.
- Shared-host limits remain 512 MiB/no swap/25% CPU/32 tasks/60 seconds per serial test file; memory precheck ~9 GiB available. No install, real provider, live profile/config migration, publication or commit was performed during this continuation.

## Goal and execution rules

Own the full Pi-compatible Codex-style subagent experience without the Tintinweb runtime dependency. Delivery phases are dependency order, not a permanent MVP ceiling. Implement advanced scheduling, workflows and controlled delegation as optional capabilities; preserve current default specialist authority.

This change checks out the branch and writes plans only. Do not start runtime implementation, activate resources, migrate live settings, remove installed sources, run provider-backed smoke tests, commit or publish as part of planning.

Implementation rules:

- Follow current `AGENTS.md`, not stale manual-copy/permission instructions in historical plans.
- Use behavioral tests first. Builder may prepare tests/code in a worktree; parent executes tests and independently reviews the actual diff/evidence.
- Work in small vertical slices. Record failed/passed commands and unverified assumptions; never call an unexecuted test RED/GREEN.
- Keep canonical roles model-neutral, fresh-context, bounded and transcript-disabled; preserve the current role tool exclusions.
- Native model/session execution and integration acceptance are separate. Partial/aborted output is not completion evidence.
- Do not invent a sandbox, hard billing cap, seamless reload guarantee or context-delivery acknowledgement.
- No new runtime dependency in the core without a concrete reviewed need. Optional cron/schema tooling requires a separate dependency decision.
- Live setup migration remains approval-gated; preserve unknown keys, credentials, logs, role pins, state, MCP and other companions.

## Dependency order and rollout

```text
M0 contracts/activation -> M1 backend/provider -> M2 supervisor
M2 -> M3 fleet + compatibility
M2 -> M4 worktrees
M3 + M4 -> M5 retention/recovery
M5 -> M5b live-reload feasibility
M2 + M5 -> M6 scheduler
M2 + M4 + M5 -> M7 workflows/delegation
M0..M7 + disposition of M5b -> M8 full-target migration/release
```

M3 and M4 can be prepared independently once shared contracts stabilize. No parallel edits to the supervisor/contracts without a coordinated change packet. M6/M7 remain in scope but disabled by default. A separately approved preview cutover after M0–M5 is not full-roadmap completion.

## M0 — Freeze contracts and safe activation

**Files:** create `pi/extensions/subagents/contracts.ts`, `contracts.test.ts`, `roles.test.ts`, `activation.test.ts` and sanitized fixture data. Create a thin `index.ts` only once the inert activation mechanism is tested. Do not change `piSetup.requiredPackages` yet.

- [ ] Extract current tool fields, protocol v2 replies and lifecycle envelopes into reviewed fixtures. Preserve types and casing; remove private prompts, paths, IDs and credentials.
- [ ] Freeze stable agent/thread/run/control IDs and the supervisor interface (`start/control/inspect/wait/subscribe/dispose`).
- [ ] Freeze count/byte ceilings for queued tasks/follow-ups, mailboxes, open threads, context transfers, viewer buffers and result reservations; specify typed backpressure and unconsumed-result saturation behavior.
- [ ] Specify exact create/message/steer/follow-up/interrupt/wait/result/consume/resume/close contracts, errors, completeness and supported fields.
- [ ] Freeze role ceilings, model precedence, lower invocation turn caps, evaluator hard two-turn cap and explicit grace semantics. Record intentional compatibility differences.
- [ ] Define config ownership and a pre-registration enable gate. New entrypoint is default-inert even though the root manifest auto-loads extension directories.
- [ ] Test loading the package with Tintinweb present: no duplicate tools/commands, provider routes, timers, workers or state writes from inactive first-party runtime.
- [ ] Prepare an isolated temporary-home activation profile that excludes Tintinweb and includes only approved first-party/FFF resources. No live source changes.

**Cases:** unknown/disabled role; unsupported field; malformed IDs; absent explicit model/tool; exact legacy envelope; inactive extension load; active profile cannot register two runtimes; prototype fixtures contain no personal data.

**Exit gate:** reviewed contracts and activation mechanism. Decide which changes intentionally improve old behavior; do not claim complete backward compatibility without tests.

## M1 — Native backend/provider feasibility spike

**Depends on:** M0.
**Files:** `backend.ts`, `backend.test.ts`, `roles.ts`, native/offline smoke script and initial module `README.md`; provider/Headroom compatibility helpers only if needed.

- [ ] Build deterministic backend/provider adapters and controlled resources in a temporary Pi home.
- [ ] Use public child `ModelRuntime` construction first; do not cast private parent runtime by default.
- [ ] Resolve exact provider/model, approved extensions, named skills and built-in/FFF tool exposure before worker creation.
- [ ] Bind approved extensions and prove Headroom routing/ownership, custom-provider behavior and shutdown lease release. Unsupported provider configuration fails explicitly.
- [ ] Prove one read-only agent starts, streams text/tool events, settles and disposes without real model/network calls or persistent child/settings files.
- [ ] Test native `steer`, context-only message candidate, queue clearing and cooperative abort. Confirm no-start messaging and honest receipts; use a bounded mailbox adaptation if necessary.
- [ ] Prove retries, compaction, handled prompts and pending input do not produce premature/duplicate completion.
- [ ] Test initialization cancellation and extension shutdown before disposal. Check post-load filtering cannot execute an unapproved factory.
- [ ] Validate installed Pi `1.0.4`; prepare a supported-floor validation strategy for advertised `>=1.0.0` and Node `>=22.19.0`.
- [ ] Record SDK/RPC/bridge decision and supported provider cases. If public SDK setup fails, choose a long-lived RPC investigation rather than silent model/routing fallback.

**Exit gate:** real native Pi offline loader/session evidence for routing, effective loadouts, controls, settlement and disposal. Private bridge or new minimum version requires explicit review. Provider-backed smoke is a later separately approved check, not a substitute for deterministic tests.

## M1 routing amendment

User correction supersedes the original mandatory-Headroom interpretation: derive explicit `native` or `headroom` mode from reviewed configuration/loadout. Native mode deliberately omits Headroom and may use the direct provider; enabled Headroom mode must fail closed on missing/lost routing, with no direct-upstream request or silent native fallback. Prove native Ciung in a temporary-home fake-provider run first. The public `ModelRuntime.registerProvider(... streamSimple)` dispatch seam is a candidate for a version-checked, route-only child wrapper that rechecks the lease per request; extension event hooks swallow failures and are not a safety boundary. Do not mark routed canonical execution complete until a real parent lease, child runtime, exact auth/model, retry/transport handling, and disposal/release are tested together. No live config/template edits or activation.

## M2 — Supervisor, admission and budgets

**Depends on:** selected backend from M1.
**Files:** `supervisor.ts`, `supervisor.test.ts`, contracts/loadout helpers and test adapters.

- [ ] Implement identified task runs, per-thread serialized controls and immutable terminal results.
- [ ] Construct explicitly requested bounded context snapshots/forks from identified source branch/entry anchors through authoritative session managers; transfer context, never authority.
- [ ] Test coherent message/tool-history transfer, source/lineage selection, missing anchors, privacy/loadout filtering, canonical fresh defaults and Ciung's rejection of automatic local-context inheritance.
- [ ] Implement one admission queue across foreground/background/RPC/resume; default concurrency 3; bound idle retained sessions separately.
- [ ] Enforce shared count/byte caps and result reservations before admission; typed backpressure preserves retrieval/stop controls and does not silently discard outcomes or spill to disk.
- [ ] Subscribe before submission; correlate callbacks by run/generation; settle only at native `agent_settled` or typed pre-run failure.
- [ ] Implement queued cancellation, initialization abort, stopping/quarantine and complete drain. Do not release slots while execution remains unresolved.
- [ ] Schedule follow-ups as new admitted runs, not untracked native continuations.
- [ ] Implement wait-one/wait-many/timeout; cancelled waiter leaves work running.
- [ ] Implement role/invocation turn ceilings, optional deadlines and observed token/cost thresholds. Account for provider overshoot and unknown usage.
- [ ] Deduplicate finalized usage and distinguish input/output/cache categories, nested aggregation and estimates.
- [ ] Implement consumption and owner-generation notification records; no short eviction that makes unconsumed results disappear.

**Cases:** one active run/thread; queue fairness; simultaneous completion; stale target; steer/stop/close race; extension-transformed input; repeated equal messages; follow-up admission; queued cancellation; abort during startup; retry/compaction; exhausted budgets; result inspection without deletion; new resume run uses new controller/promise/budget; waiter cancellation; partial output never masquerades as accepted work; snapshot/fork source and lineage; coherent tool pairs; denied context categories; count/byte saturation; oversized input; full result shelf; reservation release without lost unconsumed outcomes.

**Exit gate:** observable supervisor invariants pass through its interface with deterministic adapters. No UI, scheduler or workflow owns a second execution queue.

## M3 — Fleet, controls and integration adapters

**Depends on:** M2.
**Files:** `presentation.ts`, `presentation.test.ts`, `index.ts`, `index.test.ts`, adapter tests, offline demo/PTY smoke; narrow changes to Goal/Prompt Loop only if required by explicit compatibility decisions.

- [ ] Add compact fleet covering main, queued, active, stopped and retained work; display effective model, task, activity, elapsed time, usage and limits.
- [ ] Add live thread inspector with scroll/follow mode, bounded expandable tool arguments/progress/results and explicit truncation.
- [ ] Add targeted Message/Steer/Follow-up/Stop/Resume/Close controls and receipt history. Closing inspector is not closing/interruption of worker.
- [ ] Preserve theme/editor ownership; use explicit inspector entry/shortcuts rather than parent-arrow capture.
- [ ] Preserve `Agent/get_subagent_result/steer_subagent` schemas where supported; expose advanced controls through a versioned extended interface.
- [ ] Preserve protocol v2 ping/spawn/stop and background created/completed/failed envelopes with explicit legacy-ID/run mapping.
- [ ] Support Goal evaluator `Explore` via reviewed internal loadout/alias with fresh context, current cwd and hard two-turn cap.
- [ ] Specify evaluator timeout/spawn-timeout cleanup, late event handling and orphan detection; current evaluator does not issue stop on timeout.
- [ ] Verify Prompt Loop early-event buffering and run correlation; result consumption prevents matching duplicate parent delivery.
- [ ] Define TUI/RPC/headless results and error behavior. Never print unframed logs to RPC stdout.
- [ ] Add user-invoked disposable fake-agent demo and offline native PTY smoke; no global settings or model calls.

**Cases:** narrow/resize/Unicode/IME/paste; questionnaire/autocomplete focus; existing green editor/footer; regular/fullscreen; ANSI/control injection; bounded streaming render cost; no idle polling timer leaks; fast child completion before spawn reply; stopped/failed evaluator; unrelated events; resumed legacy ID maps current run; consumed result/queued notification; usage reporting does not double-count pi-stats.

**Exit gate:** current Goal/Prompt Loop contracts remain valid; native UI smoke passes and non-TUI behavior is explicit. No live activation or theme change.

## M4 — Builder artifacts and lossless worktrees

**Depends on:** M2; shared presentation fields from M3 may follow later.
**Files:** `worktrees.ts`, `worktrees.test.ts`, artifact contracts/storage hooks and supervisor integration tests.

- [ ] Create asynchronous owned worktrees from explicit committed base SHA; record repository/path/branch/base/owner before agent editing.
- [ ] Enforce builder loadout and task file-scope policy without describing it as an OS sandbox.
- [ ] Retain dirty worktrees and return real path/diff/base/branch/commit references. Do not auto-commit, merge, push or run test gates.
- [ ] Resume using a retained validated artifact lease; never use deleted cwd or silently switch to main checkout.
- [ ] Implement explicitly requested cleanup/discard policy after ownership/dirty-state checks; failure retains evidence and recovery instructions.
- [ ] Surface artifacts in result and inspector; distinguish an existing branch from uncommitted changes retained only in a worktree.

**Cases:** dirty/untracked parent not copied silently; binary/untracked/ignored files; symlinks; alternate cwd/subdirectory; interrupted creation; Git timeouts/signing/hooks; failed branch/preservation/cleanup; repeated resume; canonical paths; parent/worktree deletion or move; unrelated worktree cannot be removed.

**Exit gate:** all four canonical roles function with original authority; builder changes remain inspectable and recoverable on failure. Parent owns actual tests/review/integration.

## M5 — Result shelf, persistence and recovery

**Depends on:** M3 + M4.
**Files:** `storage.ts`, `storage.test.ts`, supervisor ownership/recovery tests and retention UI.

- [ ] Bound in-memory shelf, buffers and inactive session resources; retain unconsumed outcomes under documented policy.
- [ ] Test full-shelf backpressure, result-capacity reservations, explicit output truncation and consumed-detail retention without automatic persistence or unconsumed-result eviction.
- [ ] Add opt-in versioned private persistence with revision/ownership checks, atomic writes, corruption handling and migration that preserves originals.
- [ ] Separate metadata/results, child context, output transcripts, jobs/journals and parent Pi history. Do not equate transcript-disable with no disk/provider retention.
- [ ] Add notification outbox and deduplication receipts for recovery; document actual crash-delivery guarantees.
- [ ] Reconstruct parent view from active branch and lineage. A fork/session switch cannot silently acquire another generation's workers.
- [ ] Restore explicitly requested child snapshot/fork lineage and authoritative context; test missing source entries, abandoned branches, disabled persistence and unavailable conversation history without silent broader-history fallback.
- [ ] Define safe baseline for `/reload`, `/new`, session replacement, quit and restart: interrupt/drain, preserve artifacts, no automatic rerun.
- [ ] Reconcile orphaned/quarantined workers and artifact leases; resume old conversation only when required context survived.
- [ ] Add retention inspection and explicitly approved cleanup; never delete legacy package logs/state automatically.

**Cases:** partial/failed writes; revision/lease conflicts; corrupt/future schema; branch abandonment; duplicate receipts; startup recovery; missing persisted context; stale/dirty worktree; no live workers falsely reconstructed from metadata; cleanup cannot escape owned roots; default role persistence remains disabled; restored child-context lineage and authority filtering; shelf/message/queue byte saturation; retained outcomes remain retrievable while admission is blocked.

**Exit gate:** restart/reload behavior is accurate and recoverable with no unnoticed execution or secret-storage claims.

### M5b — Seamless live reload feasibility

- [ ] Prototype same-process worker ownership across reload without rerunning tasks/workflows or losing provider leases.
- [ ] Rebind host/UI/subscriptions, buffer notifications during handoff, reject stale controls and dispose abandoned activations after a bounded grace period.
- [ ] Test successful handoff, failed activation, repeated reload, quit during handoff, parent branch/session replacement and shared Headroom lifetime.

**Gate:** ship only after native proof. Otherwise retain safe M5 shutdown/recovery and mark seamless reattachment an adapted/unsupported capability, with a documented reason. Process restart does not preserve in-flight SDK execution.

## M6 — Optional scheduled execution

**Depends on:** M2 + M5.
**Files:** `scheduler.ts`, `scheduler.test.ts`, job contracts/storage/control projections.

- [ ] Add one-shot/interval/cron job definitions with reviewed parser/dependency decision; reject invalid/zero/unbounded schedules.
- [ ] Route every launch through ordinary loadout/admission/budgets. Defaults: no overlap, no catch-up storm, no execution after owning Pi exits.
- [ ] Define timezone/DST, long delays, missed fires, job/session/root ownership and multi-instance single-owner leases.
- [ ] Separate cancelling future schedule from interrupting active run; both are explicit controls.
- [ ] Persist jobs only under approved retention/activation policy; do not reinterpret or overwrite legacy schedules automatically.

**Exit gate:** fake-clock tests cover cancellation, overlap, restart, lease conflict, multi-instance fires, missed work and budget limits. Existing Prompt Loop scheduler remains unaffected; no separate daemon is silently introduced.

## M7 — Optional workflows and controlled delegation

**Depends on:** M2 + M4 + M5.
**Files:** `workflows.ts`, `workflows.test.ts`, declarative plan/schema contracts, journals and workflow/delegation inspector projections.

- [ ] Add versioned declarative graphs with parallel/pipeline/dependency-output steps; validate cycles, schema, roles and resource caps before running.
- [ ] Add structured result validation; provider-constrained output is conditional on native support and never replaces local validation.
- [ ] Implement pause/retry/skip/cancel with explicit outcomes, new run IDs, stale-result protection and recoverable journals.
- [ ] Verification steps request parent-owned tests/evidence or an explicitly authorized executor; no indirect shell grant to builder.
- [ ] Add separately reviewed coordinator loadouts for bounded child roles, ancestry/depth/shared budgets and workspace rules; existing specialists still cannot delegate.
- [ ] Design admission for parent-waits-child without deadlock or unbounded queue bypass, and separate thread caps from execution slots.
- [ ] Integrate Goal/Prompt Loop as callers, not another self-activating goal engine. Model-authored plans cannot increase authority/budgets.

**Exit gate:** deterministic graph/delegation tests cover cycles, deep/wide trees, deadlocks, interrupted descendants, retries, skip dependencies, schema failures, replay mismatch and restart. No arbitrary JavaScript VM/sandbox claims; no autonomous merge/push/publication.

## M8 — Full-target migration, docs and release verification

**Depends on:** implemented M0–M7; documented M5b outcome. Optional capabilities may stay disabled but must not be represented as implemented before their tests pass.
**Files:** root manifest/lock if needed, package contracts, root/component docs, `AGENTS.md`, owning `docs/setup/` guidance, procedural setup skill and role tests only for approved changes.

- [ ] Freeze tested Pi/Node floor and exact feature ledger: native, built, adapted, optional or unavailable. No blanket “Codex parity” assertion.
- [ ] Verify old/default/global role loadouts and local model pins survive audited import; preserve unknown user keys and unrelated companions.
- [ ] Rehearse fresh installation and existing-device cutover in temporary homes, including coexistence rejection and rollback.
- [ ] Update companion ownership/contracts together: first-party subagent runtime replaces Tintinweb; FFF/stats stay separate sources. Do not modify live installed source lists.
- [ ] Update bootstrap inventory, operational docs and setup skill with audit/proposal/approval/backup/drift/cutover/rollback rules; keep topic paths stable and README concise.
- [ ] Test no install-time mutation, automatic template deployment, policy companion or native MCP override.
- [ ] Record complete regression, native loader/PTY results, measured UI bounds and explicit unverified live/provider cases.
- [ ] Obtain separate approval before provider-backed smoke, local activation/config migration or removing the installed companion. Apply only approved proposals, then `/reload` or restart.

**Exit gate:** full planned capabilities have evidence and accurate limitations; cutover/rollback is safe; no user-owned state is deleted or overwritten. A release/commit/push remains a separate user instruction.

## Verification commands

Commands below are implementation targets, not claims that nonexistent tests have run. Run focused tests first; verify exact script contents before provider-backed or stateful smoke.

```bash
node --test pi/extensions/subagents/*.test.ts
node --test pi/extensions/goal-loop/*.test.ts pi/extensions/loop/*.test.ts
node --test pi/extensions/headroom/*.test.ts
npm test
PI_ROOT=/path/to/installed/@earendil-works/pi-coding-agent npm run test:themes
git diff --check
```

Add a dedicated first-party offline loader/PTY smoke command during M1/M3 using temporary Pi homes, fake providers and explicit extension paths. Existing theme smoke does not prove new agent control correctness. Minimum-version validation belongs in isolated tooling/CI; do not update the user's installed Pi to run it.

## Recommended first implementation packet

After reviewing this plan, execute M0 then M1 only:

- **Goal:** prove controlled native execution/routing and precise controls before UI/builders.
- **Allowed files:** new contract/role/backend tests and fake adapters under `pi/extensions/subagents/`; inert entrypoint only after its gate test; no root companion removal.
- **Acceptance:** one read-only fake-provider thread streams, accepts/rejects controls honestly, settles once and disposes without ambient factories/tools, network or unapproved writes. SDK/RPC choice and provider gaps documented.
- **Non-goals:** live setup activation, installed package changes, role authority expansion, worktree edits, advanced features, publication.
- **Handoff:** actual diff, focused test commands/output, native smoke evidence, backend decision and remaining unknowns.

## Planning-step evidence

- New branch checked out from `main` without resetting/stashing existing work.
- Existing untracked research document and its editor swap are preserved; no edits to that active research file.
- Only this plan and its linked design are new repository files for this step.
- Both documents parsed/rendered with the installed Markdown parser; four relative links resolve and code fences are balanced. README remains 106 lines.
- `npm run test:package && npm run test:agents`: 11 package and 13 agent tests passed. These are existing regressions, not evidence that the new runtime exists.
- Whitespace checks passed, including untracked plan/design files. Independent read-only review found no blockers and two follow-ups: explicit context-transfer delivery gates and saturation/backpressure policy. Both are incorporated into this plan and design; contract choices remain proposed, not runtime/configuration approval.
- Runtime/config/manifest/template changes, paid model smoke, commits and live migration were not performed.

## Continuation ledger — 2026-10-09

- Baseline checkout resolves Pi SDK `0.84.4` and lacks the `buildSessionProjection` export used by Kai's implementation. The existing offline smoke failed on import; this is not evidence against the audited Pi `1.1.0` SDK. Installed Pi/configuration was not changed.
- Ruling: continue the M1 routing slice in this clean feature checkout, with dependency setup and SDK execution in a disposable `/tmp` fixture. The current request authorizes repository implementation; historical planning-only language does not block it. Live activation and migration remain separate.
- Ruling: use explicit caller-reviewed OpenAI API-key auth for the routed researcher slice. Do not copy a parent credential store or accept an injected transport in Headroom mode. OAuth/custom-provider forwarding and other routed roles remain unsupported pending evidence.
- Shared-host constraint: focused serial validation only; SDK fixture install and tests use systemd process-tree limits (512 MiB RAM, no swap, 25% CPU, 32 tasks, bounded runtime). Full parallel `npm test` is deferred to CI. This takes precedence over historical broad-suite commands.
- Added real-parent-lease/isolated-child-session loopback coverage for role-pinned model, exact request auth, canonical tools/skill, parent shutdown, readiness loss and idempotent disposal. New behavior initially rejected with `unsupported_routing`; after implementation the three integration cases pass under Pi `1.1.0` in the disposable fixture.
- Focused capped regression: `backend.test.ts` 6/6; `headroom/child-routing.test.ts` 6/6; two selected native/configuration cases from `trusted.test.ts` 2/2. Each ran in its own serial process with the same 512 MiB limit; later regression heaps were reduced to 128 MiB. New integration coverage is 3/3. README remains 106 lines and whitespace checks pass.
- A combined four-file SDK batch reported 22 passing cases before systemd terminated its cgroup with `oom-kill`. That run is **failed/incomplete**, not suite acceptance. The cap was not raised. Broad regression and the remaining trusted-role cases are deferred to CI; M1 exit gates, real web-tool requests, production auth, other routed providers/roles, activation and M3 UI remain pending.
- Read-only independent review found an exported-backend disposal race: SDK idle does not cover outstanding asynchronous prompt preflight. `lifecycle.test.ts` reproduced early disposal (RED), then passed after cleanup was changed to join the whole run promise before session disposal/route release (GREEN). No review worker ran tests, SDK imports or installs. Scope exclusions remain the already documented production/provider/M1 gates, not unreviewed claims of readiness.
- Checked official Pi `v1.1.0` SDK, extension and custom-provider docs and fixture source/declarations for lifecycle/resource/provider contracts. The existing private parent-runtime lease bridge remains version-pinned and non-default; public docs do not remove that compatibility risk.
- After the review fix, fresh capped runs passed the cleanup race 1/1, routed integration 3/3 and backend lifecycle 6/6. Together with parent lease 6/6 and selected native/configuration 2/2, focused coverage is 18 distinct passing cases. Syntax/whitespace checks pass. Changes are uncommitted; no live activation, provider call, companion removal, push or release occurred. `/reload` is needed only after separately approved activation.

## Approved local-preview implementation packet

The user now requests implementation through a locally runnable extension, with live/manual provider and UI testing left to them. This authorizes an isolated preview, not migration of their installed sources/settings. Follow the existing architecture; do not wait for M6/M7 to make the preview runnable.

- [x] Integrate role-specific preparation/budgets and model assignments into the single supervisor queue; preserve its existing controls/results.
- [x] Resolve native providers/auth using the parent's public model-registry APIs, while constructing separate in-memory child runtimes with only approved factories/skills. Preserve explicit routing and exact model pins. Actual provider acceptance remains manual.
- [x] Support builder only with an owned committed-base worktree; retain artifacts and never auto-commit/remove them.
- [x] Add exclusive, opt-in preview registration with `Agent`, result/control tools and `/agents`; no default registrations or companion cutover.
- [x] Provide bounded fleet/live inspector and native dialog controls; stop/drain on session replacement/shutdown. Preview uses UI toasts only, not parent-message notifications/outboxes.
- [ ] Protocol-v2/Explore compatibility and owner-generation notification consumption remain broader milestone gates, explicitly unsupported in preview. They do not prevent direct local tool/UI testing.
- [x] Provide a user-invoked launcher creating a private temporary profile, copying package templates, and resolving existing FFF/skills. No dependency installation, global settings edits or credential copying.
- [x] Focused fake-provider integration and real extension-loader smoke in capped serial processes. Real provider/UI behavior and live activation remain manual.

Preview defaults: native routing, concurrency one on the shared host, canonical role ceilings, no child transcripts/session files, no scheduler/workflow, no automatic result persistence, and retained worktrees. Headroom routing remains a separately supported narrow backend seam rather than an automatic downgrade/ambient provider import. Resources missing from the trusted profile fail with actionable errors; no automatic skill installs. The launcher does not start a model run.

### Local-preview handoff evidence

- Added prepared role factories, public parent auth/provider delegation, scoped builder mutation tools and retained committed-base worktrees. Review found SDK path-normalization and interior-symlink escapes; execution now receives the exact validated absolute path and rejects linked ancestors/ambiguous whitespace.
- Added isolated profile launcher, four tools, fleet controls and bounded terminal inspector. Existing package resources/companions and user configuration remain unchanged. Default theme integration, protocol-v2 adapters, Explore and durable recovery are not implemented or claimed.
- Native loader test initially exposed Jiti's pi-ai subpath alias failure through the unused routed transport. Native startup now lazily excludes Headroom transport; loader plus offline real child test passes. Routed tests still pass in their direct Node fixture; this is not routed CLI-loader acceptance.
- Fresh serial capped runs: supervisor 22, budgets 10, prepared roles 2, builder 1, routed backend 3, activation 2, worktrees 2, parent provider 2, inspector 2 and preview loader/child 2. No broad suite or paid calls. Preview UI, actual FFF and actual provider auth are manual gates.
- `--prepare-only` found existing FFF and all three role skills without loading/installing them. Installed Pi 1.0.2's real loader registered exactly Agent/get_subagent_result/steer_subagent/subagent_control with zero extension errors in a 512 MiB/no-swap capped process. No model session was run by that smoke.
- Handoff: `node pi/extensions/subagents/preview.mjs --model=provider/model-id`; see component preview guide. Temporary profiles are retained deliberately; no worktree deletion or live migration occurred.
- Final read-only review confirmed the builder path/symlink fixes and auth-resolved endpoint handling; no remaining concrete blocker in those fixes. Fresh focused checks total 49 passing cases including cleanup. Installed Pi loader rechecked with the exact explicit `-e` gate. Interactive launcher also refuses startup below 2 GiB available host memory; help/syntax/whitespace/link checks pass. Full-suite/paid-provider/UI acceptance remains unclaimed.

## Full implementation handoff ledger — 2026-10-09

The user's latest instruction supersedes the partial preview packet: implement the supported runtime and optional M6/M7 capabilities, leaving real provider/terminal acceptance to the user. Earlier packet evidence is historical, not the current feature ledger.

- Ruling: execute the existing design inline on this feature checkout; preserve uncommitted work and do not commit/push or activate the device — the request is repository implementation, not live migration — cost if wrong: the user must separately approve integration/activation.
- Ruling: M6 uses bounded UTC one-shot/interval/five-field cron without a daemon; M7 uses a declarative host coordinator sharing the worker supervisor, not a slot-holding model parent or arbitrary code validators — this preserves canonical no-delegation/no-shell roles and prevents parent/child admission deadlock — cost if wrong: broader coordinator roles need a separately reviewed implementation.
- Ruling: true fork and seamless reload reattachment remain explicitly unsupported; bounded snapshots and drain/quarantine plus paused journal recovery are the supported baseline — no public native proof supports stronger semantics — cost if wrong: restart requires fresh conversations and explicit job/workflow resume.
- Ruling: retain all three companion sources in the repository manifest pending an answer to the explicit policy-conflict question — AGENTS requires three while M8 proposes removing Tintinweb — cost if wrong: native remains opt-in and global cutover cannot be represented as complete.
- Added eight native tools, protocol-v2/Explore adapters, run/generation-correlated background events and exact-run Prompt Loop tracking. Follow-up correlation regression reproduced suppressed predecessor completion (RED), then passed after per-run protocol records were separated (GREEN, 3 protocol cases).
- Native activation requires reviewed global config AND a new explicit environment gate; known companion sources reject before any tool registration. The old environment flag remains inert. Setup skill and stable topic docs describe numbered approval, backups, drift checks and rollback; no live profile/settings/source list changed.
- Outcomes/outbox and jobs/workflows are independently opt-in. Private revisioned store has exclusive ownership, preserves invalid evidence and pauses restored work without replay. Dead leases require human fingerprint review; active PID/drift reject. Live reload cleanup is bounded and unconfirmed cleanup quarantines ownership rather than freeing execution capacity.
- Workflow schema/turn reservation/retry/skip/dependency/human verification and scheduled launch/overlap/missed tick/failure behavior have focused deterministic checks. Jobs and workflows remain off unless chosen. Canonical child transcript/session persistence remains off.
- Expanded launcher reuses only a private marked profile, preserves role pins, and supports explicit persistence/schedule/workflow/Goal+Prompt Loop/theme coexistence flags. Added synthetic streaming `/agents-demo`, bounded activity details and human-owned controls without taking over the editor.
- Installed Pi 1.0.2 terminal smoke loaded native runtime, Goal Loop, Prompt Loop and canonical green theme in an empty-auth private profile with network denied. `/agents-demo` streamed 12 synthetic frames; quitting returned to the existing rounded editor; `/agents jobs` displayed. No paid/provider/FFF request ran. The 60-second scope ended cleanly and removed its owner lock. This is loader/synthetic terminal evidence, not real-provider acceptance.
- Pi 1.0.0 fixture installation was OOM-killed inside its 512 MiB/no-swap scope; no retry or increased cap. Exact development SDK is 1.1.0, lockfile updated without scripts/root install. Separate CI covers native floor on Node 22.19/24.18 and broad development regressions; it has not run here.
- One focused trusted-role run was OOM-killed. Isolated reproduction found an incorrectly shaped auth fixture that left valid auth, followed by an assertion printing the entire live SDK backend. The small assertion reproduced the actual failure; public `auth.apiKey.check/resolve` fixture correction passed. A separate fixture now explicitly requests native routing before expecting provider mismatch. These failures were contained; no blanket all-tests-pass claim is made.
- Fresh focused subagent passes before final review: activation 2, backend 7, budgets 11, builder 1, config 1, context-supervisor 4, context 5, demo 1, routed backend 3, lifecycle 3, native supervisor 9, offline guard 2, orchestration 2, ownership 1, parent provider 2, prepared 2, presentation 2, preview loader/child 2, preview launcher 1, protocol 3, roles 5, routed transport 3, scheduler 3, storage 3, supervisor 24, workflows 5 and worktrees 2. Trusted source/native role/auth groups passed separately; installed FFF remains skipped/manual. Do not sum imported duplicate tests as distinct coverage.
- Cleanup content-drift test reproduced deletion after same-status file edits (RED); content fingerprints now cover tracked/untracked/ignored changed paths and reject oversized review (GREEN, 2 worktree cases). Branch/record retained, deleted uncommitted contents irrecoverable. No real user artifact was removed.
- Exact-run inspection test reproduced a queued continuation reported as its running predecessor (RED); inspection now accepts an exact run identity, and the legacy result tool uses it. Final supervisor regression is being recorded below.
- Manual gates: actual provider/auth/model pins, installed FFF/web requests, terminal interaction/resize, paid Goal/Prompt Loop evaluation and live cutover. Experimental routed backend is pinned to 1.1.0 and is not CLI-loader acceptance. No global activation, credential copying, companion removal, commit, push or release occurred.
- Fresh final pre-review regressions: supervisor 25/25, worktrees 2/2, builder 1/1, native loader/child 2/2, trusted roles 19 passing/1 explicitly skipped FFF, Goal evaluator 5/5, Prompt Loop 25/25 and routed parent lease 6/6. These are serial focused runs, not broad CI acceptance.
- One fresh-context whole-branch read-only review inspected working/untracked changes as well as the committed base. Five Important findings were confirmed; no Critical or Minor findings. No reviewer validation/install/services or second reviewer was used.
- Final: fixed human result consumption bypassing live reservations/outbox — integrated `humanMenu` regression RED→GREEN; orchestration file 3/3. Live consumption now coordinates exact supervisor/protocol receipts with retained state; recovered-only outcomes remain consumable without live threads.
- Final: fixed historical result/consume retargeting the latest run — native loader/SDK adapter regression RED→GREEN; latest pointers update only on new-run allocation. First attempted green consumption assertion assumed a consumed closed thread remains inspectable; supervisor legitimately prunes it. Assertion now accepts pruning and separately proves capacity recovery.
- Final: fixed reverse-ordered dependency skip stall — branching reverse-order graph regression RED→GREEN; workflow file 6/6. Skip propagation reaches a fixed point before admission/terminal detection.
- Final: fixed autonomous adapter retention and absent-builder recovery block — real SDK workflow repetition displayed four nonexistent active workers (RED), now zero (GREEN); native adapter 2/2 plus retired-builder guard 1/1. Shared admission/control/event boundaries prune record/activity/receipt maps, preserving unconsumed or live threads.
- Final: fixed concurrent duplicate RPC admission — delayed preparation regression observed two admissions (RED), now one (GREEN); protocol file 4/4. Pending identities reserve synchronously, cap at 32 and release in finally.
- Final fix pass: all five complete focused files passed serially under 512 MiB/no-swap/CPU/task/runtime limits (16 cases total). No broad full-suite claim, paid requests or second review.
- Final: Ruling: preserve the authorized-operation boundaries (no live activation, installed companion removal, global role deployment, credential/config migration or publication), and leave repository companion replacement pending the explicit policy answer — these are separate approvals — cost if wrong: cutover remains incomplete, despite runnable isolated code.
- Final: Ruling: actual provider/auth/OAuth/custom-provider, FFF/web and paid Loop acceptance plus terminal resize/Unicode/IME/paste/focus remain manual gates; Pi 1.0.0/Node matrix and broad regression remain unrun CI gates — offline/static review cannot establish them — cost if wrong: an unsupported environment can still fail manual acceptance.
- Final: Ruling: keep Headroom beyond the pinned researcher experiment, true fork, persisted conversation resume, seamless reattachment and model-based nested coordinators unsupported — supported native snapshots, fresh recovery and host graphs do not grant expanded specialist authority — cost if wrong: those workflows require additional implementation, not a silent fallback.
- Final: Ruling: exclude arbitrary workflow scripts, external daemons/clients/publishing, OS sandboxing, hard billing/RSS guarantees and concurrent hostile filesystem isolation from the supported contract — mechanical capability guards are not those protections — cost if wrong: operators must supply external containment and review.
- Final: Ruling: recurring jobs pause failed admission/lease, not every failed admitted run — normal recurrence preserves its reviewed schedule and documentation now says so — cost if wrong: provider calls may continue until explicitly paused.
- Final: Ruling: unrelated historical feature-baseline changes and new validation execution were outside the final review — native implementation/adapters/docs were reviewed, validation remains independently recorded and capped — cost if wrong: that review is not acceptance of unrelated changes or unrun CI.
- Deferred minors: none identified by the final reviewer. All work remains uncommitted; preserve this ledger and private manual-test/artifact profiles.
- Post-fix neighboring regression: supervisor 25/25, scheduler 3/3, worktrees 2/2, Goal evaluator 5/5 and Prompt Loop 25/25 passed in fresh serial 512 MiB processes. Package 11/11, prompts 9/9 and templates 13/13 passed serially under 256 MiB. The initial three-file Node child-isolation invocation reported two file-level runner failures without individual diagnostics; the same hard caps with one fresh process/file and `--test-isolation=none` passed all 33. Do not treat the failed invocation as passing or infer an unrecorded OOM.
- Documentation: 10 changed/new Markdown files rendered, 49 local links resolved and eight JSON examples parsed; README 107 lines. Tracked whitespace check passed. CI/native floor and broad suite remain pending; no heavier validation fallback.
