# Subagent limits: Claude, Codex, and Pi

## Recommendation

Production default is now **3 executing children**, with an explicit global configuration option for higher concurrency (for example 6). No local configuration was rewritten. Keep concurrency, retained thread count, and nesting separate. Raising nesting alone does not allow sibling agents to execute simultaneously.

Use read-only research/scouting for initial parallel validation. Preserve builder worktree isolation, bounded queues, cancellation, resource isolation and cumulative budgets. Do not infer a safe Pi cap from another product's cap: Pi children share a process.

## Method and scope

Two researcher subagents investigated Claude and Codex independently. Both launches were accepted, but observed token usage indicated execution serialized under the current Pi cap. Launch acceptance is not proof of parallel execution. Material evidence came from fetched official documentation and OpenAI source; the parent additionally fetched the central Claude limits page, Codex configuration reference and pinned Codex constants.

These are version-qualified findings, not universal claims for every installed release. Research changed no local settings. Follow-up implementation raised the no-config production default to 3 and removed private-preview/demo features. No resource-heavy validation was run.

## Findings

| Product / limit | Verified finding | Qualification |
| --- | --- | --- |
| Claude ordinary subagent concurrency | Default **20** running subagents; configurable with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | Across Agent-tool-spawned subagents. At capacity, spawn refuses rather than automatically queues. Ultracode sessions bypass this refusal. [1] |
| Claude ordinary subagent nesting | Default **3 layers below main**; configurable with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | Setting 1 prevents child delegation. Docs qualify this limits section to SDK TS ≥0.3.219 / Python ≥0.2.127, bundling Claude Code ≥2.1.219. Older releases differ. [1] |
| Claude turns and spend | Optional per-agent `maxTurns`; query spend cap includes subagent spend | No universal numeric per-agent turn or wall-clock ceiling established. Query turn and spend limits are distinct. [1][2] |
| Claude agent teams | No documented hard teammate-count limit; **3–5** is advice | Experimental and separate from ordinary subagents. No nested teams; SDK sessions do not spawn teammates. [3] |
| Codex V1 concurrency | Default constant **6**, configurable | Verified in release `rust-v0.162.1`; not a universal V2 default. [5] |
| Codex V1 nesting | Default constant **1** | Direct children of root, not grandchildren. Current source describes `max_depth` as V1-only, ignored by V2. [5][6][7] |
| Codex V2 concurrency | Separate default constant **4** | Constant verified in the pinned release; full effective resolution/counting path not verified. Do not equate this automatically to four actively executing children. [5] |
| Codex current concurrency setting | `agents.max_concurrent_threads_per_session`; `agents.max_threads` is a legacy alias | Current reference describes concurrently **open spawned threads**, excluding primary thread—not lifetime spawns or necessarily active computations. [4] |
| Codex turns / time / context | No universal ordinary-agent turn or execution timeout verified; context is model-dependent | V2 wait-tool timeouts do not establish execution deadlines. Current source retains `job_max_runtime_seconds` as no-op compatibility. [4][5][6] |

No authoritative absolute configurable upper bound was established for Claude concurrency/depth or Codex concurrency. Defaults are not immutable maxima.

## Pi implementation

- `pi/extensions/subagents/config.ts`: shared no-config caps are `concurrency: 3`, `threads: 4`, `slots: 8`, `pending: 4`.
- `pi/extensions/subagents/activation.ts`: missing user config uses these caps; explicit existing configuration remains authoritative and is not rewritten.
- `pi/extensions/subagents/supervisor.ts`: `setAdmissionLimits` rejects an increase above the deployment ceiling. `/agents` cannot raise that ceiling; higher concurrency requires explicit global configuration.
- `pi/extensions/subagents/runtime.ts`: production manager wiring uses a separate levels cap of **4**. Private-preview registration and `/agents-demo` are removed, along with their launcher and fixtures.
- Before implementation, one execution slot serialized independent researchers despite both launches being accepted. Thread capacity does not imply execution capacity.
- Bundled children do not receive arbitrary nesting authority merely because a manager depth cap permits paths: role-approved tools and explicit custom delegation remain separate controls.

**Interpretation:** three is a practical Pi starting point, not a benchmark-derived optimum. Higher ceilings remain explicit; test cancellation/backpressure and resource use before broad rollout. Existing explicit user caps, including 1, are preserved. Native SDK fixtures use temporary test directories, not a shipped preview activation path.

## Key evidence

Claude [1]: “`20` subagents running at once, counting every subagent Claude spawns with the Agent tool”; depth “`3` layers of subagents below your main agent.”

Codex [4]: “Maximum number of spawned-agent threads that can be open concurrently, excluding the primary thread.”

Codex pinned source [5]: `DEFAULT_AGENT_MAX_THREADS: Option<usize> = Some(6)`, `DEFAULT_AGENT_MAX_DEPTH: i32 = 1`, and `DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION: usize = 4`.

## Sources

1. [Claude SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
2. [Claude SDK agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
3. [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
4. [Codex configuration reference](https://developers.openai.com/codex/config-reference)
5. [Codex constants, rust-v0.162.1](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/config/mod.rs)
6. [Codex configuration types, moving main](https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs)
7. [Codex agent registry, moving main](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/registry.rs)

Moving documentation/source can change; re-check the installed version before applying product-specific settings. The earlier claim that Claude subagents categorically cannot spawn subagents is stale for the versions documented in [1].
