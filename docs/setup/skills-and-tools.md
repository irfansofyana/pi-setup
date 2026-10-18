# Skills and Optional Tools

The aggregate package loads its declared `pi/skills/` resources directly. Install third-party skills only with `npx skills` or `npx skills@latest`; do not manually copy either package-owned or external skill files unless intentionally developing one.

## Bundled skills

- [`pi-setup`](../../pi/skills/pi-setup/SKILL.md) — audit and approval-gated migration workflow.
- [`my-web-search`](../../pi/skills/my-web-search/SKILL.md) — provider-neutral research method used by the main agent and preloaded by the bundled `researcher` role.
- [`natural-writing`](../../pi/skills/natural-writing/SKILL.md): original prose-editing guidance that preserves facts, technical literals and active Caveman style.

- [`browser-setup`](../../pi/skills/browser-setup/SKILL.md) — read-only audit, approved one-time opt-in and troubleshooting for existing default Chrome.
- [`browser-assist`](../../pi/skills/browser-assist/SKILL.md) — scoped summaries, extraction, navigation and form preparation through native MCP. Browser access is opt-in; see [activation and safety](mcp.md#browser-assistance).

All live under package-owned `pi/skills/`; existing skill names and commands are unchanged.
If personal package resource filters or custom integrations explicitly reference
the former root `skills/` paths, review and update those references to `pi/skills/`
when adopting the updated package. Unfiltered package loading follows the manifest.
User-owned `~/.pi/agent/skills/`, `.pi/skills/` and managed skills are not moved.
After loading the updated package, run `/reload` or restart Pi.

Bundled skills need no separate marketplace command. An existing separately installed `9router-web-researcher` may remain during side-by-side dogfood, but it is legacy, is not preloaded by the bundled researcher, and must be removed only after an explicit audit and approval.

### Natural writing

Pi advertises the skill description and loads its instructions for relevant prose drafting/revision; automatic selection is best-effort, not an output filter. Explicit use:

```text
/skill:natural-writing Rewrite this PR description without changing facts
```

Caveman retains control of compression and fragments; the skill never toggles it or rewrites protected code, commands, data or quotations. No global settings or Caveman preferences are changed. This repository's `AGENTS.md` adds a prose-routing pointer; a global `~/.pi/agent/AGENTS.md` pointer requires separate approval and is not installed by the package. Do not stack conflicting third-party humanizers for the same task; removing existing skills/configuration requires its own approval.

[Provenance and evaluation guidance](../../pi/skills/natural-writing/references/sources.md) distinguish original instructions, source references, static contract checks and authored model cases that have not been run. Run `/reload` after loading the updated package.

## Core personal skills

```bash
npx skills add irfansofyana/ai-marketplace --global --skill mermaid
npx skills add irfansofyana/ai-marketplace --global --skill code-review
npx skills add irfansofyana/ai-marketplace --global --skill decision-sparring
npx skills add irfansofyana/ai-marketplace --global --skill idea-refinery
```

## General skills

```bash
npx skills@latest add mattpocock/skills --global --skill grill-me
npx skills@latest add mattpocock/skills --global --skill caveman
npx skills@latest add mattpocock/skills --global --skill teach
npx skills add https://github.com/anthropics/skills --skill frontend-design --global
npx skills add https://github.com/anthropics/skills --skill skill-creator --global
npx skills add hardikpandya/stop-slop --global --skill stop-slop
```

## Notion skills

```bash
npx skills add makenotion/skills --global
# or only CLI skill
npx skills add makenotion/skills --global --skill notion-cli
```

Run `/reload` after skill changes.

## Optional: Understand-Anything

The package-owned `/understand <question>` uses read-only scouts and answers in chat without graph files; see [prompt workflows](operations.md#packaged-prompt-templates). The optional Understand-Anything workflow below generates knowledge graphs and dashboard artifacts.

For skill-based installs, use explicit `/skill:understand` commands to distinguish them from the bundled prompt. Audit existing bare `/understand` wrappers separately; never overwrite or remove them automatically.

Install from Egonex fork:

```bash
curl -fsSL https://raw.githubusercontent.com/Egonex-AI/Understand-Anything/main/install.sh | bash -s pi
```

Useful commands:

```text
/skill:understand
/skill:understand-dashboard
/skill:understand-chat How does authentication work?
/skill:understand-diff
/skill:understand-explain README.md
/skill:understand-onboard
```

Uninstall:

```bash
cd ~/.understand-anything/repo
bash install.sh --uninstall pi
rm -rf ~/.understand-anything ~/.understand-anything-plugin
```

## Optional: Notion CLI (`ntn`)

Install:

```bash
curl -fsSL https://ntn.dev | bash
# or Node.js 22+ / npm 10+
npm install --global ntn
```

Verify/auth:

```bash
ntn --version
ntn --help
ntn login
export NOTION_API_TOKEN="secret_..."
```

Useful commands:

```bash
ntn api ls
ntn api --help
ntn api <endpoint> --docs
ntn files --help
ntn workers --help
```

Smoke test inside Pi:

```text
Use the notion-cli skill to list Notion API endpoints.
```
