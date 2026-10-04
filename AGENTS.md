# Repository Instructions

This repository is an installable personal Pi coding-agent package. Keep changes focused, practical, and safe for both fresh and existing devices.

## Documentation ownership

- Root `package.json` owns the executable Pi package manifest, exact companion package sources, declared first-party resources, and fresh-theme metadata.
- `README.md` owns the first-party package bootstrap, concise companion inventory, feature summary, configuration-scope summary, and stable topic index.
- `docs/setup/` owns detailed installation, safe migration, configuration, MCP, permissions, subagents, local-extension, skills/tools, operations, and troubleshooting guidance.
- `skills/pi-setup/SKILL.md` owns the audit/proposal/approval/migration procedure and references the relevant topic docs; it must read companion sources from root metadata instead of duplicating the manifest.
- Keep `README.md` around 90–130 lines, short and direct. Move operational detail into existing `docs/setup/` topic files.
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
- Do not restore manual-copy-first extension/theme instructions as the normal path. Repository extensions, themes, and skills load from the first-party Pi package; the three exact companions remain separate Pi package sources.
- Keep companion names and documented minimum versions aligned with `piSetup.requiredPackages`; newer installed versions satisfy minimums and remain separate Pi package sources after approval.
- Package installation must not overwrite user settings, config, state, logs, generated skills, memory, or secrets. Keep the package free of postinstall mutation.
- `pi-irfan-devs` is the recommended fresh-install default; the setup skill reads `piSetup.defaultTheme` from the manifest. Repository implementation approval does not authorize local activation. Changing an existing device's selected theme requires separate explicit approval.
- Existing-device migration must detect legacy manual extension/theme copies plus missing or below-minimum companion packages. Installed versions meeting minimums are compliant. Back up manual duplicate candidates privately and remove only explicitly approved duplicates after the first-party resource is verified.
- `/pi-setup-init` and `/pi-setup-doctor` are thin prompt adapters into the bundled skill. They must never mutate files or settings directly; init remains proposal-first and doctor strictly read-only.
- Headroom CLI remains a separate Python tool: `pipx install "headroom-ai[proxy]"` or `uv tool install "headroom-ai[proxy]"`; npm `headroom-ai` is SDK-only.
- oh-my-pi is the reference shape for local Hindsight behavior; Headroom is separate and unrelated.
- Hindsight config lives at `~/.pi/agent/hindsight/config.json`. Keep provider credentials in environment/profile config, not this repository.
- Install non-package skills with `npx skills` / `npx skills@latest`, not by manually copying skill files unless explicitly requested.
- After package, extension, or config changes, mention `/reload` or restarting Pi.
- Prefer environment variables or `/login` for provider credentials.
- Use native Pi MCP: `~/.pi/agent/mcp.json` for personal servers and `.pi/mcp.json` for trusted projects. Shared `~/.config/mcp/mcp.json` and `.mcp.json` belong to other clients/legacy setups; native Pi does not auto-load them. Never migrate or delete these files without separate approval. Do not add a companion that overrides native `/mcp`.

## Subagent templates

- Pi packages do not natively declare agent resources. Keep reviewed reusable templates under `pi/agents/` and deploy them through the approval-gated `pi-setup` skill.
- Install reusable roles globally under `~/.pi/agent/agents/`. Do not recommend invoking project `.pi/agents/` or `.agents/agents/` definitions from an untrusted repository.
- Keep Ciung mechanically scoped to `web-research`'s `web_search`/`web_fetch` plus bundled `my-web-search`; keep Laya and Prabu read-only and network-free. Every role must set `inherit_context: false`, keep bounded turns, and disable output transcripts.
- Keep canonical templates model-neutral. Per-invocation or installed-copy model choices use exact `provider/model-id`; treat `scopeModels` as a guardrail, not a security boundary.
- Builder must use Git worktree isolation and may not push, merge, deploy, publish, or handle secrets.
- `docs/setup/subagents.md` owns team roles, deployment/rollback, orchestration prompts, and trust guidance.

## Package resources

- Root manifest must continue exposing theme-owned Signature UI, local extension directories, themes, and skills. Load Signature through the canonical theme entrypoint; do not restore a standalone Signature adapter.
- `pi/themes/pi-irfan-devs/` owns palette, canonical editor/Signature entrypoint, welcome controller/renderer, adjacent tests, smoke scripts and component `README.md`. For welcome UI changes, read that component README for layout priority, visibility and diagnostics. Manifest loads only `index.ts`; preserve unrelated palettes and the single-editor conflict policy. Retired theme aliases and standalone Signature adapters stay removed.
- The `pi-irfan-devs` theme owns its green palette, editor, and Signature UI; unrelated blue/Gruvbox palettes retain their existing styles.
- The package owns native Web Research, bundled `my-web-search`, Headroom, Hindsight, Managed Skills, Goal Loop, Prompt Loop, Todos, Structured Questions, BTW, Caveman, the integrated pi-irfan-devs editor, signature UI, themes, and setup skill. Third-party companions remain separate Pi package sources declared in `piSetup.requiredPackages`.
- Todos loads from `pi/extensions/todos/index.ts`; read `docs/setup/local-extensions.md#todos` for storage, claims, and cleanup changes. Keep GC off by default; old rpiv-todo removal, data migration, and settings activation need separate approval. Credit upstream Armin Ronacher/mitsuhiko under Apache-2.0; the component README owns the upstream commit reference.
- Structured Questions loads from `pi/extensions/ask-user-question/index.ts`; read `docs/setup/local-extensions.md#structured-questions` and the component README before API/UI changes, and `docs/setup/ask-user-question-research.md` for design evidence. Keep final review, whole-questionnaire cancellation, interactive-only answers, and disposable user-invoked `/ask-demo`; session tool results are not secret storage or a permission gate. Duplicate tool sources and configuration cleanup need separate approval; ship no new runtime package, config, external state, or telemetry. Describe original Claude Code-style behavior, not an exact clone or copied source.
- Component docs should describe runtime/configuration behavior and package ownership, not repeat package installation commands.

## Permissions and trust

- No permission-system companion is required, installed, or managed by this repository. Do not reintroduce it without a new explicit user decision.
- `docs/setup/permissions.md` owns trust boundaries and manual approval procedures; keep its topic link stable.
- Setup/migration approvals remain procedural. Do not describe them as automatic tool-execution gates or a sandbox.
- Pi extensions execute with the Pi process's OS permissions. Preserve user-owned policies/configuration from removed tools unless separately approved for cleanup.

## Validation

For documentation-only changes:

- Check Markdown renders cleanly and links resolve.
- Check JSON/JSONC examples are syntactically plausible.
- Keep install commands, dependency names, versions, and ownership claims exact.
- Confirm README stays around 90–130 lines.
- Search for stale manual-copy-first or separate-package guidance.

For real Pi config changes:

- Audit first and present numbered proposals.
- Re-read targets, back up privately, and apply only approved proposal numbers.
- Preserve unknown keys and user-owned state; stop on drift or ambiguity.
- Update the owning documentation when a change should persist.
- Keep `skills/pi-setup/SKILL.md` procedural and reference owning docs instead of copying long commands.
- Tell the user to run `/reload` or restart Pi.
