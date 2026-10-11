# Upstream subagent feature integration

## Authority and outcome

The user requests all upstream benefits, including UI, with four bundled defaults:
`researcher`, `scout`, `builder`, and `reviewer`. The user delegates adaptation
choices and asks for conflicts to be reported at the implementation handoff.
Continue inline as previously delegated; do not stop for repeated design approvals.
This extends, rather than narrows, the baseline adaptation. No live activation,
global migration, companion removal, commit, push or paid provider calls are implied.

## Approach

Reuse the pinned upstream 0.20.0 source, not a parallel imitation. Directly loading
its entire entrypoint would discard existing isolation, routing and lifecycle
guarantees. Extending only the fixed four-role wrapper would leave custom types and
UI unusable. Instead compose upstream registry, settings, UI, lifecycle and cost
components with the existing supervised SDK adapter and a single execution pool.

## Registry and defaults

Bundle four upstream-format Markdown definitions under the extension's `agents/`.
Keep `code-mapper` as a `scout` invocation alias, not a fifth default. Preserve the
four reviewed tool boundaries, fresh contexts, bounded turns and worktree builder.
Custom types and settings-only YAML overrides use upstream's user directory:
`<agent-dir>/subagent-manager/agents/`. Project definitions require explicit project
trust and must never load from an untrusted repository. Legacy global templates
are not removed or rewritten. Deprecate their first-party deployment path only
after bundled equivalents work; preserve compatibility sources where necessary.

Definitions are immutable snapshots for retained threads. Reload affects new
threads only. Invalid definitions, unknown tools/models, symlinks and definition
drift must fail rather than expose a broader lower-precedence policy. Custom types
can use reviewed tool capabilities without source edits; their existence does not
grant arbitrary extension factories or unrestricted shell authority.

## UI and settings

Expose upstream settings, type browser/editor, model and tool pickers, reload,
tree/live viewer, import and confirmed reaping. Settings must describe effective
policy, not offer successful-looking settings that the runtime silently ignores.
Preserve exact-run fleet/result/artifact controls. Reuse upstream widget styles,
icons/loaders and cost components. Preserve the theme's sole editor ownership:
keyboard navigation may integrate cooperatively but must not replace its editor.
User-invoked edits save only to the selected trusted profile/project scope.

## Runtime capabilities

Integrate child progress and pause checkpoints, permitted nested delegation and
independent roots through the same shared bounded supervisor. Ancestor waiting
must not deadlock the execution pool. Context/tool inheritance is explicit and
loadout-filtered; defaults stay fresh. Retained same-process continuations preserve
usage accounting. Improve budget visibility and allow explicit bounded turn
extensions without resetting cumulative usage or deadlines.

Restore conversation persistence only where it can preserve approved transcript
policy; do not disguise saved outcomes as recovered sessions. Automatic wake-ups
and optional final recap must be generation-correlated and suppressed in Off mode.
Keep restart/reload handling, settled cost rollups and bulk cleanup idempotent.
If a feature cannot honor the setup's constraints, document its exact unsupported
portion and a usable alternative instead of silently weakening those constraints.

## Routing and host safety

Keep Headroom preferred with visible direct-provider fallback warnings, fresh
parent auth/OAuth resolution, and no replay of submitted/streaming failures.
No second execution pool, ambient extension factories, global auth-store copies,
postinstall mutation or unrestricted subprocess/test authority. Preview remains
private, one executing child, hard-capped and separate from normal activation.

## Verification and completion

Maintain a feature-by-feature ledger covering registry/customization; bundled
roles; settings/types/model/tool UI; reload/import/reap; nested/independent trees;
progress/pause; context/tools; continuation/budgets; restart recovery; parent wake
and recap; widgets/editor compatibility; cost; compatibility protocols; Headroom.
Each feature needs implementation evidence plus focused behavior tests, or an
explicit concrete setup conflict. Source presence or upstream-only tests do not
prove adapter integration. Real TUI/auth/provider acceptance remains a documented
manual gate. Check memory, validate serially under hard memory/no-swap/CPU/task/time
limits, and defer broad regression to CI. Keep the full goal active until the
implementation and feature audit are complete.
