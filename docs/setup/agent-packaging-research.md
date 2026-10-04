# Pi Agent Template Packaging Research

**Checked:** 2026-10-05

## Conclusion

Pi packages can ship agent template files as package contents, but Pi's native package manifest does **not** declare or deploy agent definitions. Package upgrades therefore do not automatically create or refresh trusted global agents under `~/.pi/agent/agents/`.

This repository's current split is correct:

- Ship reviewed templates under `pi/agents/`.
- Deploy approved copies to `~/.pi/agent/agents/` through `pi-setup`.
- Back up existing global files, preserve local edits/model choices, then run `/reload`.

## Evidence

| Claim | Evidence |
|---|---|
| Native Pi package resource types are extensions, skills, prompts, and themes | Official Pi package docs: <https://pi.dev/docs/latest/packages>; installed Pi source `dist/core/pi-manifest.d.ts` exposes only `extensions`, `skills`, `prompts`, and `themes`. |
| Pi package manager resolves package resources; it does not copy agents into the global agent directory | Installed Pi source `dist/core/package-manager.d.ts` exposes `ResolvedPaths` only for extensions, skills, prompts, and themes. |
| This repository includes templates in the published artifact but not the Pi resource manifest | Root `package.json` includes `"pi/agents"` under `files`, while `pi` declares only `extensions`, `skills`, and `themes`. |
| Existing global agent files are user-owned and separate | `docs/setup/subagents.md` and `skills/pi-setup/SKILL.md` define deployment to `~/.pi/agent/agents/` with backup and approval gates. |

## Upgrade behavior

1. Pi updates the installed package source and its declared native resources.
2. New `pi/agents/*.md` files may exist inside the updated package installation.
3. Existing files in `~/.pi/agent/agents/` remain unchanged.
4. Updated templates require an explicit deployment/migration step.
5. `/reload` reloads resources after deployment; it does not perform the deployment itself.

A package extension could write files as custom code, but that would be bespoke post-install mutation, not native agent packaging. It would also violate this repository's non-destructive installation policy.

## Recommendation

Keep current architecture. Improve update UX through an explicit read-only audit that reports template drift, followed by an approval-gated deployment proposal. Do not silently overwrite global agent files during package install or update.
