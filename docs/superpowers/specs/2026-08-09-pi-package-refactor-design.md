# Pi Package Refactor Design

**Date:** 2026-08-09
**Status:** Implemented on `refactor/pi-package`; pending review
**Scope:** Package installation, documentation, and safe migration of existing Pi devices

## Summary

Turn this repository into one installable Pi package. A tagged release is installed with:

```bash
pi install git:github.com/irfansofyana/pi-setup@v0.1.0
```

The root Pi manifest exposes only repository-owned extensions, themes, and skills. **Separately managed companion packages** are pinned in `piSetup.requiredPackages` and installed by the setup skill after approval. This keeps third-party ownership, lifecycle scripts, and updates outside the first-party package. Fresh installations use `irfan-sumi` as setup metadata default. Installation itself remains non-destructive: it has no postinstall mutation and does not rewrite Pi settings, configuration, state, or secrets.

Existing devices migrate through the bundled `pi-setup` skill. The skill audits first, identifies duplicate legacy resources, presents a numbered proposal with backups and rollback, and changes only explicitly approved items. Global subagent templates remain a separate skill-managed deployment because Pi package resources do not natively include agents.

## Problem

The previous setup was manual-copy-first:

- install nine Pi packages separately;
- clone the repository and install the setup skill separately;
- copy each repository-owned extension and theme into `~/.pi/agent/`;
- re-copy templates after repository updates;
- separately deploy global subagent templates.

This creates avoidable drift and duplicate registration risk for repository-owned resources. Direct copy instructions also encourage replacement of local state-bearing directories and make upgrades hard to distinguish from configuration migration. Companion packages have a different concern: missing or unreviewed version drift.

## Goals

1. Make one tagged GitHub Pi package install the normal fresh-machine path.
2. Expose all repository-owned extensions, themes, and the `pi-setup` skill from the package.
3. Record the nine exact canonical companion package sources without absorbing them as npm dependencies.
4. Preserve all existing settings, config, state, and secrets during installation.
5. Give existing devices an audit-first, approval-gated migration path.
6. Detect legacy manual extension copies plus missing or version-drifted companion packages.
7. Back up removal candidates privately and remove them only after explicit approval.
8. Keep global subagent template deployment reviewed, backup-backed, and skill-managed.
9. Make `irfan-sumi` the fresh-install setup default without silently changing an existing theme.

## Non-goals

- A postinstall script that mutates user files.
- Automatic deletion of legacy resources.
- Automatic credential, provider, MCP, daemon, or permission configuration.
- Direct mutation inside setup commands; `/pi-setup-init` and `/pi-setup-doctor` only queue bounded prompts into the bundled skill.
- Native package deployment of `pi/agents/`; Pi packages do not currently declare agent resources.
- Replacing component-specific operational documentation.

## Package contract

The root package is `@irfansofyana/pi-setup`. Its Pi manifest declares:

- repository-owned `pi/extensions/pi-signature.ts`;
- repository-owned `pi/themes/irfan-sumi/index.ts` integrated editor;
- repository-owned `pi/extensions/*/index.ts` resources;
- repository-owned `skills/`;
- repository-owned `pi/themes/*.json` plus `pi/themes/irfan-sumi/theme.json`;
- `piSetup.defaultTheme: "irfan-sumi"` as setup metadata.
- `piSetup.requiredPackages` as the exact companion-package manifest.

The package requires Node.js `>=22.19.0` and Pi `>=0.84.1`.

The exact separately managed companion packages are:

| Package | Version |
| --- | --- |
| `@gotgenes/pi-permission-system` | `24.0.0` |
| `@juicesharp/rpiv-ask-user-question` | `2.4.0` |
| `@juicesharp/rpiv-todo` | `2.4.0` |
| `@tintinweb/pi-subagents` | `0.14.3` |
| `context-mode` | `1.0.169` |
| `pi-9router-ext` | `0.2.3` |
| `pi-markdown-preview` | `0.11.3` |
| `pi-mcp-adapter` | `2.21.1` |
| `pi-stats-ext` | `0.2.0` |

The package has no `postinstall` settings migration and no third-party npm dependencies. Pi owns first-party package installation and loading; the setup skill manages companion Pi package sources after approval, while user-owned files remain separate.

## Fresh-install flow

1. Install Pi and authenticate through `/login` or environment variables.
2. Install a reviewed release tag with the single GitHub package command.
3. Start or reload Pi.
4. Ask Pi to use the bundled `pi-setup` skill to audit and propose setup.
5. Approve only desired proposal numbers, including missing companion package installs.
6. The skill treats absent settings as a fresh setup and proposes `irfan-sumi`; it does not write the theme before approval.
7. Configure optional external services such as Headroom or Hindsight separately.
8. Review and approve deployment of global subagent templates if wanted.

A release tag is required in user-facing examples so installation is reproducible. Documentation must not imply that cloning or manual extension copies are part of the normal install.

## Existing-device migration

### Phase 1: Non-destructive package install

Installing the first-party package does not overwrite global Pi files. Existing settings, config, state, managed skills, memory, logs, and credentials remain where they are. The package may temporarily coexist with legacy copies until the audit is approved.

### Phase 2: Read-only inventory

The bundled skill inventories:

- `pi list` package sources;
- installed state and versions of the nine required companion packages;
- known manual extension files/directories under `~/.pi/agent/extensions/`;
- manual theme files under `~/.pi/agent/themes/`;
- selected theme and unrelated settings in `~/.pi/agent/settings.json`;
- component config/state directories under `~/.pi/agent/`;
- global and project MCP configuration;
- trusted global subagent templates and `subagents.json`;
- credential variable names and references without revealing values.

The audit compares identity and load behavior, not names alone. A same-named directory containing user config or state is not automatically disposable.

### Phase 3: Numbered proposal

Each candidate change states:

- evidence and classification;
- exact path or package source;
- whether it is a duplicate loader, user-owned config/state, or unrelated item;
- proposed action;
- private backup location and retention;
- rollback steps;
- reload/restart impact.

Required deduplication is separated from optional configuration changes. Theme selection is always a separate proposal on an existing device.

### Phase 4: Approval-gated migration

After explicit proposal-number approval, the skill re-reads targets, stops on drift, creates a private backup, and removes only approved manual duplicate loader entries. It must not delete component config/state directories merely because an extension is now package-owned. Companion packages remain separate; missing or version-drifted entries are installed or updated only through approved proposals.

If the exact package-install or update mechanism cannot be established from current Pi state and documentation, the item remains blocked rather than guessing a command.

### Phase 5: Verification and rollback

Reload or restart Pi, then verify package sources, commands, tools, skills, themes, and component state. Keep backups until the user accepts verification. If a component fails, restore only its approved legacy loader and report the first-party package state; never restore stale settings over newer user data.

## Resource ownership after migration

| Resource | Owner after migration | Migration rule |
| --- | --- | --- |
| Repo extensions | Aggregate Pi package | Back up/remove approved manual loader duplicates only |
| Repo themes | Aggregate Pi package | Back up/remove approved manual file duplicates; preserve selected theme unless approved |
| Nine companion packages | Separate Pi-managed package sources | Install/update exact reviewed sources after approval; do not treat them as aggregate duplicates |
| Pi settings | User | Narrow merge only; never package-overwrite |
| Extension config/state/logs | User | Preserve in place |
| MCP configuration | User/project | Preserve and merge only by approved proposal |
| Credentials/provider auth | User/provider | Never copy, print, or migrate automatically |
| Global agents | User, deployed from reviewed templates | Skill-managed backup-and-deploy; not a package resource |

## Theme behavior

`irfan-sumi` is the desired default for a fresh setup and is recorded in package metadata. This metadata is not permission to rewrite `~/.pi/agent/settings.json`.

- If no existing theme choice exists, the skill proposes `irfan-sumi` as the fresh default.
- If a theme is already selected, it remains selected unless the user explicitly approves the theme proposal.
- Rollback changes only the theme field or uses `/settings`; other settings are preserved.

## Subagent exception

Pi package manifests expose extensions, skills, and themes, but not agent templates. Therefore `pi/agents/*.md` and the desired `subagents.json` values remain intentionally outside automatic package loading.

The bundled skill must:

1. inspect installed global agents and settings;
2. show template diffs and trust implications;
3. propose exact files/keys;
4. back up current files privately;
5. deploy or merge only approved items;
6. preserve machine-local model choices unless their replacement is approved.

## Documentation architecture

- `README.md`: first-party package install, companion-package inventory, fresh/existing paths, scope summary, topic index.
- `docs/setup/installation.md`: detailed package install and safe migration lifecycle.
- `docs/setup/configuration.md`: package-owned resources versus user-owned config/state and theme approval.
- `docs/setup/local-extensions.md`: runtime/config behavior; package ownership instead of manual copy procedures.
- `docs/setup/operations.md`: update, deduplication checks, verification, rollback.
- `docs/setup/subagents.md`: existing reviewed template deployment procedure remains authoritative.
- `skills/pi-setup/SKILL.md`: procedural audit/proposal/approval/migration workflow, referencing owning docs rather than duplicating commands.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Duplicate commands/tools after package install | Audit manual first-party loaders; approval-gated deduplication |
| Loss of local state during cleanup | Distinguish loaders from config/state; private backup before approved removal |
| Existing theme silently changes | No postinstall mutation; separate theme proposal and approval |
| Companion version drift | Exact sources in root metadata, `pi list` audit, and approval-gated updates |
| Untrusted agent definitions gain authority | Agents remain reviewed, global, skill-managed deployment |
| Secrets appear in audit output or backups | Inspect names/references only, redact values, avoid credential stores |
| Guessed Pi lifecycle commands | Use documented commands only; block when exact removal action is unknown |

## Acceptance criteria

- Fresh-install docs lead with one tagged `pi install git:...` command.
- No normal install guide asks users to copy repo extensions or themes manually.
- The nine exact companion sources and versions match `piSetup.requiredPackages`.
- Documentation states that install does not overwrite settings/config/state/secrets.
- Existing-device guidance detects legacy manual loaders and missing/version-drifted companion packages.
- Cleanup requires explicit proposal-number approval and private backups.
- Existing themes remain unchanged without explicit approval.
- `irfan-sumi` is documented as fresh-install default metadata.
- Global agent templates remain skill-managed and are not claimed as package resources.
- `/pi-setup-init` and `/pi-setup-doctor` exist, are tested, and delegate to the bundled skill without granting mutation approval.
- README remains within its 180–250 line repository limit.
