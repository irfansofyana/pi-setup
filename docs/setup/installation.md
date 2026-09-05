# Installation

Install this repository as one first-party Pi package. It declares repository-owned extensions, themes, and skills. The exact [required companion packages](../../README.md#required-npm-package-manifest) remain separate Pi package sources and are installed by the setup skill only after approval.

## Prerequisites

- Node.js `>=22.19.0` and npm on `PATH`
- Git
- Pi coding agent `>=0.84.1`
- `pipx` or `uv` for optional Headroom/Hindsight helper tools
- Provider credentials through `/login`, environment variables, or provider profiles

## Install Pi

```bash
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g @earendil-works/pi-coding-agent
```

Verify:

```bash
pi --version
```

## Install the package

Install a reviewed release tag:

```bash
pi install git:github.com/irfansofyana/pi-setup@v0.5.3
```

Replace `v0.5.3` with a newer release only after reviewing it. One install provides:

- all declared repository extensions under `pi/extensions/`;
- all themes under `pi/themes/`;
- the bundled `pi-setup` skill;
- metadata listing the exact ten companion package sources for the setup skill.

Do not clone the repository, install the setup skill separately, or copy package resources into `~/.pi/agent/` for a normal fresh setup. Companion packages are installed separately because they retain independent ownership, updates, and lifecycle scripts.

Inspect the source after installation:

```bash
pi list
```

Then start Pi and reload:

```bash
pi
```

```text
/reload
```

## Fresh setup

Inside Pi, authenticate and run the package commands:

```text
/login
/pi-setup-init
/pi-setup-doctor
```

`/pi-setup-init` queues the bundled skill's setup/migration prompt. `/pi-setup-doctor` queues a strictly read-only audit. The commands do not mutate files or settings directly. `irfan-sumi` is the package's fresh-install setup metadata default; init should classify an absent theme selection as fresh, propose missing companion package installs and `irfan-sumi`, then wait for approval.

For an approved companion proposal, the skill runs `pi install <source>` using the value from `piSetup.requiredPackages`, one source at a time, and verifies it with `pi list`. Companion requirements are minimum versions documented by this repository; any installed version at or above minimum satisfies the audit. Use unversioned npm source for new installs so Pi resolves a current release. It must not silently replace a different installed source.

Continue with the relevant proposals and topic docs:

- [Configuration](configuration.md)
- [MCP](mcp.md)
- [Permissions](permissions.md)
- [Subagent team](subagents.md)
- [Local extensions](local-extensions.md)
- [Skills and tools](skills-and-tools.md)

## Existing-device migration

Installing the first-party package is non-destructive. It does not overwrite:

- `~/.pi/agent/settings.json`;
- extension configuration, state, archives, logs, memory, or generated skills;
- global or project MCP configuration;
- provider auth or credential stores;
- global subagent templates.

The first-party package can initially coexist with legacy resources. That coexistence is for audit and rollback, not the desired final state: duplicate extension loaders may register the same commands or tools.

### 1. Capture current state

Before installing, keep a read-only record of package sources:

```bash
pi list
```

Do not move or delete existing files as a prerequisite. Install the reviewed tag with the same package command above, then start or reload Pi.

### 2. Invoke the bundled migration skill

Run:

```text
/pi-setup-init
```

The audit must cover:

- `pi list` and the separately managed companion packages declared in `piSetup.requiredPackages`;
- known manual extension files/directories under `~/.pi/agent/extensions/`;
- manually copied package themes under `~/.pi/agent/themes/`;
- selected theme and unrelated keys in `~/.pi/agent/settings.json`;
- component config/state paths listed in [Configuration](configuration.md);
- global and project MCP configuration;
- separately installed `9router-web-researcher`, Tavily/Exa MCP definitions, and legacy 9router web routes as distinct migration targets;
- trusted global agents and subagent defaults;
- the installed Ciung template and permission entries for old versus native web tools;
- credential references by name only, with values redacted.

A matching name is not enough to delete a path. The skill must distinguish a duplicate code loader from user-owned config/state. For example, `~/.pi/agent/hindsight/config.json` remains user-owned even after Hindsight code loads from the package.

### 3. Review numbered proposals

Each proposed mutation must include:

1. evidence and classification;
2. exact package source or filesystem target;
3. intended action and why the package resource or companion-package version is correct;
4. user/service impact;
5. private backup path and retention plan;
6. exact rollback steps;
7. required `/reload`, shell restart, daemon restart, or Pi restart.

Review required duplicate cleanup separately from optional configuration changes. On an existing device, changing the selected theme to `irfan-sumi` is always an optional, separately numbered proposal.

### 4. Approve narrowly

Approve explicit proposal numbers only. The skill must re-read every target, stop on drift, set restrictive backup permissions, and change only approved items.

The cleanup order is:

1. verify that the first-party package exposes the expected replacement resource;
2. back up the approved legacy loader evidence;
3. remove only that approved duplicate;
4. reload/restart Pi;
5. verify the component before continuing.

Companion packages are expected separate sources. Install or update them only after an explicit proposal is approved; do not remove them as first-party-package duplicates.

Do not delete configuration/state directories when removing loader duplicates. Do not replace the whole settings file to change one key. Never copy, print, or migrate credentials.

### 5. Verify and retain rollback

From shell:

```bash
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

Verify expected commands, tools, skills, and themes once each; confirm component config/state still works. For web migration, verify direct `web_search` and `web_fetch`, then a fresh-context Ciung run with only those tools and `my-web-search`, before approving any old-route removal. Keep backups until the user accepts the migration. Restore only the failed component's approved legacy loader—never stale settings over newer user data.

## Global subagent templates

Pi package resources do not natively include agents. The package includes reviewed source templates, but they are not automatically activated.

Use the bundled `pi-setup` skill to audit and propose deployment to `~/.pi/agent/agents/` and narrow merges into `~/.pi/agent/subagents.json`. Deployment requires explicit approval, private backup, template review, and preservation of machine-local model choices unless replacement is approved.

See [Subagent team](subagents.md#install-the-trusted-templates) for the authoritative deployment and rollback procedure.

## Install Headroom CLI

Headroom code is package-owned, but its Python proxy CLI remains separate. npm `headroom-ai` is SDK-only.

```bash
pipx install "headroom-ai[proxy]"
# or
uv tool install "headroom-ai[proxy]"
```

Hindsight daemon/profile setup is also external to Pi package installation; see [Local extensions](local-extensions.md#hindsight-memory-adapter).

## Final checks

Run `/reload` after package, extension, theme, MCP, permission, or skill changes. Restart Pi after environment-variable changes because `/reload` does not refresh the shell environment.

For updates and rollback, see [Operations](operations.md).
