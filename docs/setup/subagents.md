# Subagent Team

Package-owned native subagents load by default. `/agents` opens settings; no global
template deployment, enable flag or config file is required. Bundled definitions
live in [`pi/extensions/subagents/agents/`](../../pi/extensions/subagents/agents/).
The retired `pi/agents/` directory is no longer shipped.

## Team

| Role | Job | Authority |
| --- | --- | --- |
| `researcher` | Public-web research and primary-source verification | `web_search`/`web_fetch` plus bundled `my-web-search`; no local file tools |
| `scout` | Repository discovery, execution traces and change surface | Read/search only; no shell or network |
| `builder` | Scoped implementation and test authoring | Local read/edit/write in an owned Git worktree; no shell or network |
| `reviewer` | Independent correctness, security and lifecycle review | Read/search only; no mutation, shell or network |

`code-mapper` aliases `scout`. Legacy Ciung/Laya/Sangkur/Prabu display names are not
native definitions. Main agent coordinates, runs verification and owns integration.
Built-ins use fresh context, bounded turns and no output transcripts. Tool
allowlists and worktrees are not an OS sandbox or secret detector.

## Commands and definitions

- `/agents` — settings.
- `/agents types` — inspect/edit bundled roles, user overrides and custom types.
- `/agents tree` — optional advanced terminal live viewer.
- `/agents fleet` — exact-run controls, including RPC-compatible dialogs.
- `/agents import` — select legacy definitions for model-assisted conversion;
  originals remain unchanged. Import is not automatic or model-free.
- `/agents reload` — reload definitions; `/reload` reloads package extensions.
- `/agents reap` — confirmed cleanup of completed threads.

User-owned Markdown definitions and sparse YAML overrides belong to
`~/.pi/agent/subagent-manager/agents/`. Trusted project overrides belong to
`.pi/agent/subagent-manager/agents/`. Never grant project trust just to load agents.
Custom types cannot widen canonical tool boundaries. Writable types require
worktree isolation; only custom types can request scoped delegation tools.

Use exact `provider/model-id` values. Explicit invocation model wins over type
preferences, then parent model. Example global override `scout.yml`:

```yaml
models: [provider/model-id]
thinkingLevel: high
```

Use `/agents types` for validated editing. Model scopes are guardrails, not a
security boundary. Unavailable models, invalid definitions and missing explicit custom requirements
fail closed. Bundled local roles fall back to built-in read/search tools when
optional parent search tools are absent. See [feature audit](../../pi/extensions/subagents/parity.md) for differences
from upstream behavior.

## Inline navigation

Main displays a compact Claude-style task list with state, usage, elapsed time
and current activity. Rows keep their order as workers finish.

In the integrated theme, **←** or **↓** from an empty focused prompt enters task
selection. **↑/↓** chooses; **Enter** opens the live detail panel. Fullscreen
mouse users can click a task. **`/agents tasks`** opens the panel with any theme.

The panel shows wrapped messages, tool activity, model and metrics. **Enter** or
**Tab** opens its dedicated steering composer; **Enter** sends through the exact-run
root service. **Esc** leaves the composer, then closes the panel. Main keeps its
own prompt. **←/→** switches tasks while browsing or with an empty draft;
**↑/↓**, **PgUp/PgDn** scroll history, and **End** follows live output.

Agent drafts survive closing/switching; rejection retains the message. Existing
lifetime budgets apply. Commands typed in the steering composer are agent text.
Normal editing, autocomplete, dialogs and registered shortcuts keep their keys;
release events never navigate twice. Navigation does not stop or forget workers.
Use `/agents fleet` for additional controls and confirmed `/agents reap` for cleanup.
See [inline controls and limits](../../pi/extensions/subagents/README.md#inline-navigation).

<a id="install-the-trusted-templates"></a>

## Native runtime cutover

Native runtime adapts `championswimmer/pi-subagent-manager` 0.20.0, pinned commit
`1f037b1` (MIT). Without configuration, in-memory defaults are 3 executing
task, 4 threads, 8 result slots and 4 pending. Persistence, schedules and workflows
stay off. No config is generated during package loading.

Optional global `~/.pi/agent/subagents-native.json` overrides runtime defaults.
Existing valid config is honored; malformed config fails closed. Concurrency counts
executing children; thread capacity and nesting are separate. `/agents` can lower
admission limits but cannot exceed the deployment ceiling. To review a higher
ceiling, use global caps such as `concurrency: 6`, `threads: 8`, `slots: 16`,
`pending: 8`; check host/provider capacity first. No local config is rewritten.
Example:

```json
{
  "version": 1,
  "enabled": true,
  "routing": "headroom-preferred",
  "concurrency": 3,
  "threads": 4,
  "slots": 8,
  "pending": 4,
  "persist": false,
  "schedules": false,
  "workflows": false,
  "fffPath": "/absolute/approved/pi-fff/src/index.ts",
  "skillPaths": {
    "mermaid": "/absolute/approved/mermaid/SKILL.md",
    "teach": "/absolute/approved/teach/SKILL.md",
    "code-review": "/absolute/approved/code-review/SKILL.md"
  }
}
```

Bundled local roles require no FFF package or external skills. They use built-in
`read`/`grep`/`find`/`ls`, plus compatible role-approved parent FFF tools when
available. Worktree children use their own built-ins, not the parent's search index.
The example's `fffPath`/`skillPaths` are explicit custom-resource options; omit them
for bundled roles. Missing explicit custom requirements block only affected launches.

Bundled child sessions do not load third-party packages, external skills or ambient
extension hooks. Optional tool metadata/initialization failures fall back to built-ins
before any model request; failed optional tool calls return a tool error with a
fallback hint. Known startup error codes are preserved without raw provider errors.
This does not protect against an extension crashing, hanging or corrupting the shared
Pi process. Command registration alone is not provider or terminal acceptance. Provider credentials remain in `/login`, environment
or provider profiles. Research needs configured Web Research credentials.

`headroom-preferred` borrows the parent's healthy compatible route, otherwise warns
and uses the exact upstream provider. Submitted failures are never replayed.
Explicit `native` routing bypasses Headroom. Child retries are disabled.

Opt out with `PI_SETUP_SUBAGENTS_NATIVE=0` or global config:

```json
{"version": 1, "enabled": false}
```

Project files cannot enable native features. Known configured Tintinweb sources
suppress default native registration; explicit `PI_SETUP_SUBAGENTS_NATIVE=1`
rejects conflicts instead. Tintinweb is no longer a required companion. Arbitrary
renamed loaders are not detectable by this gate; inspect effective resource identity.

For existing devices, present separately numbered proposals:

1. Verify package resources, `/agents`, native roles and approved dependencies.
   Test native roles with focused, resource-capped checks; no preview launcher is shipped.
2. Audit legacy package sources, manual loaders, `~/.pi/agent/agents/*.md` and
   `~/.pi/agent/subagents.json`. Identify custom files/model pins before cleanup.
3. Privately back up exact approved targets outside the repository, with directory
   mode `0700` and file mode `0600`. Re-read and stop on drift.
4. Remove only approved legacy sources/files. Preserve custom definitions, unknown
   config, logs, archives, memory, credentials, unrelated MCP and selected theme.
   Use `/agents import` only when selected custom definitions need conversion.
5. Run `/reload` or restart; verify `/agents`, one tool owner and native role behavior.
   Retain backups until migration is accepted.

No automatic cleanup, template copying or legacy-settings translation occurs.
Legacy `Explore.md` is user-owned; the native hard-two `Explore` evaluator is
separate and does not activate that file. Keep custom legacy files until separately
reviewed for import or deletion.

Rollback: drain native work, opt out if restoring a legacy runtime, and restore
only approved backed-up files/sources when targets have not drifted. Never overwrite
newer state. Restart and verify restored runtime. Theme changes and unrelated
web-skill/MCP/route cleanup require separate approval.

## Self-contained task packets

```text
Goal:
Decision this result informs:
Acceptance criteria:
Relevant scope:
Known constraints:
Invariants:
Evidence already collected:
Explicit non-goals:
Required deliverable:
Effort/turn budget:
```

Use sanitized public questions/URLs for researcher. Give scout focused entry points
and questions, not a whole-repository scan. Give builder explicit worktree file
scopes and acceptance criteria. Give reviewer actual diff, affected-file context,
acceptance criteria and exact command output; reviewer cannot execute verification.

Example builder request through the compatibility `Agent` tool:

```javascript
Agent({
  subagent_type: "builder",
  description: "Implement one reviewed behavior change",
  prompt: "Implement only the supplied acceptance criteria; report tests not run.",
  files: ["src/feature.ts", "tests/feature.test.ts"],
  run_in_background: true
});
```

Exact thread/run identifiers prevent stale controls. Message delivery is context,
not proof of model consumption. Waiter cancellation does not stop workers.
Follow-up/resume admits a distinct run; native fork and persisted conversation
resume are unsupported. Steered, aborted, stopped or incomplete work is not complete.

## Parent-owned completion gates

1. Inspect outputs against acceptance criteria and evidence, not agent confidence.
2. Review builder's owned worktree/branch and actual diff before integration.
3. Parent runs focused behavior tests and relevant regression, retaining exact
   command output. Builder/reviewer cannot claim command execution.
4. Send at most two focused repair rounds with exact failures and unchanged scope.
5. Keep unverified work incomplete; do not push, merge, deploy or publish implicitly.

Reload/session replacement drains workers. Unconfirmed cleanup quarantines runtime;
retained worktree evidence is preserved. Use exact-run controls before artifact
cleanup. See [component limits](../../pi/extensions/subagents/README.md) and
[shared-host validation](operations.md#repository-validation-on-shared-hosts).

## Verification

After `/reload`, check `/agents types` lists the four native roles. Verify one subagent tool
owner, then run a scoped scout task using built-ins; optional FFF is not a launch
requirement. Separately test available parent search tools and their failure fallback.
Command registration alone does not prove provider or terminal acceptance.

## Role evaluation

[`evaluation-scorecard.json`](../../pi/extensions/subagents/evaluation-scorecard.json)
freezes eight synthetic/public cases, two per native role. Score correctness,
evidence, scope discipline, tool efficiency and actionability from 0–2; retain
specific deductions and change one prompt/model variable per run. No new runtime
or private transcript collection is required.

Focused portable contract check:

```bash
node --test --test-concurrency=1 pi/extensions/subagents/agents.test.ts
```

SDK/provider/UI acceptance remains separate from static role contracts. Use hard
process limits for SDK checks; defer under host pressure and report gaps.

## Trust boundaries

Extensions run with Pi's OS permissions. Never invoke untrusted project roles,
extensions or skills. Native project discovery requires explicit project trust;
legacy clients may discover `.pi/agents/` or `.agents/agents/` differently.

Built-ins remain fresh-context. Explicit bounded snapshots are loadout-filtered;
researcher and `Explore` reject local inheritance. Parent/provider/tool logs and
retained results may still contain private data even when child transcripts are
disabled. Do not send secrets or proprietary identifiers to web tools.

Run `/reload` after package/config changes; restart after environment changes.
