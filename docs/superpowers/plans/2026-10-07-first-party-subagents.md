# First-party subagents: implementation plan

**Status:** reviewed planning draft; contract freeze and implementation pending; tasks unchecked.
**Branch:** `feat/first-party-subagents`.
**Design:** [full capability and interface contract](../specs/2026-10-07-first-party-subagents-design.md).
**Research:** [source-backed due diligence](../../setup/subagents-extension-research.md).

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
