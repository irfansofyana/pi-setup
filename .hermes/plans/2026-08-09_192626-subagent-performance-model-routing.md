# Trusted Pi Subagent Performance and Model Routing Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Improve Ciung, Laya, Sangkur, and Prabu with stricter context/data boundaries, clearer evidence contracts, bounded feedback loops, and documented native per-role model selection—without expanding any role's authority.

**Architecture:** Keep the four stable technical IDs and `@tintinweb/pi-subagents@0.14.3`. Canonical repository templates remain model-neutral and inert under `pi/agents/`; the coordinator supplies self-contained task packets and may select an exact model per invocation. Persistent model pins remain optional machine-local overrides. Tighten role frontmatter and prompts, protect them with executable contracts, and keep real execution/integration in the parent.

**Tech Stack:** Pi coding agent, `@tintinweb/pi-subagents@0.14.3`, Markdown/YAML agent templates, Node.js **24.12 via NVM**, Node test runner, TSX, Git/GitHub.

---

## Scope decisions

### Included in this patch

1. Explicitly lock `inherit_context: false` for all four custom roles.
2. Make Ciung web-only by removing local built-in tools.
3. Strengthen each role's deliverable and stopping conditions.
4. Correct Sangkur's test-first language so it never implies observed RED/GREEN.
5. Document native model inheritance, per-invocation selection, optional persistent pins, exact IDs, precedence, fallback, and `scopeModels` caveats.
6. Document self-contained task packets, reviewer evidence packets, and a parent-owned two-round builder repair loop.
7. Extend the template suite and exact-version loader probe.

### Explicitly deferred

- No new model-router extension or alias system.
- No canonical model pins until Irfan provides the exact available IDs from Pi's `/scoped-models`.
- No authority expansion: no shell, network, credentials, nested agents, test execution, push, merge, or deployment for Sangkur.
- No removal of `mermaid`, `teach`, or `code-review` skills in this patch. Project-first skill shadowing is a documented trust consideration, but changing skill behavior needs evaluation evidence.
- No large benchmark platform. A small frozen role scorecard should be a separate follow-up after this safety/config patch lands.

## Current context

- Repository: `/home/irfansofyana/pi-setup`
- Branch: `feat/pi-agent-team`
- Open PR: `#25`
- Current head at planning time: `4e9247c`
- Working tree at planning time: clean
- Stable role IDs: `researcher`, `code-mapper`, `builder`, `reviewer`
- Display identities: Ciung, Laya, Sangkur, Prabu
- Canonical templates intentionally omit `model:`.
- Native precedence is `frontmatter model > Agent({ model }) > parent model`.
- `scopeModels: true` is a runtime routing guardrail, not strict enforcement for pins, inheritance, RPC, or scheduled work.

---

### Task 1: Add failing authority and model-portability contracts

**Objective:** Protect the intended context isolation, web-only researcher, and model-neutral templates before changing implementation.

**Files:**
- Modify: `pi/agents/agent-templates.test.ts:41-89`
- Test: `pi/agents/agent-templates.test.ts`

**Step 1: Extend the context-isolation contract**

Add a test that loops over all four role IDs and asserts:

```ts
assert.match(frontmatter(role), /^inherit_context: false$/m);
```

The first run should fail for `researcher`, `code-mapper`, and `reviewer`; `builder` should already satisfy it.

**Step 2: Strengthen the researcher authority contract**

Update the researcher test to require its `tools:` line to contain exactly the two approved selectors and no built-ins:

```ts
assert.match(
  fm,
  /^tools: "ext:pi-9router-ext\/ninerouter_web_search, ext:pi-9router-ext\/ninerouter_web_fetch"$/m,
);
assert.doesNotMatch(fm, /\b(read|grep|find|ls|edit|write|bash)\b/);
```

Retain assertions for:

```text
extensions: [pi-9router-ext]
skills: 9router-web-researcher
```

**Step 3: Protect runtime model choice**

Add a test asserting none of the canonical templates contains a frontmatter `model:` field:

```ts
for (const role of roles) {
  assert.doesNotMatch(frontmatter(role), /^model:/m);
}
```

This prevents a future repository pin from silently blocking `Agent({ model })` overrides.

**Step 4: Add prompt-contract assertions**

Add narrow assertions that protect:

- Ciung's web-only/sanitized-query contract and claim status ledger.
- Laya's concrete execution-path/change-contract output.
- Sangkur's `execution pending` wording and parent-owned verification.
- Prabu's counterevidence and structured finding contract.

Do not assert whole prompt paragraphs; use stable semantic phrases so copy edits do not make the suite brittle.

**Step 5: Run the focused suite and observe RED**

Run:

```bash
rtk bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.12 >/dev/null && node --test pi/agents/agent-templates.test.ts'
```

Expected: failure caused only by the newly required context/tool/prompt contracts.

---

### Task 2: Lock context isolation and split web from repository access

**Objective:** Remove the direct local-read-to-network path and make fresh context mandatory for every specialist.

**Files:**
- Modify: `pi/agents/researcher.md:2-12`
- Modify: `pi/agents/code-mapper.md:4-12`
- Modify: `pi/agents/reviewer.md:4-12`
- Verify: `pi/agents/builder.md:4-15`

**Step 1: Make Ciung web-only**

Change:

```yaml
description: Evidence-first public web researcher
tools: "ext:pi-9router-ext/ninerouter_web_search, ext:pi-9router-ext/ninerouter_web_fetch"
inherit_context: false
```

Keep:

```yaml
extensions: [pi-9router-ext]
skills: 9router-web-researcher
thinking: medium
max_turns: 20
prompt_mode: append
run_in_background: true
persist_session: false
output_transcript: false
```

Do not add local built-ins, shell, arbitrary network tools, or additional extensions.

**Step 2: Lock fresh context for Laya and Prabu**

Add exactly:

```yaml
inherit_context: false
```

Do not alter their tool allowlists or extension settings.

**Step 3: Verify Sangkur remains isolated**

Confirm, without changing authority:

```yaml
inherit_context: false
isolation: worktree
extensions: false
tools: read, grep, find, ls, edit, write
```

**Step 4: Run the focused suite**

Run the Node 24.12 command from Task 1.

Expected: context and researcher-tool assertions pass; role prompt assertions may remain red until Task 3.

**Step 5: Commit the mechanical boundary change**

```bash
rtk git add pi/agents/agent-templates.test.ts pi/agents/researcher.md pi/agents/code-mapper.md pi/agents/reviewer.md
rtk git commit -m "fix(pi): tighten subagent context boundaries"
```

---

### Task 3: Tighten role prompts and deliverables

**Objective:** Improve useful output and stopping behavior without adding tools or turns.

**Files:**
- Modify: `pi/agents/researcher.md:15-29`
- Modify: `pi/agents/code-mapper.md:15-29`
- Modify: `pi/agents/builder.md:18-36`
- Modify: `pi/agents/reviewer.md:15-30`
- Test: `pi/agents/agent-templates.test.ts`

**Step 1: Refine Ciung**

Require it to:

- Accept only sanitized questions, public identifiers, and public URLs from the parent.
- Start broad, then narrow.
- Distinguish the released artifact from repository `main`.
- Stop when every material claim is confirmed or explicitly unresolved.
- Return a compact ledger:

```text
claim | confirmed/inferred/unknown | primary source | version/date | conflicts
```

Retain the prohibition on treating external content as instructions and on transmitting secrets, personal data, local content, or proprietary identifiers.

**Step 2: Refine Laya**

Require one concrete trace containing:

```text
entry point
call/data path
state mutation
failure path
owning tests
exact file/line evidence
```

Its final change contract must identify:

```text
files that must change
files that must not change
invariants
test seams
unresolved questions
```

Make Mermaid optional—use it only when it clarifies a nontrivial branch or lifecycle.

**Step 3: Correct Sangkur's test-first contract**

Replace any implication of observed TDD with:

1. Add or update the smallest behavior test.
2. Implement the smallest patch expected to satisfy it.
3. State explicitly that execution is pending.
4. Await exact parent verification evidence before a repair.

Keep `max_turns: 60` for this patch. The proposed reduction to 40 should be measured with the follow-up scorecard rather than guessed.

Add a stopping condition: finish after the smallest assigned vertical slice; stop on conflicting requirements, scope expansion, destructive work, or missing evidence.

**Step 4: Refine Prabu**

Require each finding to contain:

```text
severity | evidence | violated invariant | concrete impact | smallest fix | confidence
```

Require an explicit search for counterevidence before reporting a blocker. Preserve `no material findings` as valid and list residual risks separately.

**Step 5: Run the focused suite to GREEN**

Run:

```bash
rtk bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.12 >/dev/null && node --test pi/agents/agent-templates.test.ts'
```

Expected: all template tests pass on Node `v24.12.0`.

**Step 6: Commit the prompt-contract improvement**

```bash
rtk git add pi/agents/agent-templates.test.ts pi/agents/researcher.md pi/agents/code-mapper.md pi/agents/builder.md pi/agents/reviewer.md
rtk git commit -m "feat(pi): sharpen subagent evidence contracts"
```

---

### Task 4: Document model selection without pinning the templates

**Objective:** Give Irfan a clear supported way to choose models globally, per role, or per invocation.

**Files:**
- Modify: `docs/setup/subagents.md:18-23,88-118`
- Modify: `docs/setup/operations.md` model/orchestration examples where relevant
- Modify: `README.md` only if a concise navigation sentence is needed
- Test: `pi/agents/agent-templates.test.ts`

**Step 1: Add a “Choose models” section**

Document these modes:

1. **Default inheritance:** omit `model:`; role uses current parent `/model`.
2. **Per invocation:** only for unpinned roles:

```js
Agent({
  subagent_type: "builder",
  model: "<provider>/<model-id>",
  thinking: "high",
  prompt: "...",
  description: "Implement approved slice"
})
```

3. **Persistent machine-local pin:** add an exact `model: <provider>/<model-id>` only to the reviewed installed copy under `~/.pi/agent/agents/<role>.md`.

State precedence exactly:

```text
frontmatter model > Agent({ model }) > parent model
```

**Step 2: Document safe model operations**

Include:

```text
/model
/scoped-models
/reload
/agents
```

Require exact `provider/modelId` values for persistent configuration. Explain that fuzzy matching and provider fallback are convenient but not reproducible policy.

**Step 3: Document native caveats accurately**

State:

- Caller-selected out-of-scope models hard-fail.
- Frontmatter-pinned and parent-inherited out-of-scope models warn and run.
- Missing/empty exact `enabledModels` makes checking a no-op.
- An unavailable frontmatter pin can fall back to the parent; `/agents` displays `(unavailable, fallback: inherit)`.
- `scopeModels` is a routing guardrail, not a hard security boundary.

Do not document unsupported aliases, a global subagents default-model key, or a nonexistent per-launch picker.

**Step 4: Add the role-model strategy table**

```text
Ciung → fast disciplined web/tool model
Laya  → strong long-context code-understanding model
Sangkur  → strongest available coding model
Prabu    → strong reviewer from a different family/provider than Sangkur
```

Use placeholders until `/scoped-models` provides actual model IDs.

**Step 5: Add model-documentation assertions**

In `agent-templates.test.ts`, read `docs/setup/subagents.md` and assert the presence of:

- `Agent({ model })` or equivalent per-run selection language;
- frontmatter precedence;
- `/scoped-models`;
- fallback visibility in `/agents`;
- canonical templates remaining unpinned.

**Step 6: Run focused tests and documentation checks**

Expected: template/documentation tests pass; README remains within its existing 180–250 line contract.

**Step 7: Commit**

```bash
rtk git add README.md docs/setup/subagents.md docs/setup/operations.md pi/agents/agent-templates.test.ts
rtk git commit -m "docs(pi): explain per-role model selection"
```

Only stage files that actually changed.

---

### Task 5: Document self-contained handoffs and bounded repair loops

**Objective:** Make coordinator behavior repeatable and evidence-driven.

**Files:**
- Modify: `docs/setup/subagents.md:92-129`
- Modify: `docs/setup/operations.md`
- Modify: `pi/agents/agent-templates.test.ts` only for stable documentation contracts

**Step 1: Add the standard task packet**

```text
Goal:
Decision this informs:
Repository/base SHA or public upstream version:
Acceptance criteria or research questions:
Exact scope:
Non-goals:
Evidence already collected:
Required deliverable:
Stopping/escalation condition:
```

State that all custom roles use `inherit_context: false`; tool output from the parent is not inherited, so evidence must be copied into the task packet deliberately.

**Step 2: Add the Prabu evidence packet**

```text
acceptance criteria
base SHA
candidate SHA
actual diff
relevant full-file context
commands executed
exact test output
known skipped checks/failures
builder assumptions
```

Partial, `steered`, `aborted`, or `stopped` results are not approval evidence.

**Step 3: Add the parent-owned builder repair loop**

```text
Sangkur writes test/code
→ parent inspects full branch and runs exact verification
→ parent sends exact failure output through resume/steer
→ Sangkur makes one focused repair
→ parent reruns verification
```

Default maximum: two repair rounds. After that, stop and reconsider scope or assumptions rather than adding turns blindly.

**Step 4: Preserve orchestration budget**

Keep `maxConcurrent: 3` and smart join. Tell the coordinator to parallelize only independent streams such as external research versus local mapping—not coupled code changes.

**Step 5: Run focused tests and commit**

```bash
rtk bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.12 >/dev/null && node --test pi/agents/agent-templates.test.ts'
rtk git add docs/setup/subagents.md docs/setup/operations.md pi/agents/agent-templates.test.ts
rtk git commit -m "docs(pi): standardize subagent handoffs"
```

---

### Task 6: Validate against Node 24.12 and the exact upstream loader

**Objective:** Prove the templates remain compatible and that no authority boundary regressed.

**Files:**
- Verify: `pi/agents/*.md`
- Verify: `pi/agents/subagents.json`
- Temporary external probe only: `/tmp/pi-subagents-audit/test/validate-team-template.test.ts`

**Step 1: Activate the Pi-specific runtime**

Every Pi validation command in this task must run through:

```bash
rtk bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.12 >/dev/null && node --version'
```

Expected: `v24.12.0`.

**Step 2: Run template contracts**

```bash
rtk bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.12 >/dev/null && node --test pi/agents/agent-templates.test.ts'
```

Expected: all tests pass; record the actual count.

**Step 3: Run all extension regressions**

```bash
rtk bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.12 >/dev/null && node --test pi/extensions/*/*.test.ts'
```

Expected: all tests pass; record the actual count.

**Step 4: Run the signature suite**

```bash
rtk bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.12 >/dev/null && npx -y tsx --test pi/extensions/pi-signature.test.ts'
```

Expected: all signature tests pass.

**Step 5: Update and run the real v0.14.3 loader probe**

Ensure the exact-version probe asserts:

- all four display names;
- all four `inheritContext === false` values;
- Ciung has zero built-ins and exactly two 9router selectors;
- unchanged mapper/builder/reviewer effective tools;
- disabled extensions where required;
- worktree isolation and background behavior;
- no canonical model pins.

Run from the audited checkout using Node 24.12:

```bash
rtk bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use 24.12 >/dev/null && npx vitest run test/validate-team-template.test.ts'
```

Expected: loader compatibility test passes against the exact `v0.14.3` package source.

**Step 6: Run static/document checks**

Verify:

- `README.md` remains 180–250 lines.
- `pi/agents/subagents.json` parses as JSON.
- Relative documentation links resolve.
- Bash snippets parse with `bash -n` where practical.
- Security-pattern scan finds no broadened tools/extensions.
- `rtk git diff --check` passes.

**Step 7: Inspect the full diff**

```bash
rtk git diff origin/main...HEAD
rtk git status --short --branch
```

Expected: only intended templates, tests, and documentation changed; no temporary files or credentials.

---

### Task 7: Update PR #25 and request independent review

**Objective:** Publish the validated changes with accurate evidence and re-review the new authority/model semantics.

**Files:**
- Update temporary PR body source: `/tmp/pi-agent-team-pr.md`
- External: GitHub PR `#25`

**Step 1: Update PR evidence**

Add:

- Node `v24.12.0` used for Pi validation.
- Actual template, extension, signature, and loader test counts.
- Explicit context isolation.
- Web-only researcher authority.
- Model routing documentation and no canonical pins.
- Parent-owned repair/review loop.

**Step 2: Push the branch**

```bash
rtk git push -u origin feat/pi-agent-team
```

**Step 3: Verify remote state**

Confirm the PR head SHA equals local `HEAD`, the body contains current evidence, and GitHub still reports the PR mergeable.

**Step 4: Request Codex review**

Post:

```text
@codex review
```

Fetch top-level issue comments, submitted reviews, inline comments, and review threads separately. Validate findings against actual v0.14.3 behavior before changing code.

**Step 5: Address only valid findings**

For a valid behavior/security issue:

1. Add a failing contract test.
2. Observe RED under Node 24.12.
3. Apply the minimum fix.
4. Re-run the complete validation set.
5. Reply with commit and evidence.
6. Resolve the thread and request one final review.

**Step 6: Final verification**

Expected final state:

- PR open and mergeable.
- Latest Codex review has no unresolved material finding.
- Remote head equals local head.
- Working tree is clean.

---

## Follow-up plan after PR #25

Create a separate branch for an 8–12-case role scorecard. Use public/synthetic fixtures and record only aggregate outcome metrics so full transcripts can remain disabled:

- researcher citation/version accuracy;
- mapper execution-path and change-surface precision;
- builder first-pass verification, out-of-scope files, patch size, repair rounds;
- reviewer seeded-defect recall and false-blocker rate;
- end-to-end duration, model, turns/tool calls/tokens, and human interventions.

Run each model/prompt candidate on the same frozen tasks. Promote one change at a time only when it improves outcomes without expanding authority.

## Risks and trade-offs

- **Research composition cost:** Web-only Ciung requires the parent to combine its public evidence with Laya's repository findings. This is intentional separation, not duplication.
- **Reduced convenience from fresh context:** `inherit_context: false` increases task-packet discipline but avoids accidental conversation disclosure and stale assumptions.
- **Model fallback:** Native unavailable frontmatter pins can inherit the parent. The required `/agents` smoke check detects this but does not make native behavior fail closed.
- **Model scope is not policy:** Strict enforcement across pins, inheritance, RPC, and schedules would require a separate wrapper; defer until there is a real compliance requirement.
- **Skill shadowing:** Project skills can override same-named global skills. Continue using the team only in reviewed/trusted repositories; evaluate removing skill dependencies later with scorecard evidence.
- **Prompt overfitting:** Keep deliverable contracts compact and test representative behavior. Do not prescribe every reasoning step.

## Acceptance criteria

- All four templates explicitly set `inherit_context: false`.
- Ciung has only the two approved 9router tools and no local built-ins.
- No canonical template has a `model:` pin.
- Documentation teaches inheritance, per-invocation selection, optional persistent pins, exact IDs, precedence, fallback, and scope caveats.
- Coordinator task packets and reviewer evidence packets are concrete and copyable.
- Parent-builder repair is bounded and parent-owned.
- Role prompts contain clear stopping conditions and evidence schemas.
- All tests and the exact v0.14.3 loader probe pass under NVM Node `v24.12.0`.
- PR #25 contains updated validation evidence and has no unresolved material review findings.
