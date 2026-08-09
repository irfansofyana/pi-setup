# Operations

## Daily commands

| Task | Command |
| --- | --- |
| Reload config/extensions/skills | `/reload` |
| Configure providers | `/login` |
| Switch model | `/model` |
| MCP status | `/mcp` |
| MCP setup | `/mcp setup` |
| MCP tools | `/mcp tools` |
| Permissions UI | `/permission-system` |
| Subagent team/status/settings | `/agents` |
| Allowed subagent models | `/scoped-models` |
| Headroom status | `/headroom status` |
| Hindsight diagnose | `/hindsight diagnose` |
| BTW status | `/btw status` |
| Caveman status | `/caveman status` |
| Goal status | `/goal` (or `/goal status`) |
| Update Pi | `pi update` |
| Update extensions | `pi update --extensions` |
| List packages | `pi list` |

## Verify setup

From shell:

```bash
pi --version
pi list
```

Confirm `pi list` shows the tagged first-party package and each required companion as a separate source. Companion packages are expected; audit them for missing or version-drifted sources, not aggregate duplication.

Inside Pi:

```text
/reload
/mcp
/mcp tools
/agents
/scoped-models
/settings
```

Smoke-test prompts:

```text
/btw what is current task context?
Ask Laya (`code-mapper`) to explain this repository's setup-document ownership. Do not edit anything.
Run Ciung (`researcher`) and Laya (`code-mapper`) in parallel for this task, then reconcile their findings before proposing changes.
Use 9router-web-researcher to find current Pi MCP adapter docs.
Create a Mermaid diagram of this repository setup.
Review README.md for clarity and missing setup steps.
```

Notion smoke test:

```bash
ntn --version
ntn api ls
```

Inside Pi:

```text
Use the notion-cli skill to list Notion API endpoints.
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Pi cannot find npm command | Check `npm bin -g`, `PATH`, restart shell |
| MCP server does not start | Run `/mcp`, inspect error, verify env keys |
| OAuth server unauthorized | Run `/mcp-auth <server-name>` |
| Direct MCP tools missing | Run `/mcp reconnect <server-name>`, then `/reload` |
| Too many MCP tools in context | Remove `directTools: true` or list selected tools only |
| Skills do not trigger | Restart Pi or `/reload`; confirm skill in startup header |
| Headroom offline | Run `/headroom doctor`, then `/headroom start` |
| Hindsight offline | Run `/hindsight diagnose`, check daemon port/config |
| Duplicate command/tool such as `/caveman` | Use the bundled `pi-setup` skill to identify first-party package and manual loaders; back up and remove only the explicitly approved manual duplicate |
| Transcript blinks or will not scroll | Update `pi-signature.ts`; offscreen header animation must pause to preserve scrollback |
| Theme not applied | Confirm the first-party package exposes the theme and inspect `/settings`; do not overwrite settings or copy a theme manually |

## Maintenance

```bash
pi update
pi update --extensions
pi list
```

After changing extensions, themes, MCP config, permission policy, or skills: run `/reload` or restart Pi. After changing environment variables, restart Pi so process inherits new values; `/reload` alone does not refresh shell environment.

First-party package updates change repository-owned extensions, themes, and skills. Companion packages update independently. Neither path should rewrite user-owned settings/config/state; re-run the bundled `pi-setup` audit and approve any migration separately.

## Migration rollback

- Keep private migration backups until package resources and user-owned state pass verification.
- Restore only the failed component's approved legacy loader; do not restore stale settings/config over newer user data.
- Run `/reload` or restart Pi and repeat the component checks.
- If package ownership, removal mechanics, or rollback safety is uncertain, stop and leave the item `blocked`.
