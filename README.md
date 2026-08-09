# My Pi Setup

An installable first-party Pi package plus a reviewed companion-package manifest: themes, local extensions, MCP, memory, context compression, subagents, skills, and operational guardrails.

![Pi setup home screen](docs/images/pi-home.png)

## What this package provides

| Area | Included |
| --- | --- |
| Core agent | Pi coding agent with provider login through `/login` |
| Theme/UI | `irfan-sumi`, `irfan-pi`, alternate themes, Command Deck, and Pi Signature |
| MCP | MCP adapter plus Tavily, Exa, Brave Search, OAuth, and bearer patterns |
| Delegation | Ciung research, Laya code mapping, Sangkur worktree builds, and Prabu review |
| Guardrails | Permission gates, todos, persisted goals, and prompt loops |
| Context | `context-mode` and local Headroom compression/retrieval |
| Memory | Local Hindsight adapter and generated managed skills |
| Side questions | Local `/btw` channel while the main agent works |
| Routing | `pi-9router-ext` model/search routing tools |
| Operations | Markdown preview, usage stats, and Caveman response mode |
| Skills | Setup, MCP, context-mode, and optional workflow skills |

### `irfan-sumi` preview

![Pi using the minimalist irfan-sumi theme](docs/images/irfan-sumi-preview.png)

`irfan-sumi` is the fresh-install setup default: warm, quiet, and compact. Package installation does not rewrite `~/.pi/agent/settings.json`; changing an existing device's selected theme requires explicit approval. See [Configuration](docs/setup/configuration.md#theme-and-signature-ui).

## Repository layout

```text
package.json                  # Pi resources + exact companion package metadata
pi/
  agents/                     # reviewed templates; deployed separately
  themes/                     # irfan-sumi, irfan-pi, and alternates
  extensions/                 # repo-owned package extensions
skills/pi-setup/              # bundled audit and migration skill
docs/setup/                   # setup and operations guides
```

Pi loads declared extensions, themes, and skills from the installed package. Do not copy the whole `pi/` directory—or individual package resources—into `~/.pi/` for a normal install.

## Fresh-machine bootstrap

Prerequisites: Node.js `>=22.19.0`, Pi `>=0.84.1`, npm, Git, optional `pipx` or `uv`, and provider credentials supplied through `/login` or environment variables.

```bash
# 1) Install Pi
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g @earendil-works/pi-coding-agent

# 2) Install one reviewed pi-setup release
pi install git:github.com/irfansofyana/pi-setup@v0.1.0

# 3) Start Pi
pi
```

Use the reviewed release tag you intend to run. Inside Pi:

```text
/login
/pi-setup-init
/pi-setup-doctor
```

`/pi-setup-init` queues the bundled skill's audit/proposal prompt; `/pi-setup-doctor` queues a strictly read-only health audit. Neither command mutates files or settings directly. On a fresh device, init proposes the required companion packages and `irfan-sumi`, then waits for numbered approval.

## Existing-device migration

The same package command is non-destructive: the package has no postinstall settings migration and does not overwrite existing settings, config, state, memory, generated skills, logs, or secrets.

After installing the tagged package, ask Pi:

```text
/pi-setup-init
```

The migration workflow must:

1. Inventory `pi list`, legacy manual extensions/themes, global/project config, and selected theme.
2. Verify the separately managed companion packages below and propose only missing or version-drifted installs.
3. Distinguish duplicate loaders from user-owned config/state directories.
4. Present numbered actions with private backups, rollback, and reload impact.
5. Remove only explicitly approved duplicates after first-party resources are verified.
6. Preserve the current theme unless a separate theme proposal is approved.
7. Re-audit after changes and report unresolved or blocked items.

Global subagent templates still require reviewed, skill-managed deployment to `~/.pi/agent/agents/`; Pi package resources do not natively include agents. Full procedure: [Installation](docs/setup/installation.md#existing-device-migration) and [Subagent team](docs/setup/subagents.md).

<a id="required-npm-package-manifest"></a>

## Required companion packages

The root `piSetup.requiredPackages` metadata is canonical. These packages are installed as separate Pi package sources by the approval-gated setup skill; the first-party package does not absorb their lifecycle scripts or resource paths.

| Package | Version | Purpose |
| --- | --- | --- |
| `@gotgenes/pi-permission-system` | `24.0.0` | Approval gates |
| `@juicesharp/rpiv-ask-user-question` | `2.4.0` | Structured questions |
| `@juicesharp/rpiv-todo` | `2.4.0` | Task tracking |
| `@tintinweb/pi-subagents` | `0.14.3` | Delegated agent workflows |
| `context-mode` | `1.0.169` | Context-saving tools and skills |
| `pi-9router-ext` | `0.2.3` | Model/search routing |
| `pi-markdown-preview` | `0.11.3` | Markdown render/export |
| `pi-mcp-adapter` | `2.21.1` | Standard MCP config and tools |
| `pi-stats-ext` | `0.2.0` | Usage statistics |

Use `pi list` to inspect package sources. These companion packages remain separate Pi-managed sources by design; their presence is expected, not a duplicate of the first-party package.

## Configuration scope summary

| Path | Scope | Purpose |
| --- | --- | --- |
| Installed first-party package | Pi-managed | Repository-owned extensions, themes, and skills |
| Required companion packages | Pi-managed | MCP, permissions, context mode, subagents, routing, and utility extensions |
| `~/.pi/agent/settings.json` | Global user | Theme and Pi settings |
| `~/.pi/agent/extensions/` | Global user | Legacy/manual loaders and extension-local policy |
| `~/.pi/agent/agents/` | Global user | Trusted reusable subagent roles |
| `~/.pi/agent/subagents.json` | Global user | Subagent defaults |
| `~/.pi/agent/headroom/config.json` | Global user | Headroom adapter config |
| `~/.pi/agent/hindsight/config.json` | Global user | Hindsight daemon config |
| `~/.pi/agent/managed-skills/` | Global user | Generated skills |
| `~/.pi/agent/btw/config.json` | Global user | BTW config |
| `~/.pi/agent/goal-loop/` | Global user | Goal config, state, archive, logs |
| `~/.config/mcp/mcp.json` | Global shared | Preferred shared MCP config |
| `~/.pi/agent/mcp.json` | Global Pi | Pi-specific MCP override |
| `.mcp.json` | Project-local | Project MCP servers |

Package updates replace package-owned code, not user-owned configuration. Preserve unknown keys during approved config edits. Never commit credentials; use `/login`, environment variables, or provider profiles.

## Topic guides

| Guide | Contents |
| --- | --- |
| [Installation](docs/setup/installation.md) | Package install, fresh setup, migration, rollback |
| [Configuration](docs/setup/configuration.md) | Ownership, paths, auth, themes, signature UI |
| [MCP](docs/setup/mcp.md) | Global/project config, search, OAuth, bearer auth |
| [Permissions](docs/setup/permissions.md) | Global approval policy and migration notes |
| [Subagent team](docs/setup/subagents.md) | Team roles, reviewed deployment, trust boundary |
| [Local extensions](docs/setup/local-extensions.md) | Component behavior and user-owned config/state |
| [Using Hindsight day to day](docs/setup/hindsight-daily-use.md) | Memory scopes, tools, and hygiene |
| [Skills and tools](docs/setup/skills-and-tools.md) | `npx skills`, Understand-Anything, Notion CLI |
| [Operations](docs/setup/operations.md) | Verification, updates, rollback, troubleshooting |

## Setup skill safety model

- Audit is read-only and classifies package resources, duplicate loaders, config, and state.
- Every mutation requires explicit proposal-number approval.
- Targets are re-read before mutation; unexpected drift stops the workflow.
- Approved removal candidates receive private backups and rollback steps.
- Settings/config/state/secrets are never package-overwritten.
- Existing theme changes are separate optional proposals.
- Missing or version-drifted companions are changed only after approval.

## Core operating rules

- Install the first-party package from a reviewed Git tag.
- Install the nine required companions as separate Pi package sources through the approval-gated setup skill.
- Do not manually copy package-owned extensions, themes, or bundled skills.
- Install unrelated skills with `npx skills` or `npx skills@latest`.
- Deploy reviewed global agent templates through the bundled skill because agents are not package resources.
- Keep credentials in `/login`, environment variables, or provider profiles.
- Preserve user-owned config/state and unknown keys.
- Back up before approved mutation and stop on unexpected drift.
- Run `/reload` after package, extension, theme, MCP, permission, or skill changes.

## Minimal verification

From shell:

```bash
pi --version
pi list
```

Inside Pi:

```text
/reload
/mcp
/mcp tools
/agents
/settings
```

Confirm the first-party package and companion package sources, expected commands/tools/skills/themes, current selected theme, and permission prompts. Existing devices should also confirm that no command or tool is registered twice. See [Operations](docs/setup/operations.md).

## Updating setup

```bash
pi update
pi update --extensions
pi list
```

Use reviewed release tags for reproducible installs. An update changes package-owned resources only; configuration migration remains proposal-driven. Run `/reload` or restart Pi, verify, and retain migration backups until the setup is accepted.
