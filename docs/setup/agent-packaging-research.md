# Pi Agent Template Packaging Research

**Original research:** 2026-10-05. **Local architecture updated:** 2026-10-12.

## Conclusion

Pi's native package manifest does **not** declare agent definitions. This package
ships its own extension loader, which reads the four bundled roles directly from
[`pi/extensions/subagents/agents/`](../../pi/extensions/subagents/agents/).
Package installation therefore makes native roles available without copying
definitions into a user-owned global directory.

Current ownership:

- Bundled researcher, scout, builder and reviewer are package-owned.
- Custom definitions and sparse overrides belong to
  `~/.pi/agent/subagent-manager/agents/`; trusted project definitions use
  `.pi/agent/subagent-manager/agents/`.
- Legacy `~/.pi/agent/agents/` files remain user-owned. Audit, private backup and
  explicit approval precede import or cleanup; preserve custom definitions/model pins.

## Evidence

| Claim | Evidence |
|---|---|
| Native Pi package resource types are extensions, skills, prompts, and themes | Official Pi package docs: <https://pi.dev/docs/latest/packages>; installed Pi source `dist/core/pi-manifest.d.ts` exposes only `extensions`, `skills`, `prompts`, and `themes`. |
| Pi package manager resolves package resources; it does not copy agents into the global agent directory | Installed Pi source `dist/core/package-manager.d.ts` exposes `ResolvedPaths` only for extensions, skills, prompts, and themes. |
| This repository loads bundled roles through an extension | [Root manifest](../../package.json) ships `pi/extensions`; [registry](../../pi/extensions/subagents/registry.ts) loads extension-owned definitions. The retired `pi/agents/` directory is absent. |
| Existing global agent files are user-owned and separate | [Subagent cutover](subagents.md#native-runtime-cutover) defines reviewed import/cleanup; package updates do not overwrite legacy files or native custom definitions. |

## Upgrade behavior

1. Pi updates the installed package source and its declared native resources.
2. Updated bundled role definitions arrive with the extension code.
3. Existing legacy files and native user overrides remain unchanged.
4. `/reload` or restart loads updated package code and bundled definitions; it
   drains active native workers. `/agents reload` reloads definitions only, while
   already admitted threads retain their definition snapshots.
5. Legacy source removal or selected custom-agent import remains a separate,
   explicitly approved migration.

Native registration is default-on unless explicitly disabled or suppressed by a
configured Tintinweb source. No runtime config or global role copies are generated.

## Recommendation

Use the [current setup guide](subagents.md) for bundled roles, native overrides
and legacy cutover. The original manual template-deployment recommendation is
superseded by the extension-owned loader. Continue read-only audits and separately
approved migration for existing devices.
