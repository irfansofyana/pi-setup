# Repository Instructions

This repository documents a personal Pi coding-agent setup. Keep changes focused, practical, and easy to copy into a fresh machine.

## Project shape

- `README.md` is the source of truth for setup steps, extension installs, MCP config, skills, permissions, and troubleshooting.
- `AGENTS.md` contains working instructions for future agent sessions in this repo.
- Avoid adding generated artifacts, caches, secrets, or machine-specific session files.

## Writing style

- Be concise and operational.
- Prefer copy-pasteable commands and config blocks.
- Use clear section headings and short bullets.
- Keep examples generic; never include real API keys, tokens, company URLs, or personal secrets.
- When documenting config paths, distinguish global vs project-local paths.

## Pi setup conventions

- Use `pi install npm:<package>` for npm Pi packages.
- Use `pi install git:github.com/<owner>/<repo>` for GitHub package installs.
- Always install skills with `npx skills` / `npx skills@latest`, not by manually copying skill files unless explicitly requested.
- After extension/config changes, mention `/reload` or restarting Pi.
- For provider credentials, prefer environment variables or `/login`; do not hardcode secrets.
- For MCP configs, prefer `~/.config/mcp/mcp.json` for shared global config and `.mcp.json` for project-specific config.

## Current required Pi extensions

Keep README install instructions aligned with these packages unless intentionally changing the setup:

```bash
pi install npm:pi-mcp-adapter
pi install npm:@tintinweb/pi-subagents
pi install npm:@gotgenes/pi-permission-system
pi install npm:context-mode
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:pi-markdown-preview
pi install npm:@juicesharp/rpiv-todo
pi install npm:pi-9router-ext
pi install npm:pi-stats-ext
pi install git:github.com/DietrichGebert/ponytail
# Caveman: manual install (git clone to ~/.pi/agent/git/github.com/jonjonrankin/pi-caveman)
# pi install git:github.com/jonjonrankin/pi-caveman
```

## Permission policy notes

- `~/.pi/agent/extensions/pi-permission-system/config.json` is the global policy path.
- README should include the current intended policy.
- Tavily, Exa, and Brave search tools should be allowed without approval.
- Mutating tools (`write`, `edit`) and shell/MCP defaults should stay gated unless the user explicitly asks otherwise.

## Validation

For documentation-only changes:

- Check Markdown renders cleanly.
- Check JSON/JSONC examples are syntactically plausible.
- Keep install commands and package names exact.

For real Pi config changes:

- Update both the real config file and `README.md` if the change is meant to persist.
- Tell the user to run `/reload` or restart Pi.
