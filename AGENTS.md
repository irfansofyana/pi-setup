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
- Use local copy instructions for repo-owned extension templates such as `pi/extensions/headroom` and `pi/extensions/hindsight`.
- Headroom CLI is installed with `pipx install "headroom-ai[proxy]"` or `uv tool install "headroom-ai[proxy]"`; npm `headroom-ai` is SDK-only.
- oh-my-pi is the reference shape for the local Hindsight extension; Headroom is separate/unrelated.
- Local Hindsight extension config lives at `~/.pi/agent/hindsight/config.json`; use it for daemon URLs such as named `hindsight-embed` profile ports when Pi does not inherit shell env. Keep provider credentials in env/profile config, not this repo.
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
pi install npm:pi-lsp-extension
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:pi-markdown-preview
pi install npm:@juicesharp/rpiv-todo
# Headroom: install CLI with pipx/uv, then copy local template from pi/extensions/headroom
# Hindsight: copy real local-daemon memory template from pi/extensions/hindsight
pi install npm:pi-9router-ext
pi install npm:pi-stats-ext
# Caveman: terse response style extension
pi install git:github.com/jonjonrankin/pi-caveman
```

## Permission policy notes

- `~/.pi/agent/extensions/pi-permission-system/config.json` is the global policy path.
- README should include the current intended policy.
- Tavily, Exa, Brave search tools, and read-only LSP tools should be allowed without approval.
- Mutating tools (`write`, `edit`), structural rewrite tools, and shell/MCP defaults should stay gated unless the user explicitly asks otherwise.

## Validation

For documentation-only changes:

- Check Markdown renders cleanly.
- Check JSON/JSONC examples are syntactically plausible.
- Keep install commands and package names exact.

For real Pi config changes:

- Update both the real config file and `README.md` if the change is meant to persist.
- Tell the user to run `/reload` or restart Pi.
