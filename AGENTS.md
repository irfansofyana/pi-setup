# Repository Instructions

This repository documents a personal Pi coding-agent setup. Keep changes focused, practical, and easy to copy into a fresh machine.

## Documentation ownership

- `README.md` owns canonical nine-package npm manifest, minimal fresh-machine bootstrap, concise feature summary, configuration-scope summary, and stable topic index.
- `docs/setup/` owns detailed setup, configuration, MCP, permissions, subagents, local-extension, skills/tools, operations, and troubleshooting guidance.
- `skills/pi-setup/SKILL.md` references `README.md` and relevant topic docs; it must not duplicate package manifests or detailed commands.
- Keep `README.md` between 180 and 250 lines. Move growing operational detail into existing `docs/setup/` topic files instead of adding new README sections.
- Keep README-to-topic links and topic filenames stable. Update links deliberately when a rename is unavoidable.
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
- Use local copy instructions for repo-owned extension templates such as `pi/extensions/headroom`, `pi/extensions/hindsight`, and `pi/extensions/managed-skills`.
- Headroom CLI is installed with `pipx install "headroom-ai[proxy]"` or `uv tool install "headroom-ai[proxy]"`; npm `headroom-ai` is SDK-only.
- oh-my-pi is the reference shape for the local Hindsight extension; Headroom is separate/unrelated.
- Local Hindsight extension config lives at `~/.pi/agent/hindsight/config.json`; use it for daemon URLs such as named `hindsight-embed` profile ports when Pi does not inherit shell env. Keep provider credentials in env/profile config, not this repo.
- Always install skills with `npx skills` / `npx skills@latest`, not by manually copying skill files unless explicitly requested.
- After extension/config changes, mention `/reload` or restarting Pi.
- For provider credentials, prefer environment variables or `/login`; do not hardcode secrets.
- For MCP configs, prefer `~/.config/mcp/mcp.json` for shared global config and `.mcp.json` for project-specific config.

## Subagent templates

- Keep reviewed reusable agent templates under `pi/agents/`; this path is intentionally not auto-discovered by `@tintinweb/pi-subagents`.
- Install reusable roles globally under `~/.pi/agent/agents/`. Do not recommend invoking project `.pi/agents/` or `.agents/agents/` definitions from an untrusted repository.
- Keep researcher/code-mapper/reviewer read-only, bound turns, and disable output transcripts unless a documented workflow explicitly needs them.
- Builder must use Git worktree isolation and may not push, merge, deploy, publish, or handle secrets.
- `docs/setup/subagents.md` owns team roles, copy/rollback procedure, orchestration prompts, and trust guidance.

## Current required Pi extensions

- Keep canonical npm package manifest only in `README.md`; change package membership and install forms there.
- Keep topic docs and skill pointed at README manifest rather than duplicating commands.
- Required repo-owned local templates remain Headroom, Hindsight, Managed Skills, Goal Loop, Prompt Loop, BTW, Caveman, signature UI, and `irfan-pi` theme. Detailed copy procedures belong in `docs/setup/`.

## Permission policy notes

- `~/.pi/agent/extensions/pi-permission-system/config.json` is the global policy path.
- `docs/setup/permissions.md` should include current intended policy; README links to it.
- Tavily, Exa, and Brave search tools should be allowed without approval.
- Mutating/retention tools (`write`, `edit`, `manage_skill`, `learn`) and shell/MCP defaults should stay gated unless the user explicitly asks otherwise.

## Validation

For documentation-only changes:

- Check Markdown renders cleanly.
- Check JSON/JSONC examples are syntactically plausible.
- Keep install commands and package names exact.

For real Pi config changes:

- Update real config file and owning documentation (`README.md` for manifest/bootstrap/index; otherwise relevant `docs/setup/` topic) when change should persist.
- Keep `skills/pi-setup/SKILL.md` procedural and reference owning docs instead of copying commands.
- Tell user to run `/reload` or restart Pi.
