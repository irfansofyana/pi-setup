# My Pi Setup

Personal [Pi](https://pi.dev) package: themes, local tools, memory, research, and workflows.
Install one reviewed release; keep user configuration separate.

## Install

Requires Node.js `>=22.19.0`, Pi `>=1.0.0`, npm, and Git.

```bash
# Install Pi if needed
curl -fsSL https://pi.dev/install.sh | sh
# or: npm install -g @earendil-works/pi-coding-agent

# Install reviewed package release
pi install git:github.com/irfansofyana/pi-setup@v0.6.0
pi
```

Inside Pi:

```text
/login
/pi-setup-init
/pi-setup-doctor
/reload
```

Init audits and proposes numbered changes; approval comes before mutation.
Doctor is read-only. Neither command changes settings directly.
Existing devices use the same install, then [review migration proposals](docs/setup/installation.md#existing-device-migration).

## Included

- **UI:** `pi-irfan-devs` green palette, integrated editor, Signature UI, and π welcome panel; blue/Gruvbox alternatives remain available.
- **Research:** native `web_search`/`web_fetch`, Tavily-first routing, optional Exa, and bundled `my-web-search`.
- **Todos:** local `todo` tool and searchable `/todos` manager; project files, session claims, cleanup off by default.
- **Questions:** included `ask_user_question` with custom answers, multi-select, previews, and final review; disposable `/ask-demo` smoke UI.
- **Memory:** local Hindsight adapter and generated Managed Skills.
- **Context:** Headroom proxy integration and read-only `/context` diagnostics.
- **Workflow:** persisted `/goal`, paced `/loop`, side-channel `/btw`, and `/caveman` response style.
- **Prompts:** seven packaged research, planning, debugging, review, and push workflows.
- **Delegation:** reviewed Ciung, Laya, Sangkur, and Prabu templates; global deployment needs separate approval.
- **Native subagents:** default-inert implementation, scoped worktrees and optional schedules/workflows; [isolated manual testing](pi/extensions/subagents/preview.md) precedes any cutover.
- **Setup:** bundled audit/proposal/migration skill; native Pi MCP guidance.

Pi loads declared extensions, themes, skills, and prompts from the package.
Do not manually copy package resources into `~/.pi/`.
Headroom's Python CLI and Hindsight's daemon remain separate tools.

<a id="required-npm-package-manifest"></a>

## Required companion packages

Three companions remain **separate Pi package sources**, installed only after approval.
Root `piSetup.requiredPackages` owns their sources and minimum versions; newer installed versions satisfy minimums.

| Package | Minimum version | Purpose |
| --- | --- | --- |
| `@ff-labs/pi-fff` | `>=0.10.5` | Specialist search |
| `@tintinweb/pi-subagents` | `>=0.14.3` | Delegated agents |
| `pi-stats-ext` | `>=0.2.0` | Usage statistics |

Todos is package-owned, replacing `npm:@juicesharp/rpiv-todo`.
If that old source remains installed, remove it only through a separately approved proposal to avoid duplicate tools.
No automatic todo-data migration or settings activation. See [Todos](docs/setup/local-extensions.md#todos).
Structured questions are also package-owned. See [Structured questions](docs/setup/local-extensions.md#structured-questions).

## Configuration and safety

- **Package-owned:** extensions, themes, skills, and prompts; updates replace code only.
- **Global user-owned:** `~/.pi/agent/` settings, MCP, component config, agents, memory, generated skills, and logs.
- **Project-owned:** `.pi/mcp.json`, project configuration, and default `.pi/todos/` state.
- Installation has no postinstall mutation and never overwrites settings, config, state, or secrets.
- `pi-irfan-devs` is recommended for fresh setup; an existing theme changes only with separate approval.
- Migration re-reads targets, stops on drift, privately backs up approved duplicates, and preserves unknown keys.
- Credentials belong in `/login`, environment variables, or provider profiles—not this repository.
- Setup approvals are procedural, not a sandbox; extensions run with Pi's OS permissions.

## Guides

| Guide | Contents |
| --- | --- |
| [Installation](docs/setup/installation.md) | Fresh setup, migration, rollback |
| [Configuration](docs/setup/configuration.md) | Ownership, paths, auth, themes, Signature UI |
| [MCP](docs/setup/mcp.md) | Native servers, search, OAuth, bearer auth |
| [Permissions](docs/setup/permissions.md) | Trust boundaries and manual approvals |
| [Subagent team](docs/setup/subagents.md) | Roles, reviewed deployment, trust |
| [Agent packaging research](docs/setup/agent-packaging-research.md) | Why upgrades do not auto-deploy global agents |
| [Local extensions](docs/setup/local-extensions.md) | Todos, structured questions, component behavior/config/state |
| [Using Hindsight day to day](docs/setup/hindsight-daily-use.md) | Memory scopes, tools, hygiene |
| [Skills and tools](docs/setup/skills-and-tools.md) | `npx skills`, Understand-Anything, Notion CLI |
| [Operations](docs/setup/operations.md) | Prompt workflows, verification, updates, troubleshooting |

## Verify and update

```bash
pi --version
pi list
pi update
pi update --extensions
```

Run `/reload` or restart Pi after package, extension, or config changes.
Restart Pi after environment changes; `/reload` does not refresh shell environment.
Verify expected commands/tools appear once and user-owned state survives.
Use reviewed release tags for reproducibility; approve configuration migrations separately.
