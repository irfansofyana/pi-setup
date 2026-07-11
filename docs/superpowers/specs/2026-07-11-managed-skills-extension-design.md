# Managed Skills Extension Design

## Goal

Turn the managed-skills branch into a maintainable Pi extension that safely creates generated skills, retains durable Hindsight lessons, and runs optional capture only after Pi has fully settled.

## Compatibility

- The extension targets Pi `>=0.80.4`.
- `autoContinue` uses `agent_settled`, added in Pi `0.80.4`, because `agent_end` can precede retry, compaction, or queued continuation work.
- Existing command names, tool names, the global config path, the managed-skill directory, and Hindsight configuration remain stable.
- The extension remains a repository-owned template copied to `~/.pi/agent/extensions/managed-skills` and gains no install-time dependencies.

## Module Boundaries

### `types.ts`

Own shared configuration, tool-input, Hindsight, path, and dependency contracts. It contains no filesystem or Pi runtime behavior.

### `schema.ts`

Own the small JSON-schema builder and exported tool schemas. This keeps Pi tool registration declarative without adding TypeBox as a local dependency.

### `filesystem.ts`

Own reusable safe-file primitives:

- validate absolute non-symlink directories;
- read regular single-link files through `O_NOFOLLOW` file handles;
- enforce byte limits before returning content;
- write same-directory exclusive temporary files;
- sync and atomically rename completed temporary files;
- remove temporary files after failures.

Atomic replacement never follows an existing destination symlink. A failed replacement leaves the previous destination content unchanged.

### `config.ts`

Own managed-skills paths, defaults, normalization, reads, and writes. Missing config uses defaults. A malformed or unreadable existing config fails closed by disabling managed skills, `learn`, and automation, and carries a diagnostic that `/managed-skills status` and `/managed-skills config` display. Writes use the atomic filesystem primitive.

### `skill-store.ts`

Own name and description sanitization, frontmatter serialization/parsing, discovery, list/view, and create/update/delete. It accepts an explicit root and byte limit so production and tests do not depend on the current home directory. Same-skill mutations remain serialized in-process. Reads reject symlinks, non-regular files, hard links, and oversized content. Updates are atomic.

Known authored skill names take precedence: both create and update return a clear collision error rather than claiming a shadowed managed skill will become active.

### `hindsight.ts`

Own Hindsight config loading, project scoping, secret redaction, lesson sanitization, timeout/abort composition, and retain requests. It preserves the existing endpoint and payload contract and remains independently testable with an injected `fetch` implementation.

### `auto-capture.ts`

Own a pure lifecycle state machine. `agent_end` records the largest eligible tool-call count across a continuation chain but never sends. `agent_settled` sends once only when Pi is idle and has no pending messages. The hidden custom-message marker identifies the actual capture chain; its retries and final settlement cannot suppress or trigger capture for an unrelated user run.

Capture prompts are built from effective config. They mention `learn` only when it is registered and limit `manage_skill` guidance to reusable procedures.

### `extension.ts`

Own Pi wiring: commands, discovery, prompt augmentation, tools, authored-skill inventory, lifecycle hooks, notifications, and reload guidance. A dependency factory supplies config/store/Hindsight functions so tests can run against a fake Pi API without touching the real home directory or daemon.

### `index.ts`

Remain the minimal Pi entry point. It default-exports the production extension and re-exports supported helpers for tests and local reuse.

## Runtime Flows

### Skill mutation

1. Re-read effective config.
2. Validate action arguments and authored-name collisions.
3. Sanitize and serialize content.
4. Write an exclusive same-directory temporary file.
5. Sync, close, and atomically rename it into place.
6. Report `/reload` guidance after a successful mutation.

### Automatic capture

1. `agent_start` resets the current low-level run tool counter.
2. `tool_execution_end` increments it.
3. `agent_end` records an eligible candidate. If the run contains the managed-skills hidden marker, it marks the capture chain instead.
4. Pi completes retries, compaction, and queued continuations.
5. `agent_settled` verifies idle/no-pending state and sends one hidden capture prompt.
6. The marker in that run prevents recursive auto-capture, including when `minToolCalls` is `0`.

### Invalid config

1. Missing config returns defaults.
2. Invalid existing config returns fail-closed effective settings plus a diagnostic.
3. Status/config commands display the diagnostic and path.
4. A successful command write replaces the invalid file atomically and clears the diagnostic on the next read.

## Testing

- Unit tests cover config normalization and diagnostics, safe atomic I/O, skill-store security and atomicity, Hindsight payloads, and the capture state machine.
- Integration-style tests use a fake Pi API to exercise command/tool registration, config-aware prompts, authored collisions, lifecycle ordering, pending-message deferral, hidden-run correlation, and reload messages.
- Failure injection proves failed config/skill writes preserve previous content and clean temporary files.
- Final verification runs all managed-skills tests, TypeScript checking against the installed Pi API, Markdown checks, `git diff --check`, and a copied-extension load smoke test where practical.

## Non-Goals

- No automatic `/reload` after skill mutations.
- No replacement for Hindsight or changes to its daemon configuration.
- No writes to authored skill directories.
- No new npm runtime dependency or package publishing workflow.
- No unrelated refactor of other Pi extensions.

## Research Basis

Pi `0.80.4` added extension and RPC `agent_settled` events for fully settled agent runs. Source: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md> (checked 2026-07-11).
