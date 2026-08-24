# Repository Instructions

This repository is an installable personal Pi coding-agent package. Keep changes focused, practical, and safe for both fresh and existing devices.

## Documentation ownership

- Root `package.json` owns the executable Pi package manifest, exact companion package sources, declared first-party resources, and fresh-theme metadata.
- `README.md` owns the first-party package bootstrap, concise companion inventory, feature summary, configuration-scope summary, and stable topic index.
- `docs/setup/` owns detailed installation, safe migration, configuration, MCP, permissions, subagents, local-extension, skills/tools, operations, and troubleshooting guidance.
- `skills/pi-setup/SKILL.md` owns the audit/proposal/approval/migration procedure and references the relevant topic docs; it must read companion sources from root metadata instead of duplicating the manifest.
- Keep `README.md` between 180 and 250 lines. Move operational detail into existing `docs/setup/` topic files.
- Keep README-to-topic links and topic filenames stable. Update links deliberately when a rename is unavoidable.
- `AGENTS.md` contains working instructions for future agent sessions in this repository.
- Avoid generated artifacts, caches, secrets, and machine-specific session files.

## Writing style

- Be concise and operational.
- Prefer copy-pasteable commands and config blocks.
- Use clear section headings and short bullets.
- Keep examples generic; never include real API keys, tokens, company URLs, or personal secrets.
- Distinguish package-owned resources, global user configuration, and project-local configuration.

## Pi package conventions

- Normal installation is one reviewed release tag, for example `pi install git:github.com/irfansofyana/pi-setup@v0.1.0`.
- Do not restore manual-copy-first extension/theme instructions as the normal path. Repository extensions, themes, and skills load from the first-party Pi package; the nine exact companions remain separate Pi package sources.
- Keep companion names and exact versions aligned with `piSetup.requiredPackages`; companions are deliberately installed as separate Pi package sources after approval.
- Package installation must not overwrite user settings, config, state, logs, generated skills, memory, or secrets. Keep the package free of postinstall mutation.
- `irfan-sumi` is fresh-install setup metadata. Changing an existing device's selected theme requires a separate explicit approval.
- Existing-device migration must detect legacy manual extension/theme copies plus missing or version-drifted companion packages. Back up manual duplicate candidates privately and remove only explicitly approved duplicates after the first-party resource is verified.
- `/pi-setup-init` and `/pi-setup-doctor` are thin prompt adapters into the bundled skill. They must never mutate files or settings directly; init remains proposal-first and doctor strictly read-only.
- Headroom CLI remains a separate Python tool: `pipx install "headroom-ai[proxy]"` or `uv tool install "headroom-ai[proxy]"`; npm `headroom-ai` is SDK-only.
- oh-my-pi is the reference shape for local Hindsight behavior; Headroom is separate and unrelated.
- Hindsight config lives at `~/.pi/agent/hindsight/config.json`. Keep provider credentials in environment/profile config, not this repository.
- Install non-package skills with `npx skills` / `npx skills@latest`, not by manually copying skill files unless explicitly requested.
- After package, extension, or config changes, mention `/reload` or restarting Pi.
- Prefer environment variables or `/login` for provider credentials.
- Prefer `~/.config/mcp/mcp.json` for shared global MCP config and `.mcp.json` for project-specific config.

## Subagent templates

- Pi packages do not natively declare agent resources. Keep reviewed reusable templates under `pi/agents/` and deploy them through the approval-gated `pi-setup` skill.
- Install reusable roles globally under `~/.pi/agent/agents/`. Do not recommend invoking project `.pi/agents/` or `.agents/agents/` definitions from an untrusted repository.
- Keep Ciung mechanically web-only; keep Laya and Prabu read-only and network-free. Every role must set `inherit_context: false`, keep bounded turns, and disable output transcripts.
- Keep canonical templates model-neutral. Per-invocation or installed-copy model choices use exact `provider/model-id`; treat `scopeModels` as a guardrail, not a security boundary.
- Builder must use Git worktree isolation and may not push, merge, deploy, publish, or handle secrets.
- `docs/setup/subagents.md` owns team roles, deployment/rollback, orchestration prompts, and trust guidance.

## Package resources

- Root manifest must continue exposing repo-owned signature UI, local extension directories, themes, and skills.
- `pi/themes/irfan-sumi/` owns Sumi's `theme.json`, integrated editor `index.ts`, smoke test, and component documentation. Do not restore a standalone editor resource under `pi/extensions/`.
- The package owns Headroom, Hindsight, Managed Skills, Goal Loop, Prompt Loop, BTW, Caveman, the integrated Irfan Sumi editor, signature UI, themes, and setup skill. Third-party companions remain separate Pi package sources declared in `piSetup.requiredPackages`.
- Component docs should describe runtime/configuration behavior and package ownership, not repeat package installation commands.

## Permission policy notes

- `~/.pi/agent/extensions/pi-permission-system/config.json` is the global policy path.
- `docs/setup/permissions.md` owns the intended policy; README links to it.
- Tavily, Exa, and Brave search tools should be allowed without approval.
- Mutating/retention tools (`write`, `edit`, `manage_skill`, `learn`) and shell/MCP defaults should stay gated unless the user explicitly asks otherwise.

## Validation

For documentation-only changes:

- Check Markdown renders cleanly and links resolve.
- Check JSON/JSONC examples are syntactically plausible.
- Keep install commands, dependency names, versions, and ownership claims exact.
- Confirm README stays between 180 and 250 lines.
- Search for stale manual-copy-first or separate-package guidance.

For real Pi config changes:

- Audit first and present numbered proposals.
- Re-read targets, back up privately, and apply only approved proposal numbers.
- Preserve unknown keys and user-owned state; stop on drift or ambiguity.
- Update the owning documentation when a change should persist.
- Keep `skills/pi-setup/SKILL.md` procedural and reference owning docs instead of copying long commands.
- Tell the user to run `/reload` or restart Pi.
