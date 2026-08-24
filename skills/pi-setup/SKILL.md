---
name: pi-setup
description: Audit, propose, and safely migrate Pi installations to this package without overwriting existing settings, config, state, or secrets.
---

# Pi Setup

Use this repository's documentation as source of truth. Audit first, present numbered proposals, and mutate only explicitly approved proposal numbers.

## 1. Locate the installed package root

Locate the package root without assuming a username, checkout, or absolute path:

1. Resolve this skill's own location and walk upward.
2. Select the nearest directory containing `package.json`, `AGENTS.md`, `README.md`, `docs/setup/`, `pi/extensions/`, and `pi/themes/`.
3. Confirm root `package.json` has package name `@irfansofyana/pi-setup` and a `pi` manifest.
4. If invoked from a source checkout, it may be the root only when all markers match.
5. If no matching root exists, ask for the installed package or repository path and stop without mutation.

Call the verified directory `PACKAGE_ROOT`. Resolve all docs and templates from it.

## 2. Load source of truth

Before auditing:

1. Read `PACKAGE_ROOT/package.json` for exact companion sources in `piSetup.requiredPackages`, package resources, and setup metadata.
2. Read `PACKAGE_ROOT/AGENTS.md` and `PACKAGE_ROOT/README.md`.
3. Read only relevant topic docs:
   - package install and migration: `docs/setup/installation.md`
   - paths, ownership, auth, theme: `docs/setup/configuration.md`
   - MCP: `docs/setup/mcp.md`
   - permissions: `docs/setup/permissions.md`
   - global agents: `docs/setup/subagents.md`
   - component behavior/config: `docs/setup/local-extensions.md`
   - optional skills/tools: `docs/setup/skills-and-tools.md`
   - verification/rollback: `docs/setup/operations.md`

The package owns `/pi-setup-init` and `/pi-setup-doctor` as thin prompt adapters into this skill. Do not invent any other lifecycle commands. Use exact commands from owning docs and live Pi help/state. If a supported install, update, or removal action cannot be established, classify that mutation `blocked`.

## 3. Establish scope and ownership

Distinguish every target:

- **Package-owned:** repository code, themes, and skills loaded from the installed first-party package.
- **Companion package-owned:** the separate Pi package sources pinned by `piSetup.requiredPackages`.
- **Global user-owned:** settings, manual loaders, agents, component config/state/logs, generated skills, and Pi-specific MCP under `~/.pi/agent/`.
- **Global shared MCP:** `~/.config/mcp/mcp.json`.
- **Project-local:** `.mcp.json` and trusted project-owned Pi files.
- **External services:** provider auth, Headroom CLI/proxy, Hindsight profiles/daemon, and other tools not installed by the Pi package.

Package ownership never implies ownership of similarly named user config/state directories. Ask which machine, home, and project root apply only when genuinely ambiguous.

## 4. Run a read-only audit

Perform no installs, writes, copies, moves, removals, logins, daemon starts, theme changes, or config mutations.

Audit relevant surfaces:

- Pi availability/version and `pi list` package sources.
- First-party package presence and declared resources against `package.json`.
- Presence and installed source/version of every separately managed package in `piSetup.requiredPackages`.
- Known legacy manual extension files/directories under `~/.pi/agent/extensions/`, including same-command or same-tool registrations.
- Potential custom-editor claimants among enabled, resolved package entrypoints. Inspect effective load order plus runtime feature/config evidence. Report static `setEditorComponent()` matches as potential claimants; call them effective owners only when proven, otherwise classify ownership as `blocked`. Never reorder packages during audit.
- Manually copied package themes under `~/.pi/agent/themes/`.
- Selected theme and unrelated settings in `~/.pi/agent/settings.json`.
- Component config/state for Headroom, Hindsight, managed skills, Goal Loop, Prompt Loop, BTW, Caveman, permissions, and MCP.
- Trusted global subagent templates and `subagents.json`; remember package resources do not natively include agents.
- Requested optional skills/tools and external service prerequisites.
- Credential variable names/references without reading or printing values.

Compare resource identity and effective loading, not names alone. A legacy code directory may contain nested user config/state; identify those separately before proposing any removal.

Classify every item:

- `compliant`: package, companion, or user-owned state matches documented intent.
- `missing`: required resource or config absent.
- `duplicate`: first-party package resource and a legacy/manual loader are both active.
- `drifted`: present but differs from intended approved state.
- `optional`: documented but not required for requested scope.
- `blocked`: cannot verify or change safely because of ambiguity, access, credentials, missing dependency, or unknown lifecycle command.

Report paths, package sources, and redacted evidence. Never display credential values or inspect credential stores unless the user explicitly requests safe metadata inspection.

## 5. Determine fresh versus existing theme behavior

Treat `piSetup.defaultTheme` in `package.json` as desired setup metadata, not permission to mutate settings.

- If no existing settings/theme choice exists, classify the device as fresh for theme purposes and propose the manifest default.
- If any theme is already selected, preserve it. Offer a switch to `irfan-sumi` only as a separate optional proposal.
- Never replace the whole settings file to change the theme; preserve every unrelated key.

## 6. Present numbered proposals

For each mutation include:

1. classification and evidence;
2. exact scope, package source, or path;
3. intended narrow action and source documentation;
4. why any replacement resource is equivalent and already verified;
5. risk or service impact;
6. private backup location, permissions, retention, and cleanup;
7. exact rollback steps;
8. required `/reload`, shell restart, daemon restart, or Pi restart.

Separate proposal groups:

- required first-party package verification;
- missing or version-drifted companion package installation/update;
- duplicate legacy manual loader cleanup;
- optional settings/config changes, including theme;
- global subagent template deployment;
- external service setup requiring manual auth/credentials.

Ask the user to approve specific proposal numbers. General setup intent, package installation, or audit approval is not mutation approval.

## 7. Apply approved changes only

For each approved proposal, one at a time:

1. Re-read the target and package source immediately before changing it.
2. Stop if it changed since audit or new ambiguity appears.
3. Verify the first-party package replacement is loaded before removing a manual duplicate.
4. Create a private backup outside the repository with restrictive permissions (`umask 077` or equivalent). Avoid credential stores and secret-bearing content unless essential for exact rollback.
5. Apply only the approved narrow action.
6. Preserve settings, unknown config keys, state, archives, logs, memory, generated skills, and unrelated entries.
7. Remove legacy manual code/theme loaders only when they are proven duplicates. Never remove a component config/state directory merely because code is now package-owned.
8. Keep companion packages as separate Pi-managed sources. Install or update only an explicitly approved exact source; never remove one as a first-party-package duplicate.
9. For global agents, follow `docs/setup/subagents.md`: review templates, back up existing files, preserve machine-local model choices unless approved, and merge `subagents.json` narrowly.
10. Never expose, generate, copy, or write credentials. Ask the user to complete `/login`, environment, or provider-profile steps.
11. Reload/restart and verify this mutation before continuing. On failure, restore only its approved legacy loader when rollback is safe and deterministic; never overwrite newer user data with stale config.
12. Stop on command failure, validation failure, permission denial, or undocumented state.

## 8. Re-audit and report

Repeat relevant read-only checks and report:

- approved proposals applied, skipped, restored, or blocked;
- final `compliant`/`missing`/`duplicate`/`drifted`/`optional`/`blocked` status;
- package sources and verification results;
- confirmation that user settings/config/state/secrets were preserved;
- private backup paths, retention, and exact rollback steps;
- unresolved duplicates, custom-editor conflicts, or manual auth/service work;
- selected theme and whether it changed by explicit approval;
- required `/reload` or restart action.

Do not claim success when verification is incomplete. Keep backups until the user accepts the migrated setup.

## Safety invariants

- Package install is not migration approval.
- Existing files are preserved by default.
- Duplicate detection precedes duplicate removal.
- Backup precedes every approved destructive action.
- Existing theme selection never changes implicitly.
- Agent templates never become active merely because the package is installed.
- Unknown commands or ambiguous ownership fail closed.
- Credential values never appear in audit, proposal, backup output, or report.
