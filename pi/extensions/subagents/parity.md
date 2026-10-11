# Upstream feature audit

Baseline: `championswimmer/pi-subagent-manager` 0.20.0, commit
`1f037b176070b8867e00e348a08615d04d684ee8`, MIT. This audits the actual adapter,
not merely imported source. [Patch inventory](upstream/UPSTREAM.md).
Native runtime now loads by default unless opted out or a legacy companion is configured; use the
resource-capped native runtime for manual acceptance.

## Implemented capabilities

| Upstream capability | Effective pi-setup implementation and focused evidence |
| --- | --- |
| Bundled agent types | Four defaults: researcher, scout, builder, reviewer; code-mapper aliases scout. Registry and native SDK admission tests. |
| Custom Markdown and YAML overrides | Upstream ConfigStore, user profile plus explicitly trusted project scope; invalid/symlink overrides fail closed. `registry.test.ts`. |
| Type editor and model/tool pickers | Actual upstream dialogs, ordered exact models, inherited thinking, reviewed capability picker; canonical expansion rejects before save. Explicit invocation models override preferences and still validate availability/scope. `manager-ui.test.ts`, registry/backend/runtime tests. |
| Settings and modes | Actual `/agents` settings UI; Off, Opportunistic, Orchestration, effective deployment limits, model selection, widget/cost/labs options. Mode guidance is not a permission gate. UI/runtime tests. |
| Definition/settings reload | New admissions see reload; retained sessions keep their admitted prompt/model/tools. Registry/manager/UI/SDK tests. |
| Import | Actual checkbox picker; explicit selection asks the parent to convert only selected definitions. Originals are untouched; not an automatic or free conversion. UI tests. |
| Named paths and independent roots | Relative root paths live under `/root`; absolute `/task` paths have no parent context. All trees share the supervisor. Manager/runtime tests. |
| Nested delegation | Custom types explicitly allow scoped agent verbs. Canonical specialists cannot acquire them. Immediate-child spawn and descendant-only access; four-level ceiling. Registry/child-tools/backend tests. |
| Foreground/detached work and ancestor waits | One policy pool; waiting ancestors yield/reacquire model permits without resetting budgets. One-slot parent/child/grandchild and shutdown tests in `nested-scheduling.test.ts`. |
| Spawn, wait, status, steer, stop, output | Actual upstream root verbs through reviewed admission and exact-run continuation. Shared result reservations; no hidden second pool. Manager/root-service/runtime tests. |
| Progress and pause | Child progress is context-only; pause finishes at a tool boundary without another model call or final-answer handback. Native backend/runtime tests. |
| Same-session continuation | Retained in-memory backend, distinct run identity and cumulative turns/usage/deadlines; stop retains context, close releases it. Supervisor/manager/root-service tests. |
| Report-only spawn timeout | Upstream timers report status without stopping work; re-arm via steer. Upstream timeout tests and manager integration. Elapsed hard deadline is separate. |
| Root notifications and Final Recap | Hidden generation-owned coalesced delivery; busy roots defer, Off suppresses; optional recap waits for outstanding detached work, including the last descendant. `parent-delivery.test.ts` and runtime integration. |
| Child notifications | Actual manager delivery into the lexical parent's retained context, without automatic child model turns; scoped child integration. |
| Task navigation and advanced live tree | Empty integrated-theme composer ←/↓ focuses a stable task list; Enter opens a dedicated conversation/steering overlay. `/agents tasks` works with other themes. Exact-run root steering remains shared. `/agents tree` opens the upstream viewer. Controller, presentation, task-panel and root-service tests cover these boundaries. |
| Full/minimal presentation, icons and loaders | Compact role-colored task dock with short names, state, unread counts and separate activity rows; usage lives in details. Full/Minimal sets dock height. Identity-bound keyboard/mouse selection; release filtering, clamped arrows, retained drafts and per-agent anchored message scrolling. Public Text leaf preserves Signature budgeting. Interactive acceptance remains separate. |
| Human steering and follow-up | Explicit modes capture task lifetime/thread/run through the reviewed root boundary. Receipts remain queued/accepted/handled/applied/rejected/unknown; uncertain delivery retains the draft and requires explicit retry acknowledgement. Session-owned reading state and bounded unread hashes clear on reload. Control, root-service, manager-service, view-state and task-panel cases authored; execution pending. |
| Costs and footer integrations | Actual CostLedger/CostFooterController. Own usage high-water records, same-session increments, duplicate/branch restoration and reap-safe totals; active continuation spend settles during navigation/shutdown. SDK preview and cost tests; status fallback preserves Signature. |
| Confirmed reaping | Actual candidate selection plus confirmation/revalidation; leaf-first reviewed close. Unconsumed outcomes stay separately retrievable. UI/manager tests. |
| Session navigation and recovery | Pre-navigation drain, fresh generation attach, quarantine on unconfirmed cleanup; optional private outcomes/outbox/jobs/workflows recovery without replay. Storage/orchestration/runtime tests. |

## Setup differences and conflicts

- The four reviewed roles replace upstream's six default presets. Custom types
  remain available; role/tool policies cannot expand through an override.
- Automatic conversation inheritance and true native fork are off/unsupported.
  Use self-contained task packets or root `subagent_start` with an identified,
  bounded, coherent snapshot filtered against destination tools. Researcher and
  Explore reject local snapshots. Plain text is not a secret detector.
- Ambient parent extensions, MCP and shell tools are not loaded into child runtimes.
  Bundled local roles optionally reuse approved parent FFF tools through execution
  hooks; missing/broken optional search falls back to built-ins. Parent search indexes
  are not shared with worktree children. External skills are not bundled-role requirements.
  Explicit custom requirements stay strict; this does not isolate process crashes.
  Tool authority remains reviewed read/search, explicit worktree writes and scoped
  child controls, not upstream's broad tool-filtering modes.
- Child conversation files/transcripts do not persist. Restart/reload cannot
  resume those conversations or reattach live workers. Optional `--persist`
  retains bounded outcomes, notification evidence and paused automation journals;
  recovered notifications require human review and never trigger replay/wakes.
- The theme owns the root editor and footer. Explicit root identity and disposable
  input hooks provide task selection after extension shortcuts. The detail overlay
  owns its steering editor; Main's submission callback and draft stay intact.
  Nonempty arrows, dialogs and autocomplete keep their editing behavior.
  Plain-text projection excludes tool/thinking/provider-error fields,
  not every private value or raw live snapshot. Event-mode costs fall back to a
  status key. RPC uses native dialogs/text widgets; advanced tree/viewer is terminal-only.
- The import flow is explicit, not automatic first-run onboarding; it needs
  Opportunistic mode for the parent's filesystem tools and may incur model cost.
  Importing legacy roles does not authorize changing their resource boundaries.
- Scheduled/workflow-reserved tasks cannot delegate descendants: their reserved
  graph budgets do not account for descendant budgets. Use non-delegating types
  in those graphs and a manually invoked custom coordinator for nested work.
- Existing companion sources/global templates/configuration are not removed or
  migrated. legacy deployment templates are retired; native defaults need no manual copying.
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

Phase 2 follow-up (2026-10-12): implemented per-agent reading state and unread
indicators, explicit steer/follow-up modes, receipt-preserving controls with stale
run rejection and uncertain-delivery retry handling, short labels and simplified
dock details. The completion summary uses “N subagents completed.” Added tests
for queued human follow-up through orchestration, serialized run fences, reading
state, late observer cleanup and UI delivery recovery. **Runtime tests, typecheck
and interactive acceptance remain unexecuted** under the same host constraints
below. The bounded compatibility job includes the new focused cases.

Phase 1 follow-up (2026-10-11): added idle completion collapse, expanded-list
stability, final grace-clock redraw, informational reporting reminders, panel/dock
failure containment and remapped composer-submit coverage. Tests were authored
before the corresponding implementation but **have not been executed locally**
under the same host constraints below. A new serial CI compatibility job runs
the real component/import tests on Pi 1.0.0, 1.0.4 and 1.1.0 inside a container
with 2 GiB hard memory, no swap, 2 CPUs, 128 PIDs and an eight-minute command limit.
That job has not been run as part of this change. Manual terminal acceptance is
still required; these additions are not a claim that the old or new UI suite passed.

Claude-style task-panel refactor (2026-10-11): regression tests added for task
selection, Kitty releases/repeats, root ownership/shortcut precedence, dedicated
steering, rejected drafts, transcript following and tiny viewports. **These tests
have not been executed**: the available macOS host was under memory pressure and
had no running container runtime for the required hard resource limits. Static
review is not SDK/TUI acceptance. The earlier inline fleet's 52-test result does
not validate this replacement.

The reported panel-opening crash exposed an invalid `wordWrapLine` import. The
transcript now uses public `wrapTextWithAnsi`, retaining source-offset scroll
anchors and clipping oversized graphemes. Static export checks found all 11
task-UI runtime imports in both installed Pi 1.0.4 and development Pi 1.1.0.
Opening-before-observation, whitespace anchors and Unicode regression cases
were added; they remain unexecuted under the same host constraints above.

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

The task-panel fixtures use a public Pi editor with controlled services, without
SDK sessions or provider calls. Run focused files serially in a contained runner:
`fleet-view.test.ts`, `inline-navigation.test.ts`, `task-transcript.test.ts`,
`task-panel.test.ts`, `manager-presentation.test.ts` and the theme's
`root-editor.test.ts`. Actual SDK/TUI acceptance and the minimum-Pi matrix remain
separate checks.

Pending: real TUI resizing/keyboard/fonts/theme coexistence; actual OAuth/provider,
Headroom and installed FFF/web behavior; broad CI and Node/Pi floor matrix. Follow
resource-capped manual acceptance. No global activation,
companion removal or configuration migration is implied by these checks.
