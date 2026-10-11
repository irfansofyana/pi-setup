# Upstream feature audit

Baseline: `championswimmer/pi-subagent-manager` 0.20.0, commit
`1f037b176070b8867e00e348a08615d04d684ee8`, MIT. This audits the actual adapter,
not merely imported source. [Patch inventory](upstream/UPSTREAM.md).
Everything below remains default-inert until explicitly activated; use the
[private preview](preview.md) for manual acceptance.

## Implemented capabilities

| Upstream capability | Effective pi-setup implementation and focused evidence |
| --- | --- |
| Bundled agent types | Four defaults: researcher, scout, builder, reviewer; code-mapper aliases scout. Registry and native SDK admission tests. |
| Custom Markdown and YAML overrides | Upstream ConfigStore, user profile plus explicitly trusted project scope; invalid/symlink overrides fail closed. `registry.test.ts`. |
| Type editor and model/tool pickers | Actual upstream dialogs, ordered exact models, inherited thinking, reviewed capability picker; canonical expansion rejects before save. Explicit invocation models override preferences and still validate availability/scope. `manager-ui.test.ts`, registry/backend/preview tests. |
| Settings and modes | Actual `/agents` settings UI; Off, Opportunistic, Orchestration, effective deployment limits, model selection, widget/cost/labs options. Mode guidance is not a permission gate. UI/preview tests. |
| Definition/settings reload | New admissions see reload; retained sessions keep their admitted prompt/model/tools. Registry/manager/UI/SDK tests. |
| Import | Actual checkbox picker; explicit selection asks the parent to convert only selected definitions. Originals are untouched; not an automatic or free conversion. Private preview ignores ambient home/extra-directory environment. UI tests. |
| Named paths and independent roots | Relative root paths live under `/root`; absolute `/task` paths have no parent context. All trees share the supervisor. Manager/preview tests. |
| Nested delegation | Custom types explicitly allow scoped agent verbs. Canonical specialists cannot acquire them. Immediate-child spawn and descendant-only access; four-level ceiling. Registry/child-tools/backend tests. |
| Foreground/detached work and ancestor waits | One policy pool; waiting ancestors yield/reacquire model permits without resetting budgets. One-slot parent/child/grandchild and shutdown tests in `nested-scheduling.test.ts`. |
| Spawn, wait, status, steer, stop, output | Actual upstream root verbs through reviewed admission and exact-run continuation. Shared result reservations; no hidden second pool. Manager/root-service/preview tests. |
| Progress and pause | Child progress is context-only; pause finishes at a tool boundary without another model call or final-answer handback. Native backend/preview tests. |
| Same-session continuation | Retained in-memory backend, distinct run identity and cumulative turns/usage/deadlines; stop retains context, close releases it. Supervisor/manager/root-service tests. |
| Report-only spawn timeout | Upstream timers report status without stopping work; re-arm via steer. Upstream timeout tests and manager integration. Elapsed hard deadline is separate. |
| Root notifications and Final Recap | Hidden generation-owned coalesced delivery; busy roots defer, Off suppresses; optional recap waits for outstanding detached work, including the last descendant. `parent-delivery.test.ts` and preview integration. |
| Child notifications | Actual manager delivery into the lexical parent's retained context, without automatic child model turns; scoped child integration. |
| Tree and live transcript UI | Actual upstream navigation/controller/viewer, steering input, bounded live transcript; `/agents tree` and cooperative Ctrl+Shift+A. Presentation/root-service tests and imported live-view tests. |
| Full/minimal widget, icons and loaders | Actual upstream widgets; Ctrl+Shift+C collapse/expand; no theme editor replacement. `manager-presentation.test.ts`, UI/preview tests. |
| Costs and footer integrations | Actual CostLedger/CostFooterController. Own usage high-water records, same-session increments, duplicate/branch restoration and reap-safe totals; active continuation spend settles during navigation/shutdown. SDK preview and cost tests; status fallback preserves Signature. |
| Confirmed reaping | Actual candidate selection plus confirmation/revalidation; leaf-first reviewed close. Unconsumed outcomes stay separately retrievable. UI/manager tests. |
| Session navigation and recovery | Pre-navigation drain, fresh generation attach, quarantine on unconfirmed cleanup; optional private outcomes/outbox/jobs/workflows recovery without replay. Storage/orchestration/preview tests. |

## Setup differences and conflicts

- The four reviewed roles replace upstream's six default presets. Custom types
  remain available; role/tool policies cannot expand through an override.
- Automatic conversation inheritance and true native fork are off/unsupported.
  Use self-contained task packets or root `subagent_start` with an identified,
  bounded, coherent snapshot filtered against destination tools. Researcher and
  Explore reject local snapshots. Plain text is not a secret detector.
- Ambient parent extension/MCP/shell tools and upstream `all`/
  `all-except-blocked` filtering are unsupported. Allowed tools are the reviewed
  local read/search, web, worktree write/edit and explicitly selected custom
  delegation capabilities. This is not an OS sandbox.
- Child conversation files/transcripts do not persist. Restart/reload cannot
  resume those conversations or reattach live workers. Optional `--persist`
  retains bounded outcomes, notification evidence and paused automation journals;
  recovered notifications require human review and never trigger replay/wakes.
- The theme owns the sole editor and footer. Browser/collapse use Ctrl+Shift+A/C
  instead of intercepting draft arrows. Event-mode costs fall back to a status
  key, not upstream's combined-cost footer replacement. RPC uses native dialogs
  and text widgets; the fullscreen tree/live viewer requires a terminal.
- The import flow is explicit, not automatic first-run onboarding; it needs
  Opportunistic mode for the parent's filesystem tools and may incur model cost.
  Importing legacy roles does not authorize changing their resource boundaries.
- Scheduled/workflow-reserved tasks cannot delegate descendants: their reserved
  graph budgets do not account for descendant budgets. Use non-delegating types
  in those graphs and a manually invoked custom coordinator for nested work.
- Existing companion sources/global templates/configuration are not removed or
  migrated. `pi/agents/` is legacy companion compatibility, not native deployment.
  Live cutover still needs separate approval under the setup procedure.

## Setup additions

- Headroom preferred per request, visible direct-provider fallback, fresh parent
  auth/OAuth forwarding; submitted failures are never replayed automatically.
- Explicit owned-file worktrees and retained-artifact review/recovery for writes.
- Exact-run controls, compatibility tools/protocol-v2, Goal/Prompt Loop adapters,
  dedicated hard-two Explore evaluator, optional finite jobs/declarative graphs.
- Explicit bounded turn grants: at most two per thread lifetime, each no larger
  than its initial soft allowance. No deadline/usage reset or exhausted-session
  revival; evaluators and reserved automation cannot extend caller-owned budgets.

## Verification boundary

Focused offline tests run serially against exact Pi 1.1.0 with 512 MiB hard memory,
zero swap, 25% CPU, 32 tasks and bounded runtime. Fake providers make no paid model
or web calls. Host checks precede validation; dependency installs/full npm tests
are not run on this shared VM. On 2026-10-10, the final post-review focused gate
passed 67/67 (delivery, registry, actual SDK preview, supervisor, manager/driver,
root controls, budgets and nested/scoped scheduling). Separate UI/model-picker/
cost checks passed 31/31 and package contracts passed 11/11. The fresh review's
three Important findings were reproduced and fixed: nested recap release, active
continuation costs during navigation, and explicit model override precedence.
These offline gates are not current manual acceptance or a full-suite pass.

Pending: real TUI resizing/keyboard/fonts/theme coexistence; actual OAuth/provider,
Headroom and installed FFF/web behavior; broad CI and Node/Pi floor matrix. Follow
[manual acceptance](preview.md#manual-acceptance-pending). No global activation,
companion removal, configuration migration, commit or push was performed.
