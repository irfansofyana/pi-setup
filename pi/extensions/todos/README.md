# Todos

Package-owned file-backed tasks adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/0865c849befd2021490679f96a8dee58c84ac857/extensions/todos.ts), by Armin Ronacher. Upstream revision: `0865c849befd2021490679f96a8dee58c84ac857`. Apache-2.0; full license in [LICENSE](LICENSE). No upstream `NOTICE` file was present at this revision.

## Interface

- `todo` tool: `list`, `list-all`, `get`, `create`, `update`, `append`, `delete`, `claim`, `release`.
- `/todos [search]`: fuzzy-search manager with view, work/refine prompt, close/reopen, release, clipboard, and confirmed delete actions.
- Arrow keys select; Enter opens actions; Escape closes. Ctrl+Shift+W/R prepares work/refine prompts in editor; it does not auto-submit.
- Non-TUI `/todos` returns a filtered list through RPC notification or plain-mode stdout; tool works without terminal UI.
- `list` excludes closed/done tasks; `list-all` includes them. Close clears assignment.
- `claim`/`release` respect session ownership unless `force: true`. Other edits are not blocked by assignment: claims coordinate work, not enforce permissions.

## Storage

Default: `<cwd>/.pi/todos/`. `PI_TODO_PATH` overrides it; relative paths resolve against current working directory. Nothing is created until first `create` action. Each `<8-hex-id>.md` starts with JSON front matter followed by Markdown body. IDs accept `TODO-deadbeef`, `deadbeef`, or `#TODO-deadbeef`.

Tasks persist across sessions and branches; branching does not roll back files. Brief exclusive `.lock` files guard read-modify-write operations, while `assigned_to_session` persists claims. Active locks block edits. After 30 minutes (file modification time), locks are reported stale but never stolen automatically or through a dialog. Verify no session is still editing before manually removing a stale lock. Writes use temporary files plus atomic rename and preserve existing file permissions; new task files start private (`0600`). Calls run sequentially within one Pi session.

Settings in `<todo-dir>/settings.json`:

```json
{
  "gc": false,
  "gcDays": 7
}
```

GC is opt-in: only JSON boolean `true` enables it; malformed settings fail closed. Locked tasks are skipped. When enabled, startup deletes closed/done tasks whose `created_at` is older than `gcDays`, **not** days since closure. Back up tasks before enabling it. Settings are read, not generated or overwritten.

## Local changes from upstream

Strict opt-in and lock-aware GC, lazy directory creation, permission-preserving atomic writes, valid-hex filename filtering, sequential tool execution, fail-closed stale locks, RPC-safe non-TUI fallback, and strip-only-compatible TypeScript. Runtime imports use Pi host libraries; no new companion package.

This replaces the package requirement for `@juicesharp/rpiv-todo`, not its data format. No automatic old-data migration or local package removal. Avoid loading another `todo` tool alongside this extension; review and remove conflicting sources separately. See [local extension guide](../../../docs/setup/local-extensions.md).

## Checks

```bash
node --test pi/extensions/todos/*.test.ts
```

Interactive smoke after `/reload`: open `/todos`, search tasks, view details, prepare work/refine prompts, cancel deletion, then confirm deleting a disposable task. Test narrow terminal widths and theme changes.
