# Goal Loop Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repo-stored Pi extension template that adds a Codex/Claude-style `/goal` command with project-scoped state and auto-continue behavior.

**Architecture:** The extension lives under `pi/extensions/goal-loop/` and uses Pi's extension API to register commands, inject goal guidance before agent runs, evaluate status after turns, and call `sendUserMessage` for controlled continuation. Pure state/evaluator helpers are exported from `index.ts` and covered with Node tests.

**Tech Stack:** TypeScript, Pi extension API, Node.js built-in test runner, JSON state under `~/.pi/agent/goal-loop/state.json`.

---

### Task 1: Core State And Command Helpers

**Files:**
- Create: `pi/extensions/goal-loop/index.test.ts`
- Create: `pi/extensions/goal-loop/index.ts`
- Create: `pi/extensions/goal-loop/package.json`

- [ ] **Step 1: Write failing helper tests**

```bash
node --test pi/extensions/goal-loop/index.test.ts
```

Expected: FAIL because `index.ts` does not exist yet.

- [ ] **Step 2: Implement helper functions**

Add state shape, command parsing, project keys, evaluator decisions, and continuation prompt generation.

- [ ] **Step 3: Run helper tests**

```bash
node --test pi/extensions/goal-loop/index.test.ts
```

Expected: PASS.

### Task 2: Pi Extension Runtime

**Files:**
- Modify: `pi/extensions/goal-loop/index.ts`

- [ ] **Step 1: Register `/goal` commands**

Implement `start`, `status`, `pause`, `resume`, `clear`, `edit`, and `verify` behavior in `pi.registerCommand("goal", ...)`.

- [ ] **Step 2: Add lifecycle hooks**

Use `before_agent_start` to inject active goal instructions and `agent_end` to evaluate and auto-continue with `pi.sendUserMessage`.

- [ ] **Step 3: Run tests**

```bash
node --test pi/extensions/goal-loop/index.test.ts
```

Expected: PASS.

### Task 3: Documentation

**Files:**
- Create: `pi/extensions/goal-loop/README.md`
- Modify: `README.md`

- [ ] **Step 1: Document local install and commands**

Document copy command, `/reload`, command surface, state path, and current limitations.

- [ ] **Step 2: Update root README**

Add the extension to the setup description and template-copy instructions without changing required external package installs.

- [ ] **Step 3: Validate docs**

Run a Markdown sanity check and inspect the diff.
