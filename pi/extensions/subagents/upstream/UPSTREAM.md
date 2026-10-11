# Upstream baseline

- Source: [championswimmer/pi-subagent-manager](https://github.com/championswimmer/pi-subagent-manager)
- Version: 0.20.0
- Pinned commit: `1f037b176070b8867e00e348a08615d04d684ee8`
- License: MIT; copyright (c) 2026 pi-subagent contributors. See [LICENSE](LICENSE).
- Imported: complete `src/`, `tests/`, `agents/`, original README and package metadata.
- Not imported: Git history, workflows, generated changelog, release/build scripts,
  caches, dependencies or upstream's planning artifacts.

This directory is an attributed source baseline, not a separately installed Pi
package. Its package metadata records upstream dependencies, not a second install
procedure. Do not point normal Pi package discovery at this directory or activate
the upstream entrypoint directly: it does not yet enforce pi-setup role policy.

Local adapters live one directory above. The package's public entrypoint stays
default-enabled. The adapter's four defaults live in `../agents/`, loaded by its
registry; legacy deployment templates are retired; native defaults need no manual copying.
Bundled upstream role definitions are retained as source
evidence, not selected as this setup's defaults. Live installation/configuration,
auth, companion removal and theme changes remain separately approval-gated.

## Local differences

Initial import is byte-for-byte source, with at most an added final newline.
Record every deliberate upstream source patch here, with the adaptation/test it
serves. Keep future baseline updates explicit; never fetch upstream on startup.

- `src/orch/manager.ts`: add owner-only `forget()` for explicit close of settled
  failed/stopped threads as well as completed ones. Policy cleanup must confirm
  before removal; adapter lifecycle tests cover retained outcomes and disposal.
  Optional spawn `detached` separates notification intent from asynchronous policy
  allocation; foreground admissions must not auto-wake the parent.
  Optional `ManagerOptions.inheritContext: false` keeps descendants fresh rather
  than copying lexical-parent transcripts; original upstream default is unchanged.
- `src/prefs/config.ts`: change two internal `.js` imports to actual `.ts` source
  paths, enabling Node's native type-transform test runner without build output.
- `src/orch/tools.ts`: narrow the manager argument type to its actual `scope`
  dependency. Root tools and the tree can then share the admission/protocol adapter
  without handing either an unguarded continuation path.
- `src/ui/settings-ui.ts`: optional deployment validation runs before a save, and
  caller-supplied defaults preserve reviewed host ceilings on Restore defaults.
  The original defaults/behavior remain unchanged for upstream callers.
- `src/prefs/settings.ts`: accept optional caller defaults before merging user and
  trusted-project layers; the adapter never silently clamps saved user settings.
- `src/ui/ui.ts`: optional browser-hint suppression lets the adapter advertise
  cooperative shortcuts instead of editor-owned arrows. Default upstream rendering
  is unchanged; pi-setup never replaces its theme's editor.
- `src/orch/prompt.ts`: optional path/context guidance preserves effective setup
  policy while reusing upstream mode/waiting/notification instructions.
- `src/ui/cost-footer.ts`: optional status-key event fallback preserves Signature's
  existing footer; default upstream fallback remains unchanged. Settings help
  describes a host-configured fallback instead of promising footer replacement.
- Root adapters replace upstream SDK runtime/config discovery, auth-store access,
  session persistence and editor installation. `agentTools`, ThreadManager,
  transcript/tree/live-view/configuration/editor code remain the actual public
  baseline. Seven root verbs, two child progress/pause controls and explicitly
  permitted custom-child delegation are integrated; the original six presets
  are not selected as defaults. All trees share the same supervised policy pool.
- Root metadata pins upstream's viewer libraries: fuzzysort 4.0.2,
  shell-quote 1.8.3 and yaml 2.8.1. No upstream package/factory is auto-installed.

Original README/test files are preserved source evidence; their repo-relative
links may target upstream-only docs/build assets. Use the owning pi-setup
component/manual-test docs for this adaptation's effective behavior.

## Validation

Upstream uses TypeScript parameter properties and `tsx` in its own test scripts.
Pure checks can use Node `--experimental-transform-types` in a hard-capped scope.
SDK tests must use an exact compatible disposable SDK fixture, not the repository's
older installed dependencies. No test or install may bypass shared-host limits.
The original tests describe upstream behavior; passing them is not evidence that
pi-setup's stricter policy or real provider compatibility has been accepted.
