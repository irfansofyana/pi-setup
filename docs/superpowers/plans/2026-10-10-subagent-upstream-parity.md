# Upstream Subagent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execution is inline and serial on this shared VM.

**Goal:** Expose upstream subagent benefits and UI with four bundled setup roles.

**Architecture:** Compose upstream configuration/UI/lifecycle components with the
existing single supervised SDK pool. Separate registry/policy, UI integration and
lifecycle bridges so custom types do not bypass role or resource boundaries.

**Tech Stack:** TypeScript, native Pi SDK, pinned upstream 0.20.0, Node tests.

**Spec:** `docs/superpowers/specs/2026-10-10-subagent-upstream-parity-design.md`

## Global Constraints

- Defaults: researcher, scout, builder, reviewer; code-mapper aliases scout.
- No live configuration/auth/theme changes, companion removal, commit or push.
- Preserve role tools, fresh defaults, bounded turns and builder worktrees.
- Headroom preferred, warn on direct fallback, never replay submitted failures.
- One execution pool; one preview child; serial hard-capped local validation.

## Review Focus

- Invalid or symlinked overrides must not reveal a broader fallback role.
- Retained threads must keep their definition across reload and user edits.
- UI save/apply must not claim unsupported policy changes took effect.
- Nested waiting must not deadlock the single-child preview execution limit.
- Reload/off/close must not leak notifications, costs, SDK sessions or ownership.

### Task 1: Bundled registry and custom-role admission

**Files:** Create `pi/extensions/subagents/agents/*.md`, `registry.ts`,
`registry.test.ts`; modify `trusted.ts`, `preview-extension.ts`,
`manager-service.ts`, and launcher/tests.

**Interfaces:** Registry wraps upstream ConfigStore with setup bundles and
`canonicalRole(name)`. Role resolution accepts an immutable reviewed definition
snapshot. Manager accepts a type resolver rather than a hardcoded type list.

- [x] Add focused tests for four bundles, alias, custom types, YAML overrides,
  invalid/symlink overrides and project trust.
- [x] Run the new registry tests in an existing exact-SDK capped fixture; record red.
- [x] Implement registry and generalized reviewed backend with worktree writes.
- [x] Wire agent_types/spawn and compatible entrypoints to dynamic definitions.
- [x] Verify registry and fixed-role regressions serially; update evidence.

### Task 2: Upstream configuration and UI

**Files:** Create `manager-ui.ts`, `manager-ui.test.ts`; modify runtime adapter,
settings/configuration tests and upstream provenance if a source patch is required.

**Interfaces:** UI owns store/settings reload and passes effective settings to
runtime through a validated apply callback; retained threads keep snapshots.

- [x] Test settings/types/reload/reap commands and policy rejection before save.
- [x] Integrate upstream dialogs, pickers, widgets/icons/loaders and cost display.
- [x] Integrate explicit import with selected-profile scope and confirmation.
- [x] Test reload isolation, Off mode and existing theme/editor coexistence.

### Task 3: Child controls, trees and budgets

**Files:** Modify manager driver/service, root service, supervisor, trusted backend,
protocol/admission and adjacent tests; add focused bridge modules as needed.

**Interfaces:** Child-only controls use the manager-owned path; all starts and
continuations share supervised admission. Budget extension is explicit and bounded.

- [x] Test child updates/pause, bounded continuation, cumulative usage and deadlines.
- [x] Implement permission-filtered nesting/independent roots and ancestor wait.
- [x] Prove single-slot nested work cannot deadlock and shutdown joins descendants.
- [x] Wire effective model preferences/context/tools without widening built-ins.

### Task 4: Recovery and parent delivery

**Files:** Add lifecycle/delivery bridge modules and tests; modify session hooks.

**Interfaces:** Restored records retain generation, type snapshot, budget and cost
identity; parent wake/recap is coalesced and honors Off mode and current generation.

- [x] Test delayed/stale delivery, idle transitions, recap and Off suppression.
- [x] Implement supported recovery without violating default no-transcript policy.
- [x] Verify restart/branch/reap accounting and report any precise recovery conflict.

### Task 5: Package integration and completion audit

**Files:** Update AGENTS, owning setup/component docs, setup skill references,
prompts/package contracts, preview guide and upstream difference ledger.

- [x] Deprecate manual template deployment without modifying existing installations.
- [x] Check every upstream feature against adapter tests or a concrete setup conflict.
- [x] Run focused serial bounded tests, document CI/manual validation gaps.
- [x] Publish exact manual commands and remaining conflict list; keep goal active
  until this full audit passes. Remind user about reload only for approved activation.

Implementation/audit complete on 2026-10-10; see component `parity.md` and
`preview.md`. Fresh read-only review's three Important findings reproduced and
fixed; final focused gate 67/67. Manual TUI/provider acceptance and broad CI remain
explicit gates, not implied passes. No activation, commit or push performed.
