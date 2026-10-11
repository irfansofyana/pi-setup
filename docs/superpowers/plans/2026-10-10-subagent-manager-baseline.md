# Subagent manager baseline implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; one fresh review at the end.

**Goal:** Replace the independently built public thread layer with a pinned, attributed upstream baseline adapted to this setup.

**Architecture:** Upstream ThreadManager owns public paths/lifecycle/control. A narrow driver delegates execution to the existing shared supervisor and controlled native SDK backends. Tools, compatibility and UI all target the same thread manager; no second execution pool.

**Tech Stack:** TypeScript, public Pi SDK, Node built-ins and three pinned inherited viewer libraries.

**Spec:** [baseline design](../specs/2026-10-10-subagent-manager-baseline-design.md).

## Global constraints

- No live activation/config/credential/companion changes or paid calls.
- Four canonical fresh, bounded roles; builder worktrees; no child delegation/shell.
- Preview concurrency one; serial hard-capped validation, no full local suite.
- Headroom best-effort with warning and exact upstream auth; no request replay.
- Preserve upstream MIT notice and exact provenance; keep default entrypoint inert.

## Review focus

- Driver startup cancellation and async disposal must not leak sessions/worktrees.
- Reused thread paths/results must not retarget another run or reset lifetime budgets.
- UI/protocol adapters must share ownership, never launch hidden duplicate workers.
- Auth refresh and Headroom availability changes must not lose headers or replay work.
- Upstream defaults/settings must not widen specialist tools/context/persistence.

### Task 1: Pin and import upstream core

- [x] Copy relevant runtime-neutral source and its focused tests, preserving MIT.
- [x] Run manager/path/transcript tests serially in hard-capped processes.
- [x] Record import inventory and intentionally omitted upstream subsystems.

### Task 2: Adapt execution and activation

- [x] Write failing driver/activation tests for fresh context, role/model/files,
      budgets, steer/resume/stop, cancellation and disposal.
- [x] Implement the single-supervisor driver and shared root-scoped tool/UI boundary.
- [x] Preserve explicit compatibility or reject unsupported advanced feature flags.
- [x] Verify real SDK loader and an offline child without model/provider network.

### Task 3: Best-effort Headroom/auth

- [x] Write failing route/auth/availability/no-replay/warning tests.
- [x] Publish parent route metadata through public-registry identity; implement
      per-request direct/proxy dispatch preserving fresh auth/headers.
- [x] Verify all launch paths share that provider and isolate preview Headroom paths.

### Task 4: Handoff

- [x] Update owning setup/component/manual-test docs and superseded milestone notes.
- [x] Run focused serial regression and package/documentation checks under hard caps.
- [x] Fresh read-only review; fix important findings with focused tests.
- [x] Report exact evidence and remaining manual/CI gates. Do not commit/push unless asked.

## Ledger

- Baseline downloaded read-only to /tmp; no installs or live changes. Worktree was
  clean at `bf0ec49` on `feat/first-party-subagents` before this adaptation.
- Ruling: reuse supervised SDK execution beneath upstream ThreadManager — preserves
  tested role/budget/worktree policy without importing broad upstream runtime
  defaults; cost if wrong: the adapter needs correction, not live data migration.
- Ruling: user-delegated adaptation decisions replace intermediate approval hops;
  irreversible/live operations remain separately gated.
- Baseline import: 84 files (30 source, 45 tests, 6 agent definitions, license,
  README and metadata), each verified against the pinned checkout with only one
  added final newline. `upstream/UPSTREAM.md` records provenance and non-activation.
- Focused upstream checks: paths 2/2, manager 21/21, transcript 6/6. Every check
  was serial under 256 MiB/no swap/25% CPU/16 tasks/60 seconds. The initial manager
  invocation exposed Node strip-only syntax; rerun used type transformation, with
  no package installation. These are upstream checks, not full fork acceptance.
- Adapter checks: 3/3 in exact-Pi 1.1.0 disposable fixture, under 512 MiB/no swap/
  25% CPU/32 tasks/60 seconds. Tests exposed and fixed fast-completion event loss
  before allocation returned, plus old interrupt disposal breaking upstream
  stopped-thread resume. Lifetime budgets survive follow-up; one SDK session is
  retained in memory. Production entrypoint is not switched yet.
- Existing supervisor/budget regression: 36/36 under the same serial SDK limits.
  Owner-only `suspend` retains context for the upstream adapter; existing public
  interrupt/close, deadline/budget exhaustion and shutdown keep their cleanup policy.
- Additional upstream startup, report-only timeout and cost-ledger checks: 12/12
  in one serial capped offline process. Current focused total: 41 upstream,
  3 adapter and 36 existing regression checks. No full-suite claim.
- Initial adapter invocation against root dependencies was invalid because that
  installed SDK predates `buildSessionProjection`; switched to the already-existing
  exact-Pi fixture, not another SDK install. No broad suite, real provider call,
  dependency install, live mutation, commit or push occurred.
- Next: wire the upstream tools/tree/live view through a single adapted runtime,
  canonical resource preparer and activation gate; then implement best-effort
  Headroom/auth and exercise real loader/compatibility paths. Copied broad upstream
  agents/runtime remain inactive evidence, not approved effective loadouts.
- Task 2: integrated upstream manager/tools/tree/live viewer through the existing
  exclusive/default-inert gate and canonical preparer. Seven upstream root verbs
  plus eight compatibility tools use one supervisor. Queued continuations retain
  exact outcomes, stopped threads retain one session and lifetime budget.
- Ruling: retain upstream's three pinned viewer dependencies instead of rewriting
  its UI — smallest faithful baseline; cost if wrong: remove/replace inherited
  viewer imports. Dependencies installed only in the disposable SDK fixture;
  repository lockfile-only refresh preserved existing checkout dependencies.
- Corrected upstream version from provisional 0.19.0 to 0.20.0 by reading
  package.json at the exact pinned commit; commit/source content never changed.
- Focused evidence: adapter/service 7/7; effective thinking regression RED→GREEN;
  inherited status/live UI 40/40; actual Pi loader + offline child and protocol/
  orchestration 9/9. SDK checks remain serial, 512 MiB/no swap/25% CPU/32 tasks/
  60 seconds. No broad suite, paid provider call or live-profile mutation.
- Task 3: public registry-identity parent Headroom metadata; exact upstream fallback
  warning, per-request auth/headers, bounded readiness and no replay. New routing
  checks 3/3 plus original provider 2/2 and real-loader/offline child 2/2 passed;
  parent metadata/config/private-launcher checks 3/3 passed. Real OAuth/provider/
  Headroom transport remains manual acceptance, not inferred from fake-auth tests.
- Fresh final read-only review: no Critical, four Important, one Minor. One fix
  pass addressed all Important findings; no second review or parallel coding workers.
  RED regressions established hung-manager shutdown, accepted continuation hidden
  by a failed predecessor, and real SDK automatic retry replay. The new root-scope
  regression initially lacked its adapter, then verified real persistence failure,
  retained-result backpressure and exact new-run protocol/recovery metadata.
- Important fixes: manager/raw shutdown start together with a bounded join and
  quarantine; tree and tool continuations share orchestration admission/protocol;
  the driver drains already accepted queued runs even after failure; both child
  SDK constructors disable agent/provider automatic retries. Parent settings stay
  unchanged. Explicit later continuation remains new work.
- Focused fix regression: manager service 9/9, root scope 3/3, preferred routing
  4/4 (including a real Pi 1.1.0 child with a failed fake proxy). Adjacent driver/
  provider/loader/protocol/orchestration 14/14. Backend/canonical-role regression:
  19 passed, one actual-FFF test skipped because no isolated FFF path was supplied.
  All serial under 512 MiB/no swap/25% CPU/32 tasks/60 seconds. The deliberately
  hung shutdown RED was stopped by its 10-second scope limit, never run unbounded.
- Ruling on review's declined-to-judge areas: real OAuth/provider/Headroom transport,
  terminal resize/paste/focus/theme coexistence and installed FFF/web behavior stay
  manual gates; offline tests cannot establish those claims. Broad regression and
  advertised SDK-floor matrix stay on CI, not this shared VM. Cost if wrong: defer
  live cutover and correct compatibility before activation, not weaken containment.
- Ruling: retained builder worktrees are intentional recovery evidence; inactive
  upstream presets/discovery/persistence/editor remain attributed source only.
  Closed-path reuse/lifetime-budget concern had no established defect; exact-run
  identity and budget tests remain the acceptance evidence, not a new reset feature.
- Deferred Minor: default upstream tree does not open in RPC. Documented
  `/agents fleet` as the supported RPC path; terminal-tree behavior is unchanged.
  Cost if wrong: later RPC UX adaptation, without widening execution authority.
- No live activation, credential/config/theme/companion migration, commit or push.
  Workspace dependencies remain stale/untouched; manual launcher docs include a
  separately hard-capped workspace install prerequisite. Private preview is the
  supported handoff, not a claim of successful live provider acceptance.
- Final tool-level regression: real registered `agent_steer` resumes a named
  thread, and actual SDK dispatch carries `maxRetries: 0`; routing/loader 6/6.
  Package/prompt contracts 20/20. An initial tiny contract scope failed before
  executing cases with child-process isolation; the single-process rerun passed
  without raising its 256 MiB/no-swap/25% CPU/16-task/30-second limits.
- Real launcher containment smoke passed using `/usr/bin/true`, not Pi: actual
  systemd scope accepted its hard memory/no-swap/CPU/tasks/runtime properties.
  Retained empty private profile `/tmp/pi-subagents-preview-zU4HP7`; no login,
  model, file tools, proxy or service was started. This is launch plumbing evidence,
  not live provider or FFF acceptance.
