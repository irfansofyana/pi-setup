# Cross-Client Goal Driver Review

## Objective

Compare the current Pi goal-loop implementation with Codex Goal mode and Claude
Code `/goal`, then define how the Pi implementation can become the durable goal
engine used from Pi, Codex, and Claude.

## Implementation status

The native-parity slice proposed by this review is now implemented on
`feat/goal-loop-p0-hardening`: native clear aliases and status details, durable
follow-up steering, coordinator-owned `subagents:rpc:spawn` evaluation for every
valid settled run, evaluator-authoritative settlement, bounded transcript context,
and stale-result protection. The provider-neutral cross-client service described
below remains a later architectural direction. Comparison references to the
"current Pi" implementation describe the baseline reviewed before these changes.

## Executive conclusion

The Pi implementation is already the strongest of the three as a **coordinator**:
it has durable state, append-only audit logs, leases, optimistic concurrency,
bounded execution, explicit verification evidence, completion receipts, and
fail-closed settlement. Codex and Claude currently provide better **product
integration**: their goal belongs to the active chat or session, steering feels
native, evaluation is automatically invoked by the host, and status is surfaced
without requiring a model-authored protocol record.

Do not try to make the existing Pi extension file a universal extension. Extract
its state machine into a provider-neutral local service, then keep Pi, Codex, and
Claude as thin adapters. The shared service should own goal state and settlement;
each client must continue to own tool execution, permissions, and its conversation.

Neither Codex nor Claude documents a supported way for third-party plugins to
replace the built-in `/goal` command. The first cross-client release should use an
explicit command or skill such as `/pi-goal` and shared MCP tools. Native `/goal`
bridging should only be added if a documented command interception API appears.

## Evidence reviewed

- Current Pi implementation: `pi/extensions/goal-loop/index.ts`, `state.ts`,
  `storage.ts`, `evaluation.ts`, tests, and extension README on
  `feat/goal-loop-p0-hardening`.
- Codex: [Long-running work](https://learn.chatgpt.com/docs/long-running-work),
  [Goal-mode prompting](https://learn.chatgpt.com/docs/prompting#goal-mode), and
  [Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees).
- Claude Code: [Keep Claude working toward a goal](https://code.claude.com/docs/en/goal)
  and [Hooks reference](https://code.claude.com/docs/en/hooks).

External product behavior was checked on 2026-07-18. Items not stated in those
official documents are labeled as design inferences rather than product facts.

## Comparison matrix

| Concern | Codex Goal mode | Claude Code `/goal` | Pi baseline `/goal` | Assessment |
| --- | --- | --- | --- | --- |
| Goal identity | One goal per chat; parallel chats retain separate context and goals | One goal per session; a new goal replaces the old one | One active slot per normalized `ctx.cwd` | Pi persists beyond a session, but directory spelling is the wrong universal identity |
| Start and steering | Goal text is first prompt and completion criteria; follow-ups edit context or constraints | Goal condition immediately starts a turn | Starts immediately when idle; edit/pause/resume are human-owned | Pi is safe, but ordinary follow-ups currently revoke autonomous authority instead of becoming first-class steering events |
| Continuation trigger | Host automatically continues the active chat | Built-in session-scoped prompt Stop hook runs after every turn | `agent_end` records and `agent_settled` dispatches exactly once | Pi has the strongest retry/queue settlement semantics, but it is tied to Pi lifecycle events |
| Completion judge | Host goal loop applies the goal contract; public docs emphasize self-verifiable completion | Separate small model returns yes/no and a reason | Worker emits a correlated record; terminal outcomes request a prompt-mediated independent evaluator | Pi correlation is robust, but asking the worker to arrange the evaluator is the largest reliability weakness |
| Verification | Goal should include tests or review criteria; same sandbox/approval policy remains | Evaluator only sees the transcript and cannot read files or run tools | Completion needs high-confidence evaluator approval plus fresh passed evidence for every configured command | Pi is materially stronger, though it trusts agent-surfaced command evidence and does not execute checks itself |
| Failure behavior | Pauses for decisions under the existing approval policy | Hook and permission failures are host-managed; Stop hooks are overridden after eight consecutive blocks | Malformed, duplicate, stale, contradictory, or missing records fail closed to `needs_user` | Pi is safer and more auditable, but strict text parsing can cause avoidable false stops |
| Persistence | Goal stays attached to the chat | Active goal restores on session resume; counters reset; achieved and cleared goals do not restore | Atomic per-root state, archive, corruption quarantine, legacy migration, JSONL audit log | Pi is the best durable system |
| Bounds and usage | Current host contract tracks goal work; public docs focus on chat control rather than a universal fixed cap | Status reports turns/tokens; bounds are expressed in the condition | Default 10 continuations plus optional cumulative token budget and provider-limit states | Pi is safer unattended, but the default hard cap differs from native expectations and should become policy-configurable |
| Concurrency | Separate chats; worktrees recommended when files overlap | Session-scoped; hook input exposes session and working directory | Renewable session lease per normalized working root | Pi prevents double dispatch, but subdirectories and symlinks can evade the collision boundary |
| Status and history | Native progress row and chat status; pause/resume/edit/clear | Native indicator and status show duration, turns, tokens, evaluator reason | Footer, `/goal`, `/goal list`, evidence, latest archived achievement | Pi has richer records but weaker product presentation |
| Non-interactive or scheduled use | Goal is available in interactive Codex surfaces; other Codex automation surfaces are separate | `claude -p "/goal ..."` runs to completion; scheduling is separate | No execution after Pi exits | Cross-client driver needs an explicit headless runner later, not in the first extraction |
| Extension seam | Plugins, hooks, skills, and MCP are supported; built-in `/goal` replacement is not documented | Skills, MCP, plugins, and Stop hooks are supported; built-in `/goal` replacement is not documented | Direct Pi extension API | Shared MCP plus client lifecycle hooks is the supported common denominator |

## Pi strengths to preserve

1. **Coordinator-owned state transitions.** A worker proposes outcomes; it does
   not directly mark itself complete.
2. **Correlated run identity.** Goal ID, revision, run ID, and evaluation request
   ID prevent stale or replayed decisions from settling a newer run.
3. **Evidence-gated completion.** Verification receipts are revision- and
   run-aware, and the unbounded proof ledger is separate from the compact display
   history.
4. **Exactly-once settlement.** Recording at `agent_end` and settling at
   `agent_settled` correctly handles retries and queued follow-ups.
5. **Durable safety.** Atomic snapshots, append-only logs, corruption quarantine,
   completion archives, leases, turn limits, token budgets, and explicit provider
   limit states make unattended operation inspectable and recoverable.
6. **Human authority boundaries.** Activation, edits, pause/resume, and budget
   changes remain human-owned by default.

## Pi weaknesses to fix

### P0: Universal identity is missing

`ctx.cwd` normalization is neither a session identity nor a reliable workspace
identity. The same worktree launched through a subdirectory or symlink can acquire
two independent goal slots. Conversely, one root-scoped goal cannot naturally
distinguish two read-only sessions.

Introduce three separate identities:

- `goalId`: durable objective and history;
- `workspaceId`: canonical repository/worktree resource boundary;
- `clientSessionId`: Codex chat, Claude session, or Pi session attached to the goal.

For Git, derive `workspaceId` from the real worktree root plus the repository common
directory. For non-Git directories, use a filesystem realpath. Preserve the old Pi
key through a migration alias. Attaching a second execution session must be
explicit; read-only inspection can remain concurrent.

### P0: Evaluation is worker-mediated

The extension asks the same worker turn to spawn an evaluator and print two
structured records. That is not equivalent to a coordinator invoking an evaluator
after every turn. Availability, prompt compliance, and marker formatting can all
stop a healthy loop.

Move evaluation behind the driver interface. An adapter submits a settled run and
its evidence; the driver invokes the configured evaluator or applies deterministic
rules. The worker should return ordinary progress plus tool receipts, not lifecycle
authority encoded in final prose.

### P0: Evidence is not independently collected

The current ledger is strong, but verification commands are still run and reported
by the working agent. Add adapter-owned verification receipts containing command,
exit code, timestamp, workspace identity, goal revision, run ID, and an output
digest. The adapter executes checks inside the client's existing sandbox and
permission policy. The central service must not gain an unrestricted shell.

### P1: Steering is represented as interruption

Codex and Claude let the user add constraints while a goal is active. Pi safely
halts when a normal user message joins the autonomous run, but the driver should
classify later input as either:

- `steer`: append context/constraints and increment goal revision;
- `inspect`: answer without changing execution authority;
- `pause`: stop dispatch; or
- `replace`: create a new objective after archiving the old state.

Do not infer destructive replacement from arbitrary text. Adapters should expose
an explicit steer operation and show the resulting revision.

### P1: Objective contract is underspecified

Codex recommends outcome, constraints, and verification; Claude recommends a
measurable end state, a stated check, and constraints. Pi stores one unstructured
string plus verification commands. Introduce an additive `GoalContract`:

```json
{
  "objective": "string",
  "constraints": ["string"],
  "acceptanceCriteria": ["string"],
  "verification": [{ "kind": "command", "value": "npm test" }],
  "limits": { "maxTurns": 10, "maxTokens": 100000 }
}
```

Keep the original text for display and compatibility. Enforce a portable 4,000
character maximum for the textual objective at every adapter boundary.

### P1: Policy and engine are mixed

`index.ts` currently mixes Pi events, prompts, UI notifications, state transition
policy, and dispatch. Extract pure transition functions and a versioned protocol so
all clients run the same conformance fixtures. Host-specific usage fields should be
normalized but retain a raw provider breakdown for audit.

## Target architecture

```text
Pi adapter ---------\
Codex adapter -------+--> goal-core service --> snapshot + append-only journal
Claude adapter ------/          |
                               +--> evaluator policy
                               +--> verification receipt policy
                               +--> lease and budget policy
```

### `goal-core`

A local, provider-neutral package and process owns:

- versioned goal contract and event schemas;
- state transitions, revisions, leases, budgets, and completion receipts;
- an append-only event journal plus rebuildable snapshots;
- evaluator dispatch and completion policy;
- adapter/session attachments and workspace collision checks;
- migration from the current Pi schema.

Expose a local MCP server for interoperability, but keep the domain package usable
directly by the Pi adapter. Suggested tools:

```text
goal_start              goal_get               goal_list
goal_attach             goal_heartbeat         goal_release
goal_steer              goal_pause             goal_resume
goal_submit_run         goal_record_evidence   goal_settle
goal_clear
```

Mutating tools require a revision and an idempotency key. `goal_settle` should be
coordinator-only, not generally model-callable. Every tool response returns the
current revision and the next permitted actions.

### Pi adapter

Keep `/goal` as the native UX. Replace local lifecycle policy with calls into
`goal-core`, while preserving `agent_settled` as Pi's authoritative settled-run
event. This is the reference adapter and migration path.

### Codex adapter

Package MCP, hooks, and a skill/command entrypoint such as `/pi-goal`. Session-start
or prompt hooks attach the current chat/session; a stop/settled hook submits the run
and either supplies continuation guidance or releases control. Codex retains its
sandbox and approvals. Native `/goal` remains separate until OpenAI documents a
supported bridge or override.

### Claude adapter

Package MCP, `/pi-goal`, and a command or MCP-backed Stop hook. Claude's documented
Stop-hook interface maps naturally to driver decisions: block with a reason to
continue, or allow the session to stop. Check `stop_hook_active` and honor Claude's
host safety limit. Native `/goal` remains separate.

## Recommended implementation sequence

### Slice 1: Extract and prove the core

1. Add a provider-neutral `pi/extensions/goal-loop/core/` package without changing
   current `/goal` behavior.
2. Add `GoalContract`, `WorkspaceIdentity`, `ClientSessionBinding`, and versioned
   event envelopes.
3. Move pure transition, budget, lease, correlation, and completion policy into
   the core.
4. Add workspace discovery with realpath and Git worktree identity, including
   migration tests for old root keys.
5. Enforce the 4,000-character objective limit and preserve the existing default
   10-turn policy as a configurable Pi profile.
6. Run all current tests unchanged plus adapter-neutral conformance fixtures.

This slice has the best risk-to-value ratio. It fixes the identity bug and creates
the seam needed by every later adapter without adding network or headless execution.

### Slice 2: Driver-owned evaluation and evidence receipts

1. Replace worker/evaluator text markers with structured adapter submissions.
2. Add an evaluator interface with deterministic and model-backed implementations.
3. Add adapter-owned verification receipts and freshness rules.
4. Keep a compatibility parser during one schema migration window.

### Slice 3: Cross-client adapters

1. Add the local MCP service.
2. Ship Claude `/pi-goal` plus Stop-hook adapter first; its continuation seam is
   explicitly documented and closest to Pi's current lifecycle.
3. Ship Codex `/pi-goal` plus MCP/hook adapter.
4. Run the same lifecycle conformance suite against all three adapters.

### Slice 4: Headless operation and evolve loop

Only after production run history exists, add a headless runner, scheduled/event
triggers, and a separate evolve process that proposes contract or policy changes.
Evolve must create reviewable diffs and may not silently loosen permissions,
verification requirements, or autonomy boundaries.

## Acceptance criteria for the main-driver claim

Pi should only be called the main cross-client goal driver when all of these hold:

- The same goal can be created in one client and inspected or explicitly attached
  from another without duplicating state.
- Two sessions cannot execute against the same worktree lease concurrently.
- Pi, Codex, and Claude pass one shared lifecycle conformance suite.
- Completion uses driver-owned evaluation and fresh adapter-owned evidence.
- Client permissions remain authoritative; the driver cannot bypass them.
- Every mutation is revisioned, idempotent, journaled, and recoverable.
- Native `/goal` behavior is never silently shadowed or misrepresented.

## Decision

Proceed with **Slice 1: extract and prove the core**. Do not begin with an MCP
server or native-command emulation. The current Pi implementation contains the
right safety policy, but that policy first needs a portable identity model and a
clean boundary from Pi UI/lifecycle code.
