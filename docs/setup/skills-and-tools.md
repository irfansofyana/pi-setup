# Skills and Optional Tools

Install skills only with `npx skills` or `npx skills@latest`. Do not manually copy skill files unless intentionally developing a local skill.

## Core personal skills

```bash
npx skills add irfansofyana/ai-marketplace --global --skill mermaid
npx skills add irfansofyana/ai-marketplace --global --skill 9router-web-researcher
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

Adds Pi commands for codebase graphs, dashboard, chat, diffs, explanations, and onboarding.

Install from Egonex fork:

```bash
curl -fsSL https://raw.githubusercontent.com/Egonex-AI/Understand-Anything/main/install.sh | bash -s pi
```

Useful commands:

```text
/understand
/understand-dashboard
/understand-chat How does authentication work?
/understand-diff
/understand-explain README.md
/understand-onboard
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
