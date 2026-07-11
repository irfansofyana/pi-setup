# Managed Skills Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the managed-skills template into a modular, secure, lifecycle-correct Pi extension ready for long-term use.

**Architecture:** Keep `index.ts` as a thin entry point and split configuration, safe filesystem access, skill storage, Hindsight retention, capture lifecycle, and Pi wiring into focused modules. Pure state and injected runtime dependencies make queue ordering and failures deterministic in tests.

**Tech Stack:** TypeScript ESM, Node.js built-ins, Node test runner, Pi extension API `>=0.80.4`, native `fetch`.

## Global Constraints

- Preserve `manage_skill`, `learn`, `/managed-skills`, `~/.pi/agent/managed-skills/config.json`, and `~/.pi/agent/managed-skills/<name>/SKILL.md`.
- Require Pi `>=0.80.4` for `agent_settled`.
- Add no runtime dependencies.
- Keep provider credentials in environment/profile config; never persist them in this repository.
- Run `/reload` or restart Pi after extension/config changes.
- Do not commit unless the user explicitly asks.

## Current Status

Done. Modular refactor, lifecycle fixes, filesystem hardening, documentation, and verification are complete.

## Research

- Pi `0.80.4` added `agent_settled` for fully settled extension runs: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md>.
- Installed Pi `0.80.6` documentation defines `agent_end` as a low-level run boundary and `agent_settled` as the no-continuation boundary.

---

### Task 1: Capture Lifecycle State Machine

**Files:**
- Create: `pi/extensions/managed-skills/auto-capture.ts`
- Create: `pi/extensions/managed-skills/auto-capture.test.ts`
- Modify: `pi/extensions/managed-skills/index.ts`

**Interfaces:**
- Produces: `AUTO_CAPTURE_TYPE`, `AutoCaptureState`, `recordAgentEnd(state, input)`, `settleAutoCapture(state, input)`, and `buildAutoCapturePrompt(config)`.
- Consumes: effective `ManagedSkillsConfig` and Pi `agent_end.messages`-shaped values.

- [x] **Step 1: Write failing state-machine tests**

Cover threshold recording without sending, continuation-chain candidate retention, pending/non-idle deferral, one idle dispatch, marker correlation, retry suppression, final suppression cleanup, `minToolCalls: 0`, disabled automation, and prompts with `learn` disabled.

- [x] **Step 2: Verify red**

Run: `node --test pi/extensions/managed-skills/auto-capture.test.ts`

Expected: FAIL because `auto-capture.ts` does not exist.

- [x] **Step 3: Implement the pure state machine**

Use immutable transitions with this contract:

```ts
export interface AutoCaptureState {
  pendingToolCalls: number | null;
  captureChainActive: boolean;
}

export interface AutoCaptureDecision {
  state: AutoCaptureState;
  prompt?: string;
  toolCalls?: number;
}
```

Marker detection inspects `role === "custom" && customType === AUTO_CAPTURE_TYPE`. `recordAgentEnd` never dispatches. `settleAutoCapture` preserves candidates while non-idle or pending.

- [x] **Step 4: Wire lifecycle hooks**

Keep run-local tool counting, remove `suppressNextAgentEnd`, and send only from `agent_settled` with `{ deliverAs: "followUp", triggerTurn: true }`.

- [x] **Step 5: Verify green**

Run: `node --test pi/extensions/managed-skills/auto-capture.test.ts pi/extensions/managed-skills/index.test.ts`

Expected: all tests pass.

### Task 2: Safe Atomic Files And Config

**Files:**
- Create: `pi/extensions/managed-skills/filesystem.ts`
- Create: `pi/extensions/managed-skills/filesystem.test.ts`
- Create: `pi/extensions/managed-skills/config.ts`
- Create: `pi/extensions/managed-skills/config.test.ts`
- Modify: `pi/extensions/managed-skills/index.ts`

**Interfaces:**
- Produces: `ensureSafeDirectory(path)`, `readRegularFile(path, options)`, `atomicWriteFile(path, content, options)`, `ManagedSkillsConfigResult`, `readManagedSkillsConfig`, and `writeManagedSkillsConfig`.
- `atomicWriteFile` accepts an injected pre-rename hook for deterministic failure tests.

- [x] **Step 1: Write failing filesystem/config tests**

Prove destination symlinks are replaced without changing targets; failed temp writes preserve destinations and clean temps; unsafe/oversized reads fail; missing config uses defaults; malformed existing config fails closed with a diagnostic; successful writes replace invalid files.

- [x] **Step 2: Verify red**

Run: `node --test pi/extensions/managed-skills/filesystem.test.ts pi/extensions/managed-skills/config.test.ts`

Expected: FAIL because the modules do not exist.

- [x] **Step 3: Implement safe file primitives**

Create same-directory temp names from the destination basename, PID, timestamp, and random bytes. Open with `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`, write, sync, close, then rename. On failure, close and unlink the temp without changing the destination.

- [x] **Step 4: Implement structured config reads**

Return:

```ts
export interface ManagedSkillsConfigResult {
  config: ManagedSkillsConfig;
  diagnostic?: string;
}
```

Only `ENOENT` gets normal defaults. Parse/type/read failures force `enabled`, `learnEnabled`, `autoCapture`, and `autoContinue` to `false`.

- [x] **Step 5: Integrate and verify green**

Status/config display diagnostics; mutation commands persist normalized config atomically.

Run: `node --test pi/extensions/managed-skills/filesystem.test.ts pi/extensions/managed-skills/config.test.ts pi/extensions/managed-skills/index.test.ts`

Expected: all tests pass.

### Task 3: Skill Store Extraction And Atomicity

**Files:**
- Create: `pi/extensions/managed-skills/skill-store.ts`
- Create: `pi/extensions/managed-skills/skill-store.test.ts`
- Modify: `pi/extensions/managed-skills/index.ts`
- Modify: `pi/extensions/managed-skills/index.test.ts`

**Interfaces:**
- Produces sanitizers, frontmatter helpers, discovery, list/view, and create/update/delete functions.
- Consumes safe filesystem primitives plus explicit `root` and `maxBytes` values.

- [x] **Step 1: Move store tests and add failing atomicity tests**

Retain CRUD and link/path safety coverage. Add failed-update preservation, configured 80 KB listing of a 70 KB skill, 64 KB exclusion, oversized-view rejection, and concurrent mutation serialization.

- [x] **Step 2: Verify red**

Run: `node --test pi/extensions/managed-skills/skill-store.test.ts`

Expected: FAIL until the extracted store exists.

- [x] **Step 3: Implement the store**

Create remains exclusive. Update validates then atomically replaces. List/view use bounded `O_NOFOLLOW` reads. All list/view callers pass the effective configured limit.

- [x] **Step 4: Remove monolith duplicates and verify green**

Run: `node --test pi/extensions/managed-skills/skill-store.test.ts pi/extensions/managed-skills/index.test.ts`

Expected: all tests pass with no duplicate store implementation in `index.ts`.

### Task 4: Hindsight Extraction

**Files:**
- Create: `pi/extensions/managed-skills/hindsight.ts`
- Create: `pi/extensions/managed-skills/hindsight.test.ts`
- Modify: `pi/extensions/managed-skills/index.ts`
- Modify: `pi/extensions/managed-skills/index.test.ts`

**Interfaces:**
- Produces Hindsight config, redaction, lesson sanitization, project scoping, and retention functions.
- Consumes environment values, an optional config path, abort signal, and injected `fetch`.

- [x] **Step 1: Move and extend Hindsight tests**

Cover redaction, limits, all scoping modes, endpoint encoding, authorization, payload metadata, timeout/abort composition, and non-2xx errors.

- [x] **Step 2: Verify red**

Run: `node --test pi/extensions/managed-skills/hindsight.test.ts`

Expected: FAIL until `hindsight.ts` exists.

- [x] **Step 3: Extract without changing the HTTP contract**

Preserve `/v1/default/banks/<encoded-bank>/memories`, `async: true`, project tags, and `managed-skills-learn` metadata.

- [x] **Step 4: Verify green**

Run: `node --test pi/extensions/managed-skills/hindsight.test.ts`

Expected: all tests pass without network access.

### Task 5: Runtime Wiring And Fake Pi Harness

**Files:**
- Create: `pi/extensions/managed-skills/types.ts`
- Create: `pi/extensions/managed-skills/schema.ts`
- Create: `pi/extensions/managed-skills/extension.ts`
- Create: `pi/extensions/managed-skills/extension.test.ts`
- Modify: `pi/extensions/managed-skills/index.ts`

**Interfaces:**
- Produces `createManagedSkillsExtension(dependencies)` and `managedSkillsExtension`.
- Consumes config, store, Hindsight, schema, and auto-capture module contracts.

- [x] **Step 1: Write the fake Pi API and failing runtime tests**

Record event handlers, commands, tools, sent messages, and notifications. Cover registration modes, discovery limits, config-aware guidance, create/update authored collisions, list limits, command persistence, learn partial outcomes, lifecycle deferral, one hidden dispatch, and retry suppression.

- [x] **Step 2: Verify red**

Run: `node --test pi/extensions/managed-skills/extension.test.ts`

Expected: FAIL because `extension.ts` does not exist.

- [x] **Step 3: Implement dependency-injected runtime wiring**

Use a narrow dependency object with production defaults. Preserve command/tool text unless correcting inaccurate behavior. Build prompts from effective config and reject known authored collisions for create and update.

- [x] **Step 4: Reduce `index.ts` to entry point and re-exports**

Default-export `managedSkillsExtension`; re-export supported helpers so copied Pi loading and existing tests remain compatible.

- [x] **Step 5: Verify green**

Run: `node --test pi/extensions/managed-skills/*.test.ts`

Expected: all tests pass.

### Task 6: Documentation, Package UX, And Final Verification

**Files:**
- Modify: `pi/extensions/managed-skills/package.json`
- Modify: `pi/extensions/managed-skills/README.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-11-managed-skills-extension.md`

- [x] **Step 1: Add package scripts and compatibility docs**

Add a dependency-free test script. Document Pi `>=0.80.4`, fail-closed invalid config, settled capture, atomic writes, and `/reload`.

- [x] **Step 2: Run project-shaped verification**

Run:

```bash
npm test --prefix pi/extensions/managed-skills
npx -y tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --types node pi/extensions/managed-skills/*.ts
git diff --check origin/main...HEAD
git status --short
```

Expected: tests and typecheck pass; diff check emits nothing; status lists only intended files.

- [x] **Step 3: Smoke-load the copied extension shape**

Copy the extension to a temporary Pi extension-shaped directory and import `index.ts`. Confirm the default export is a function and import performs no production config write or Hindsight request.

- [x] **Step 4: Close the workflow artifact**

Set Current Status to `Done`, mark tasks complete, record exact verification, and set Handoff to `N/A - implementation and verification complete` or the first remaining action.

## Verification

- `npm test --prefix pi/extensions/managed-skills`: 39 tests passed, 0 failed.
- Clean temporary copy: `npm test`: 39 tests passed, 0 failed.
- Clean temporary copy: `npm run typecheck`: passed against Pi `0.80.6`.
- Clean temporary copy import smoke test: default export is a function and import has no config/daemon side effect.
- JSON parse check for `package.json` and `tsconfig.json`: passed.
- ASCII scan for new source/docs: passed.
- `git diff --check`: passed.
- Final independent review: no Critical, Major, Minor, or merge-blocking findings.

## Open Questions And Risks

- Atomic rename is reliable within one filesystem; temporary files always live in the destination directory.
- Pi `0.80.3` users must upgrade before using this extension version.
- Full provider-backed model execution needs credentials, so lifecycle behavior is verified with the fake Pi harness and installed API types.
- Non-blocking residuals: parent directories are not fsynced after rename, and cross-process path replacement cannot be made fully race-free with portable Node file APIs. This is acceptable for a local same-user extension.

## Handoff

N/A - implementation, verification, and final review are complete.
