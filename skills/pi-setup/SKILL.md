---
name: pi-setup
description: Audit, set up, install, repair, migrate, or verify a Pi coding-agent environment. Use whenever user asks to inspect Pi configuration, bootstrap Pi on a machine, reconcile installed state with this repository, repair extensions or tools, migrate global/project config, or verify setup health.
---

# Pi Setup

Use repository documentation as source of truth. Audit first, propose exact changes, and mutate only after explicit approval.

## 1. Locate documentation root

Locate repository root without assuming username or absolute path:

1. Start from current working directory and walk upward.
2. Prefer nearest directory containing `AGENTS.md`, `README.md`, `docs/setup/`, and `pi/`.
3. If inside Git worktree, use worktree root only when it contains those markers.
4. If current path fails, inspect ancestors of this skill's resolved location.
5. If no matching root exists, ask user for repository path and stop. Do not mutate environment.

Call located directory `REPO_ROOT`. Resolve all documentation and template paths from it.

## 2. Load source of truth

Before auditing:

1. Read `REPO_ROOT/AGENTS.md`.
2. Read `REPO_ROOT/README.md`, including canonical package manifest and scope summary.
3. Read only relevant topic docs:
   - installation: `docs/setup/installation.md`
   - paths/auth/theme: `docs/setup/configuration.md`
   - MCP: `docs/setup/mcp.md`
   - permissions: `docs/setup/permissions.md`
   - local extensions: `docs/setup/local-extensions.md`
   - skills/tools: `docs/setup/skills-and-tools.md`
   - verification/troubleshooting: `docs/setup/operations.md`

Do not copy detailed commands into this skill. Execute commands from owning documentation.

## 3. Establish scope

Distinguish every target explicitly:

- **Global Pi:** files under `~/.pi/agent/`.
- **Global shared MCP:** `~/.config/mcp/mcp.json`.
- **Project-local:** `.mcp.json` and project-owned files under target project root.
- **Repository source:** templates and documentation under `REPO_ROOT`; not installed state.

Ask which machine, user home, and project root apply when ambiguous. Never treat repository examples as active configuration automatically.

## 4. Run read-only audit

Perform no installs, writes, copies, removals, logins, daemon starts, or config mutations.

Audit relevant surfaces with read-only checks:

- Pi availability/version and `pi list`.
- Required npm package sources against exact README manifest.
- Expected local template presence and source/destination drift.
- Global versus project MCP files and server definitions.
- Permission policy path and intent.
- Theme selection and signature extension.
- Headroom, Hindsight, managed-skills, goal-loop, prompt-loop, BTW, and Caveman files/config.
- Requested skills and optional tools.
- Credential references and required environment variable names without printing values.

Redact values for keys/tokens/passwords/auth headers. Never read or display credential stores unless user explicitly requests safe metadata inspection.

Classify each audited item:

- `compliant`: matches documented required state.
- `missing`: required item absent.
- `drifted`: present but differs from documented intended state.
- `optional`: documented but not required for requested scope.
- `blocked`: cannot verify safely due to access, missing dependency, ambiguity, or credential requirement.

Report evidence paths and commands, but never secret values.

## 5. Propose before mutation

Present numbered proposal. For each proposed change include:

1. Classification and evidence.
2. Exact target scope/path.
3. Intended action and source documentation.
4. Risk or service impact.
5. Backup plan, private backup location, retention, and cleanup.
6. Rollback command or restoration steps.
7. Whether `/reload`, shell restart, daemon restart, or Pi restart is required.

Separate required repairs from optional improvements. Ask user to approve specific proposal numbers. Silence, broad intent from earlier prompt, or approval of audit does not count as mutation approval.

## 6. Apply approved changes only

After explicit approval:

1. Re-read each target immediately before changing it.
2. Stop and report if target changed since audit or unexpected drift appears.
3. Back up existing file/directory before replacement. Store backups outside repository in a user-only location, set restrictive permissions (`umask 077` or equivalent), never print secret-bearing content, and avoid copying credential stores unless rollback requires it.
4. Apply only approved proposal numbers.
5. Preserve unknown config keys and unrelated entries. Merge narrowly; do not replace whole config when targeted edit works.
6. Install npm Pi packages only by executing exact canonical commands read from README manifest.
7. Install skills only with documented `npx skills` or `npx skills@latest` commands. Never manually copy installed skill files.
8. Copy repo-owned local extensions only from documented template paths.
9. Never expose, generate, or write credentials. Ask user to use `/login`, environment variables, or provider profile config.
10. Verify each mutation before starting the next one. If verification fails, restore that mutation from backup when restoration is safe and deterministic. If rollback could lose data or fails, stop, mark the item `blocked`, and ask the user before further action.
11. Stop on command failure, validation failure, permission denial, or undocumented state. Do not continue with later mutations until user reviews impact.

## 7. Re-audit and report

Repeat relevant read-only checks after mutation. Reclassify all selected items and report:

- approved changes applied and skipped;
- final `compliant`/`missing`/`drifted`/`optional`/`blocked` status;
- verification commands and results;
- backup paths;
- exact rollback steps;
- unresolved drift or manual credential/auth work;
- required `/reload` or restart action.

Always tell user to run `/reload` after extension, theme, MCP, permission, skill, or related config changes. If verification cannot complete, say why and leave item `blocked`; do not claim success.
