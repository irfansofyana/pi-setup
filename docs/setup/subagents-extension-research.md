# First-party subagents: due diligence

Research for replacing `@tintinweb/pi-subagents` with a package-owned extension. This document records evidence and design options; it does **not** authorize implementation, package removal, or live configuration changes.

## Research contract

- Decision: whether and how to own subagent execution, visibility, and control inside `pi-setup`.
- User priorities: see what agents are doing, steer them, understand Codex's actual features, avoid dependence on Tintinweb's companion.
- Additional explicit requirement: investigate what Pi coding-agent itself makes possible.
- Independent lanes: installed Tintinweb implementation; current package/native Pi architecture; official Codex documentation/source.
- Evidence: local versioned source and official public sources. Separate implementation facts, documentation claims, reported issues, and proposed design.
- Exclusions: no installs, live setting changes, package replacement, paid model experiments, or implementation.
- Snapshot: local research clock `2026-10-07T15:32:38Z`. Public documentation may describe a different version or moving branch.

## Verified local snapshot

| Item | Observed value | Evidence |
| --- | --- | --- |
| First-party package | `@irfansofyana/pi-setup` `0.6.0` | [root manifest](../../package.json) |
| Companion minimum | `npm:@tintinweb/pi-subagents@0.14.3` | `piSetup.requiredPackages` in root manifest |
| Installed companion | `@tintinweb/pi-subagents` `0.14.3` | Installed package's `package.json`, read without modification |
| Installed Pi | `1.0.4` | Installed Pi package's `package.json` |
| Repository Pi floor | `>=1.0.0` | Root `engines.pi` |
| Active global roles | `researcher`, `code-mapper`, `builder`, `reviewer` | Global templates byte-match repository templates |
| Project subagent config | No `.pi/subagents.json` | Read-only existence check |

The active global `~/.pi/agent/subagents.json` matches the supplied defaults: `maxConcurrent: 3`, `defaultMaxTurns: 40`, `graceTurns: 5`, `defaultJoinMode: "smart"`, `scopeModels: true`, `toolDescriptionMode: "compact"`, `fleetView: true`, `widgetMode: "background"`, `outputTranscript: false`. Only those named keys were inspected; credentials/auth files were not read.

Baseline verification, before any runtime change:

```bash
npm run test:agents && npm run test:package
```

Result: **13/13 agent-template tests and 11/11 package-contract tests passed**. Existing UI baseline also passed **22/22 Signature/theme tests** and native theme smoke against installed Pi `1.0.4`:

```bash
npm run test:signature
PI_ROOT=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent npm run test:themes
```

The theme smoke loads real Pi extension/TUI code with controlled fixture events; it is not a live subagent model run. These checks verify current contracts and UI compatibility, not a future extension or Codex feature parity.

## Current package fit

- `pi-setup` already owns the four reviewed specialist templates; Tintinweb owns their discovery/execution runtime and management UI.
- The coordinator supplies fresh, self-contained task packets. All canonical roles set `inherit_context: false`, bounded turns, and disabled output transcripts.
- Ciung performs public research; Laya maps local code; Sangkur edits an isolated Git worktree; Prabu independently reviews. The parent executes tests and owns integration/publication gates.
- Global template deployment remains approval-gated. Pi's package manifest declares extensions, themes, skills, and prompts—not native agent resources. Shipping templates under `pi/agents/` does not deploy them automatically.
- Current role tools are intentionally narrower than generic Pi agents. Preserve FFF search, native Web Research, Headroom provider routing, no nested-agent tools, and role-specific mutation restrictions.
- Existing documentation already describes FleetView, live viewers, and steering through Tintinweb. Ownership and clearer control UX are distinct goals from adding those basic capabilities.

Owning sources: [Subagent team](subagents.md), [agent packaging research](agent-packaging-research.md), [canonical templates](../../pi/agents), [setup procedure](../../skills/pi-setup/SKILL.md).

### Existing UI constraints

The `pi-irfan-devs` theme owns Pi's one custom-editor slot and preserves last-loaded-wins conflicts. A first-party subagent UI should not replace that editor. Prefer an independently owned widget and an explicit viewer/control surface.

The welcome panel is decoration: it yields to unknown custom dock components and protects editor/footer/transcript space. A fleet widget may therefore suppress the idle welcome artwork; preserving task visibility takes priority over preserving decoration.

Input routing must respect current focus, autocomplete, questionnaire dialogs, Unicode/IME, paste, and terminal size. Tintinweb's changelog documents a concrete historical failure where fleet navigation consumed keys intended for other dialogs; this is an integration test requirement, not merely a visual polish issue.

Sources: [theme component README](../../pi/themes/pi-irfan-devs/README.md), [theme entrypoint](../../pi/themes/pi-irfan-devs/index.ts), [welcome presentation](../../pi/themes/pi-irfan-devs/watermark-ui.ts), [Structured Questions component](../../pi/extensions/ask-user-question/README.md), upstream changelog [U2].

## Installed Tintinweb audit

Installed `0.14.3` is an **in-process Pi SDK supervisor**, not a child-process sandbox. It creates separate `AgentSession` conversations/resources and optionally creates Git worktrees. Entry code owns tools, UI, notifications, scheduler, and cross-extension RPC. Runtime dependencies: `@sinclair/typebox`, `croner`, `nanoid`; MIT licence. Installed source, not upstream `master`, supports the findings below.

### Feature inventory

| Area | Installed behavior | Important qualification |
| --- | --- | --- |
| Execution | Foreground blocking/streamed results; background IDs and completion messages | Foreground bypasses background concurrency pool; scheduled jobs explicitly bypass queue |
| Tools | `Agent`, `get_subagent_result`, `steer_subagent` | No model-callable stop tool; human viewer and event RPC can stop |
| Roles | Built-ins plus global/project Markdown definitions; tool/extension/skill/model/turn settings | Unknown role falls back to general-purpose; project definitions shadow global definitions |
| Context | Fresh task or serialized parent conversation; append/replace system prompt | Serialization is not a true session-tree fork; omits tool results/arguments/images/thinking; no explicit size bound |
| Models | Role pin, caller override, or parent; fuzzy resolution; optional scope check | Scope is a guardrail, not a hard policy boundary; failed role-pin resolution can inherit parent |
| Concurrency | FIFO background queue; configurable background limit | No universal depth/cost/token/wall-time budget; no single cap covering all spawn paths |
| Turn budgets | Soft limit requests wrap-up; hard abort after grace turns | Unlimited by default upstream; repository roles/defaults impose bounds |
| Widget | Task/role, active tools, turns, tokens, context fill, compactions, elapsed time | Live text/tool activity, not a complete tool-progress stream; scheduled/RPC paths have weaker activity tracking |
| Fleet | Below-editor roster; empty focused editor arrows select, Enter opens viewer | Queued/uninitialized agents without a session are not fully represented; focus handling depends on private TUI state |
| Viewer | Live subscription, scroll/auto-follow, Enter steering composer, `x` then `x` stop | Tool/bash output capped at 500 characters; tool arguments, images, and thinking omitted; compaction removes older detail |
| Steering | Calls native `session.steer()`; initialization-time messages buffered | Acceptance is not delivery acknowledgement; UI path swallows asynchronous steering errors |
| Waiting | Optional blocking result retrieval; consumption suppresses pending completion notice | Cancelling a wait does not stop background work |
| Resume | Continues an existing in-memory session/model/tools/context | Records expire roughly 10–11 minutes after completion; no ID reconstruction from disk; lifecycle differs from normal spawn |
| Worktrees | Detached checkout of repository HEAD; preserve changes on local branch; remove directory | Parent uncommitted changes absent; cleanup auto-stages/commits, including partial stopped work; no auto-merge/push |
| Scheduling | Cron/interval/one-shot jobs, persisted store, menu controls | Separate execution/storage/concurrency behavior; unnecessary for basic visibility/steering |
| Storage | Optional Pi sessions, output JSONL, parent result entries, role memory, jobs, Git output | Disabling output transcripts does not disable all disk writes |
| Integration | `subagents:rpc:ping/spawn/stop`, protocol 2; lifecycle events; global manager registry | Same-process extension messaging, not native Pi process RPC |
| Network | No dedicated telemetry uploader found in inspected package source | Providers, loaded extensions/MCP, and bash may still access network |

Installed-source references are relative to `<installed @tintinweb/pi-subagents>`: `src/index.ts:909–974,1441–1573`; `src/agent-manager.ts:145–632`; `src/agent-runner.ts:500–1015`; `src/context.ts:20–57`; `src/ui/fleet-list.ts:107–280`; `src/ui/conversation-viewer.ts:284–355`; `src/schedule.ts:48–365`; `src/output-file.ts:19–117`.

### Controls already available today

With a running agent and an empty focused parent editor:

1. Press `↓` or `←` to enter FleetView.
2. Select an agent, then Enter to inspect its live conversation.
3. Enter again opens a steering composer; type and submit.
4. `x`, then `x` stops the selected active agent. Esc/`q` closes the viewer without stopping it.

These installed-source controls provide a useful UX benchmark. No setup change is required merely to try them; the local fleet setting is already enabled. Do not launch paid-model work solely for this audit.

### Static risk findings—not reproduced exploit/bug claims

Parent inspection verified the first two source paths and native steering semantics. Other findings come from the independent source audit; none was exercised with a live model.

- **Work preservation:** `src/worktree.ts:106–180` catches preservation failures, attempts force-removal, and returns `hasChanges: false`. A failed commit/branch operation could lose unpreserved work. A replacement must retain a failed worktree and surface recovery details, not silently discard it.
- **Resume lifecycle:** `src/agent-manager.ts:445–484` does not recreate the normal run promise/abort controller/queue accounting/worktree/turn limiter/completion callback. Resume should be a new run on a stable agent identity, with fresh lifecycle bookkeeping.
- **Disabled/unknown roles:** resolution and validity checks differ; disabled configurations may remain callable with broadened built-ins. Unknown roles should fail closed in the proposed runtime.
- **Initialization cancellation:** abort listeners are attached after asynchronous setup without consistently checking an already-aborted signal.
- **Scheduled execution:** bypasses ordinary background queue and some frontmatter/model-scope/activity/transcript paths.
- **Resource loading:** filtering extensions after factories load does not prevent their code from executing.
- **Cleanup/notifications:** shutdown does not dispose every widget/grouping timer; terminal notification ownership and consumption need explicit tests.

No reason to copy these behaviors merely to preserve compatibility. Tool schemas/event envelopes can be preserved while unsafe or misleading internals change.

## Codex feature audit

The useful inspiration is **supervised child threads with explicit lifecycle controls**, not “every child gets a worktree” or one universal Codex API.

### Surfaces and UX

| Surface | Confirmed evidence | Boundary |
| --- | --- | --- |
| CLI/TUI | `/agent` switches active agent thread for inspection; parent can be asked to steer/stop/close children [C1] | Thread switching, not proof of tiled simultaneous transcripts |
| Desktop | Background-agent panel exposes status, stopping active children, opening child threads [C1] | Availability and exact UI depend on surface/version |
| Independent worktree chats | Managed Git worktrees isolate checkout files [C4] | Subagent thread is not automatically a worktree chat |
| IDE | Agent/thread activity plus separate queued-follow-up and active-steering behavior [C1,C5] | IDE settings are not automatically CLI/app defaults |
| Cloud/web | Hosted task/subagent UX is separately documented [C1,C6] | Do not assume local controls, configuration, sandbox modes, or SDK parity |
| TypeScript SDK | Programmatic Codex thread automation [C7] | Not the OpenAI Agents SDK; not proof of the same complete child-control interface |
| App-server | Client protocol exposes thread/turn status, item events, active-turn steering and interruption [C3] | Protocol methods are distinct from model-callable agent tools |

### Model-facing control contracts

Pinned source evidence: `rust-v0.158.0`, release dated `2026-09-28`; current docs are unversioned. Presence in tagged source does not prove every model/account exposes the same tool family [C2,C8].

| Family | Source-defined controls | Meaning |
| --- | --- | --- |
| V1 | `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent` | `send_input(interrupt: false)` queues; `interrupt: true` interrupts current task; closed agents may be resumed |
| V2 | `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `interrupt_agent` | Message delivery can avoid starting work; follow-up starts an idle child or reaches a running child at boundaries; interrupt leaves agent available |
| App-server | `turn/steer`, `turn/interrupt`, thread read/list/resume methods | Steering appends input to an active turn, requires matching `expectedTurnId`, and does not change model/cwd/sandbox settings |

Important differences [C1–C3]:

- Agent identity, conversation thread, and execution turn are distinct.
- Queue, steer, interrupt, and close are not synonyms.
- V1 task-only context is the default unless explicitly forked; V2 source defaults `fork_turns` to `all`. Copy no context default without a product decision.
- Child configuration and runtime permissions are separate: children inherit parent sandbox/live permission overrides; a custom role is not an independent permission authority.
- Child completion can notify the parent without polling; OS notifications are a separate feature.
- Custom roles/model/reasoning/concurrency are configurable. Exact numeric default concurrency, maximum nesting, minimum version of every UI control, cloud parity, and full cross-restart child lifecycle were not established.

## Native Pi feasibility

**Yes: native Pi `1.0.4` provides the execution/control primitives needed for a first-party extension.** Pi does not provide a turnkey fleet/role/worktree supervisor. Tintinweb implements that product layer above Pi.

### Execution backends

| Backend | Native primitives | Fit |
| --- | --- | --- |
| SDK, in process | `createAgentSession`, `subscribe`, `prompt`, `steer`, `followUp`, `clearQueue`, `abort`, `waitForIdle`, explicit resource/settings/session/model runtime | Smallest direct integration; preserves shared Headroom routing; shared process/globals/failure domain |
| RPC child process | Exported `RpcClient`, long-lived JSONL commands/events, steering/follow-up/queue clearing/abort, state/history/model/session controls | Viable live-control process boundary; more supervision, protocol, resource and provider-routing work |
| CLI JSON child process | Streamed one-shot execution events and process termination | Useful batch backend; cannot accept later live steering commands without a persistent control transport |

### Feasibility matrix

| Desired feature | Pi support | Extension work |
| --- | --- | --- |
| Live text/tool activity | Native session events | Aggregate, bound buffers, render, redact where appropriate |
| Status and completion | Native run/retry/queue/settled events | State machine and run correlation |
| Steer running child | Native `session.steer()` or RPC steer | Target selection, acknowledgement, delivery history, error handling |
| Queue follow-up | Native `session.followUp()` or RPC follow-up | Explicit UX; distinguish from steering |
| Stop child | Native queue clearing/abort; process control for RPC | Stop state, races, incomplete result, timeout/escalation policy |
| Resume conversation | Native session storage/opening and new prompts | Stable identity plus new run; retention and restore policy |
| Different models/thinking | Native session configuration | Role precedence, availability/scope errors, show effective assignment |
| Role tool restrictions | Explicit tools and resource loaders | Existing `ext:owner/tool` parser or approved migration; no ambient imports |
| Fresh/forked context | In-memory/persistent/forkable session managers | Deliberate inheritance policy; preserve current fresh-context defaults |
| Fleet/transcript/control UI | Widgets, dialogs, custom components, renderers | Entire UX; focus/resize/input conflict handling |
| Worktrees | Not supplied by session creation | Git orchestration, preservation, cleanup, branch handoff |
| Scheduling/workflow DSL | Not supplied by ordinary session creation | Optional separate product scope; not needed for MVP |
| Parent notification | Custom messages/session entries/events | Exactly-once delivery, preview/result consumption, avoid notification storms |
| Usage/cost visibility | Native message usage/tool-result usage | Aggregate accurately; label estimates; avoid double-counting |

### Native behavior that changes design

- **Steering does not cancel tools.** Native SDK documentation says: “A steering message enters after the current assistant turn and its tool calls.” On inspected Pi source, a parallel tool batch finishes before queued steering reaches the next model step. Tintinweb's “after current tool” wording is too narrow.
- **Use `agent_settled`, not only `agent_end`, for terminal completion.** Recovery/retries/compaction/queued work can follow an `agent_end`.
- **Hard stop must clear queued continuation.** RPC `clear_queue` before `abort`; equivalent SDK queue handling. Aborting active work alone can allow queued messages to restart it.
- **Session defaults are not privacy-neutral.** Native SDK defaults to persistent sessions, file-backed settings, default discovery and configured tools. Explicit `SessionManager.inMemory()`, `SettingsManager.inMemory()`, and a controlled loader are available.
- **Filter before loading.** `DefaultResourceLoader.extensionsOverride` runs after factory execution. A custom `ResourceLoader` can eliminate ambient discovery entirely.
- **`--tools` alone is insufficient.** Native MCP/deferred/codemode tools must be omitted or restricted explicitly. SDK sessions do not add CLI built-in MCP/codemode/tool-search unless requested.
- **Parent provider reuse is not a free public API.** Installed `ModelRegistry` declares its `runtime` field private. Tintinweb reads it through a compatibility cast before passing `modelRuntime` to `createAgentSession` (`src/agent-runner.ts:785–804`). A new extension must explicitly choose a controlled compatibility bridge or public construction of a child `ModelRuntime` with verified Headroom/provider setup. Shared routing is a feasibility-spike requirement, not an assumed finished capability.
- **Shutdown is a lifecycle protocol.** `session.dispose()` does not itself emit extension shutdown; runtime disposal does. Shared Headroom leases and listeners must release correctly.
- **UI modes differ.** `ctx.ui.custom()` is a TUI facility. RPC forwards native dialogs/status/string widgets, not arbitrary custom components; `ctx.hasUI` alone is not enough.
- **Persistence is branch-sensitive.** Rebuild extension state from the active session branch, not all abandoned history entries. `appendEntry` stores state without necessarily adding model context.

Native evidence: installed Pi `1.0.4` `docs/sdk.md` (read completely), `docs/cli-integration.md`, `docs/rpc-commands.md:97–128`, `docs/rpc-extension-ui.md:5–25`, `docs/tui.md`, `docs/extensions.md:224–235`; `examples/sdk/12-full-control.ts:35–61`; `dist/core/resource-loader.js:405–419,524–563`; `dist/core/agent-session.js:988–1007`; `dist/core/agent-session-runtime.js:296–302`.

### Native subagent example is not a drop-in replacement

Pi ships `examples/extensions/subagent`: lowercase `subagent`, single/parallel/chain calls, concurrency 4, max parallel tasks 8, streamed CLI JSON children, abort propagation. Its parser only covers name/description/tools/model; current repository templates lack required `name`. It does not implement current extension selectors, preloaded skills, turn limits, context flags, worktrees, retention defaults, or live-control transport. Child arguments also do not comprehensively disable ambient extensions/MCP.

Use it as a reference, not as evidence that copying one example replaces the current team safely.

## Replacement integration contract

Removing the companion from the manifest alone would break package behavior.

| Consumer | Current dependency | Replacement obligation |
| --- | --- | --- |
| Goal Loop | `subagents:rpc:ping` protocol >=2; spawn `Explore` with fresh context, two-turn cap; correlated completed/failed events | Compatibility adapter or coordinated evaluator migration; preserve timeout/stale-result/error handling |
| Prompt Loop | `subagents:created/completed/failed`; background ID correlation and wakeup buffering | Preserve event envelopes or update loop/tests together |
| Existing skills/prompts/coordinator | `Agent`, result retrieval, steering contracts | Keep names/schema where useful; avoid loading two conflicting runtimes |
| Canonical roles | Frontmatter tool/extension/skill/model/context/worktree/retention fields | Preserve effective loadouts, not merely parse Markdown |
| Headroom | Shared process `ModelRuntime` provider-routing leases | Reuse correctly with SDK; reconstruct explicit routing in process backend |
| Setup/package contracts | Three separate companions; procedural approvals/backups | Update manifest, owning docs, setup skill, tests only after design approval |

Sources: [Goal evaluator](../../pi/extensions/goal-loop/evaluator.ts), [Prompt Loop](../../pi/extensions/loop/index.ts), [Headroom](../../pi/extensions/headroom/index.ts), [package tests](../../tests/package-contract.test.mjs), [role tests](../../pi/agents/agent-templates.test.ts).

Migration must preserve unknown user keys, installed model pins, existing global roles, sessions/results/logs, unrelated companions, MCP, credentials, and selected theme. No automatic package removal, transcript cleanup, global template deployment, or postinstall mutation.

## Upstream freshness and counter-evidence

Fetched upstream `master/package.json` reports `0.19.0`, MIT license, Pi peers `>=0.84.0`, and dependencies `@sinclair/typebox`, `typebox`, `croner`, and `nanoid` [U1]. This is a **moving repository snapshot**, not proof that the installed package changed or an independently checked npm dist-tag.

Important post-`0.14.3` changes in the fetched changelog [U2]:

| Version | Documented change | Relevance |
| --- | --- | --- |
| `0.17.0` | `@handle` addressing; `name:` becomes dispatch identity; `rememberAgents` persists top-level sessions by default; worktree opt-out | Changes invocation and privacy defaults; `outputTranscript: false` is not a substitute for reviewing session persistence |
| `0.18.0` | Top-level agents default to background; optional usage accounting and cost display; child shutdown disposal fixes | Background/foreground semantics and parent totals are version-sensitive |
| `0.18.1` | Cross-extension result-consumption acknowledgement; actual effective model display | Avoid duplicate result notifications and misleading model labels |
| `0.18.2` | Separate opt-in foreground concurrency limit; model-scope check on cross-extension spawn | A single background limit is not a universal execution cap |
| `0.19.0` | `SubagentWorkflow`, parallel/pipeline orchestration, structured outputs, verification gates, script/journal replay, pause/skip/retry inspector; asynchronous worktree Git operations | Much broader than a supervised subagent console; new lifecycle and execution responsibilities |

The `0.19.0` changelog warns that its enabled workflow tool adds roughly **5,000 system-prompt tokens**, and describes its JavaScript VM as a determinism/accident boundary, not a defence against hostile scripts. Its workflow token-budget compatibility object is not an enforced token target (`total: null`, `remaining(): Infinity`). These are reasons not to copy the whole orchestration surface by default.

These are **upstream documented changes**, not locally executed tests. Do not attribute current upstream features to installed `0.14.3`, and do not upgrade without separately reviewing changed defaults.

The fetched changelog identifies `0.19.0` dated `2026-08-25` and `0.14.3` dated `2026-07-23` [U2]. An alternate Exa extraction returned a much older changelog headed `0.10.0`; that stale body is excluded from newer-version conclusions.

Two fetched issues qualify the upgrade/ownership discussion:

- **Issue #294:** reporter on Pi `0.85.0` / companion `0.19.0` describes running workflows being aborted on `/reload`, and requests reattachment plus easier inspector access [U3]. This is a user report about workflows, not reproduction against local Pi `1.0.4` or proof that every subagent fails across reload.
- **Issue #276:** reporter on Pi `0.84.4` / companion `0.19.0` describes `/agents` failing with `Cannot read properties of undefined (reading 'fgColors')`; fetched labels include `cant-reproduce` [U4]. Treat as an unresolved compatibility report, not an established defect in this installation.

Owning runtime increases control but also transfers responsibility for Pi compatibility, event lifecycle, UI focus, resource disposal, and tests. Dependency removal alone is not evidence of better reliability.

## Design options and brainstorming

**Recommendation for discussion:** build a focused, package-owned supervised task console on native Pi. Start with an SDK feasibility spike because its session/control integration is smallest; make clean Headroom/provider setup the first gate. Keep a narrow backend seam so RPC remains possible if process separation or public-API-only integration wins. No architecture or feature list is approved yet.

| Strategy | Gains | Costs / fit |
| --- | --- | --- |
| Keep/configure Tintinweb | Fastest way to test whether fleet/steering UX meets the actual need | Useful benchmark, but does not meet the explicit dependency-removal goal |
| Vendor a reviewed MIT fork | First-party source ownership; fastest route to existing behavior | Own all inherited complexity and compatibility debt; preserve licence notices; not a clean redesign |
| Build a focused native-Pi extension | Purpose-built role/runtime/control surface; no Tintinweb runtime dependency | Reimplement lifecycle, worktrees, tests, and migration; avoid claiming parity beyond tested features |
| Build a Pi RPC child-process controller | Explicit IPC and child-process lifecycle; clean headless control boundary | More process/transport/resource-loader work; still not an OS sandbox; UI remains package-owned |

SDK versus RPC is an implementation choice **within** a first-party extension, not a requirement to build a separate CLI or web application. The public feature set can stay stable behind either backend. Validate one backend end-to-end before supporting both.

Suggested module boundaries:

1. **Backend:** session creation, approved resource loadout, event stream, controls, disposal. No UI or orchestration policy.
2. **Supervisor:** role registry, agent/run identities, queue/budgets, result ownership, worktree lifecycle, retention.
3. **Presentation:** fleet widget, inspector, explicit targeted controls; preserve the existing editor.
4. **Compatibility adapter:** current tools and event RPC for Goal/Prompt Loop; versioned contract tests.

Prototype one read-only agent through the complete lifecycle before parallel builders. Proposed slices: offline supervisor tests → live read-only viewer/control smoke → worktree-preservation and bounded resume → compatibility/migration rehearsal. Live provider smoke and local activation require separate approval.

### Candidate first milestone

Preserve existing role authority. Improve visibility and control before adding orchestration features:

- Fleet rows: role, task, lifecycle state, model, elapsed time, current tool, and last meaningful activity.
- Inspect: streamed assistant output, tool activity, final result, and worktree/branch references. Only show information the provider/runtime actually emits; do not promise access to hidden reasoning.
- Human controls: separately labelled **Steer**, **Follow up**, **Stop**, and **Resume**. Show target agent and delivery acknowledgement; never silently route normal parent-editor input to a selected child.
- Coordinator controls: preserve current `Agent`, `get_subagent_result`, and `steer_subagent` contracts where useful. Add explicit lifecycle controls only after deciding compatibility requirements.
- Bounded execution: concurrency and nesting limits, turn budget, abort propagation, reliable failure reporting, and exactly-once completion delivery per run.
- Privacy: ephemeral live buffers by default, persisted metadata/results or transcripts only under an explicit retention policy. Normal Pi session history/provider logs remain a separate concern.
- Existing builder boundary: worktree edits only; parent runs tests and owns review/integration/publication. A future shell/test-enabled builder requires a separate authority decision.

Exclude scheduling, JavaScript workflow DSLs, automatic planning hierarchies, cross-device management, and provider routing duplication from the first milestone unless the user identifies a concrete need.

### Non-negotiable acceptance tests

| Area | Required evidence before migration |
| --- | --- |
| Lifecycle | Queued/running/completed/failed/cancelled states; child errors; parent abort; no false completion from partial results |
| Steering | During model streaming and tool execution; message ordering; acknowledgement; unsupported/completed target behavior; steer/stop race |
| Follow-up and resume | Follow-up waits for turn completion; resume retains intended child context; new run remains distinguishable from previous completed run |
| Concurrency | Queue fairness, cancellation while queued, hard depth/concurrency bounds, simultaneous completion |
| Delivery | Exactly-once parent notification; no duplicate after result inspection; waiting cancellation does not accidentally stop background work |
| Session lifecycle | Explicit policy and tests for `/reload`, session switch, `/new`, quit, and process restart; no unnoticed orphaned work |
| Resources | Role-specific tools and extension load allowlist; unknown tool/model errors; no accidental local skills/extensions from untrusted repositories |
| Worktrees | Branch/diff handoff, failure cleanup, dirty files, symlinks, no unapproved merge/push/delete; retained output remains inspectable |
| UI integration | Existing theme editor, questionnaire dialogs, autocomplete, focus, Unicode/IME/paste, narrow terminals, resize, full/regular terminal modes |
| Retention | Bounded live buffers; no secret collection; private file modes where persisted; transcript-disable behavior documented accurately |
| Modes | Clear non-TUI/RPC behavior; no control sequences or unframed logs corrupting RPC stdout |
| Regression | Existing role/package contracts plus offline fake-session tests and real Pi loader/PTY smoke; live-model smoke only after explicit approval |

## Evidence limits

- Local audit is static plus existing contract tests; no paid-model behavioral experiment or full interactive fleet smoke was performed.
- Runtime settings and installed global-role equality were checked read-only; no settings or user-owned files were changed.
- Public branch versions and issue reports are not interchangeable with tagged releases or independently reproduced behavior.
- No permission prompts, tool filters, worktrees, or process boundaries should be described as a sandbox.

## Public sources

Codex primary sources fetched by the research lane; key role/steering/tool contracts independently re-fetched by the parent. Initial parent Tavily app-server extraction failed; subsequent Exa extraction succeeded. Release freshness remains explicitly qualified above.

- **[C1]** [Official subagent configuration/UX](https://developers.openai.com/codex/agent-configuration/subagents.md) — current unversioned documentation.
- **[C2]** [Pinned Codex multi-agent tool specifications](https://raw.githubusercontent.com/openai/codex/rust-v0.158.0/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) — V1/V2 contracts at `0.158.0`.
- **[C3]** [Codex app-server](https://developers.openai.com/codex/app-server) — thread/turn protocol, not model-facing tools.
- **[C4]** [Codex Git worktrees](https://developers.openai.com/codex/environments/git-worktrees.md) — independent checkout/chat lifecycle.
- **[C5]** [Codex IDE/developer settings](https://developers.openai.com/codex/developer-settings.md) — queue versus steer settings.
- **[C6]** [Codex cloud](https://developers.openai.com/codex/cloud.md) — hosted task surface.
- **[C7]** [Codex SDK](https://developers.openai.com/codex/sdk.md) — programmatic thread automation.
- **[C8]** [Codex `0.158.0` release](https://github.com/openai/codex/releases/tag/rust-v0.158.0) — pinned release evidence, not an independently established newest stable version.
- **[U0]** [Tintinweb repository / README](https://github.com/tintinweb/pi-subagents) — fetched primary documentation; moving branch.
- **[U1]** [Tintinweb master package manifest](https://github.com/tintinweb/pi-subagents/blob/master/package.json) — fetched body reports `0.19.0`.
- **[U2]** [Tintinweb changelog](https://github.com/tintinweb/pi-subagents/blob/master/CHANGELOG.md) — fetched version history; includes fleet focus fix.
- **[U3]** [Reload/workflow inspector report #294](https://github.com/tintinweb/pi-subagents/issues/294) — fetched reporter's description.
- **[U4]** [Theme compatibility report #276](https://github.com/tintinweb/pi-subagents/issues/276) — fetched reporter's description and qualifying labels.
