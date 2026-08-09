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

Inside Pi:

```text
/reload
/mcp
/mcp tools
/agents
/settings
```

Smoke-test prompts:

```text
/btw what is current task context?
Ask Mundinglaya (`code-mapper`) to explain this repository's setup-document ownership. Do not edit anything.
Run Ciung Wanara (`researcher`) and Mundinglaya (`code-mapper`) in parallel for this task, then reconcile their findings before proposing changes.
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
| Duplicate `/caveman` | Remove old external package or local duplicate; keep only repo template |
| Transcript blinks or will not scroll | Update `pi-signature.ts`; offscreen header animation must pause to preserve scrollback |
| Theme not applied | Confirm `irfan-pi.json` copied and selected in `/settings` |

## Maintenance

```bash
pi update
pi update --extensions
pi list
```

After changing extensions, themes, MCP config, permission policy, or skills: run `/reload` or restart Pi. After changing environment variables, restart Pi so process inherits new values; `/reload` alone does not refresh shell environment.

Repository template updates do not update installed copies automatically. Back up installed config, compare source and destination, copy selected changes, then re-run verification.
