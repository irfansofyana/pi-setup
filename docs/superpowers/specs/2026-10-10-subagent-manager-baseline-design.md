# Subagent manager baseline

## Direction and authority

The user explicitly delegates the baseline/adaptation decisions and asks to copy
relevant code from championswimmer/pi-subagent-manager rather than continue an
independent implementation. This supersedes the earlier runtime choice, not the
repository's role, live-migration or shared-host safety boundaries. Execute the
adaptation inline without further design-approval round trips. No push, publication,
live configuration change or paid provider call is implied.

## Baseline

Pin upstream 0.20.0, commit `1f037b176070b8867e00e348a08615d04d684ee8`.
Preserve MIT copyright/license and record copied files plus local differences.
Reuse the runtime-neutral ThreadManager, path/ownership/lifecycle controls,
model-facing verbs, transcript observation and tree projection. These form the
public thread baseline. Retain our existing supervised SDK execution as a policy
adapter, not another public agent system or additional execution pool.

Do not activate upstream's unrestricted default agents, project discovery, automatic
imports, persisted child sessions, auth-store access or custom-editor replacement.
Those conflict with this package's approved setup. The adapter resolves the four
trusted canonical roles and the dedicated read-only Explore evaluator. Children
get no delegation tools, no automatic parent history, no transcripts on disk and
no ambient extension/MCP discovery. Builder still requires explicit files and an
owned Git worktree. Missing resources/models reject instead of broadening roles.

The new baseline exposes upstream agent_* tools and /agents through the existing
default-inert package entrypoint. Keep old source/history recoverable, but never
register two /agents owners. Provide the existing Agent/get_subagent_result/steer
and protocol-v2 compatibility at the boundary where feasible; unsupported old
advanced modes must be explicitly rejected rather than silently ignored.

## Routing

Headroom is best-effort, as explicitly corrected by the user. Prefer the parent's
active, healthy route; if unavailable, resolve the exact upstream provider using
parent auth/OAuth and warn visibly. Resolve auth for every request, without copying
the credential store. Never replay an already submitted or streaming request to
another endpoint. Do not confuse provider failure with permission to change model.
Children add no Headroom tools and do not start or own a proxy themselves.

## Safety and acceptance

Concurrency remains one in preview, with finite threads/pending/results and role
turn/time/observed-usage budgets. The retained private preview profile remains the
manual-test path; no live source/companion/theme/credentials migration. Keep all
three companion requirements unchanged. Validate offline using existing exact-Pi
fixtures, one process at a time with RAM/no-swap/CPU/task/time limits. Broad tests
and real model/OAuth acceptance remain CI/manual gates, not a shared-VM full suite.
