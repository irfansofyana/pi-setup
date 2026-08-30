# Permissions

The permission extension is a separately managed [required companion package](../../README.md#required-npm-package-manifest). The setup skill proposes its exact source on a fresh setup and waits for approval.

## Global policy path

```text
~/.pi/agent/extensions/pi-permission-system/config.json
```

Create policy directory and edit file:

```bash
mkdir -p ~/.pi/agent/extensions/pi-permission-system
$EDITOR ~/.pi/agent/extensions/pi-permission-system/config.json
```

Back up existing policy first. Preserve unknown keys unless migration requires removal.

## Recommended policy

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json",
  "permissionReviewLog": true,
  "permission": {
    "*": "ask",
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "web_search": "allow",
    "web_fetch": "allow",
    "tavily_*": "allow",
    "exa_*": "allow",
    "brave_search_*": "allow",
    "ask_user_question": "allow",
    "todo": "allow",
    "write": "ask",
    "edit": "ask",
    "manage_skill": "ask",
    "learn": "ask",
    "subagent": "ask",
    "bash": {
      "*": "ask",
      "git*": "allow"
    },
    "mcp": {
      "*": "ask",
      "tavily": "allow",
      "tavily:*": "allow",
      "tavily_*": "allow",
      "exa": "allow",
      "exa:*": "allow",
      "exa_*": "allow",
      "brave-search": "allow",
      "brave-search:*": "allow",
      "brave-search_*": "allow",
      "brave_search_*": "allow"
    },
    "skill": {
      "*": "allow"
    },
    "external_directory": "ask"
  }
}
```

Policy intent:

- Read-only local tools allowed.
- Native read-only `web_search` and provider-backed `web_fetch` allowed without approval.
- Legacy Tavily/Exa/Brave direct tools remain allowed only for side-by-side migration; remove those entries separately after the old integrations are explicitly retired.
- Structured questions, todos, and skill loading allowed.
- Mutating/retention tools (`write`, `edit`, `manage_skill`, `learn`) gated.
- Shell defaults gated; Git commands allowed.
- MCP defaults gated except the temporarily approved legacy search providers.
- External-directory access gated.

Remove or migrate legacy `~/.pi/agent/pi-permissions.jsonc` if warnings appear.

Run `/reload`, then inspect `/permission-system` and test both read-only and mutating prompts.
