# Todos

Package-owned session plans and persistent project tasks. Project task management is adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/0865c849befd2021490679f96a8dee58c84ac857/extensions/todos.ts), by Armin Ronacher. Upstream revision: `0865c849befd2021490679f96a8dee58c84ac857`. Apache-2.0; full license in [LICENSE](LICENSE). No upstream `NOTICE` file was present at this revision. The session panel is an original implementation informed by [rpiv-todo's visible session plans](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo).

## Interface

- `/todos`: choose **This session** or **Project todos**.
- `/todos plan`: manually add, edit, reorder, block, complete, reopen or delete session steps. Details support scrolling; deletion requires confirmation. Cancelled dialogs make no changes.
- `/todos collapse`: collapse/expand the live session panel without changing the plan.
- `/todos project [search]`: existing fuzzy-search project manager with view, work/refine prompt, close/reopen, release, clipboard, and confirmed delete actions. `/todos [search]` still searches project tasks except the reserved `plan`, `project`, and `collapse` arguments; use `/todos project plan` to search a reserved word.
- Arrow keys select; Enter opens actions; Escape closes the current dialog. Dialogs own focus; no global arrow hooks. Project Ctrl+Shift+W/R prepares work/refine prompts in the editor without submitting them.
- Non-TUI `/todos` lists project tasks; `/todos plan` lists session steps through RPC notifications or plain-mode stdout. The tool works without terminal UI.

## Session plan

Use the existing `todo` tool with explicit `scope: "session"`. Omitted scope remains `project` for compatibility. Session actions: `list`, `list-all`, `get`, `create`, `update`, `append`, `delete`, `reorder`. Both list actions include completed steps. IDs use `PLAN-<number>`; they are independent of project todo IDs. Claims, tags and force apply only to project todos.

```json
{"scope":"session","action":"create","title":"Add retry tests","body":"Cover exhausted retries and cancellation."}
```

```json
{"scope":"session","action":"update","id":"PLAN-1","status":"in_progress","note":"Adding cancellation coverage","expectedRevision":1}
```

Statuses: `pending`, `in_progress`, `blocked`, `completed`. A blocked step requires a non-empty `note`; changing status clears an obsolete note unless a replacement is supplied. Reopen by setting `pending`. `reorder` takes an `order` array containing every current step ID exactly once. Responses include the complete plan and revision; use `expectedRevision` to protect edits from concurrent changes. Manual dialogs always check their opening revision and reject stale edits.

The resting panel uses at most four rows, prioritizing blockers and current work. Completed steps appear only in the count; an all-completed plan folds to a summary which hides at the next agent run. All steps remain in the manager. Repetitive progress notes and the persistent `/todos · /todos collapse` hint are omitted; the commands still work. Progress is reported by the agent or human, not inferred from tool activity. An unfinished in-progress step displays **agent idle** after the run ends; it never completes automatically.

When Subagents is active, both use a [shared presentation component](../shared/README.md), with Todos first and at most six resting rows total. Agent selection can expand the combined area to ten rows while Todos retains a summary. Short terminals reduce the budget further. Each extension works alone; unloading one leaves the other usable. The renderer uses Pi widgets and does not change the editor, tool execution or agent controls.

Session plans journal every successful agent or manual mutation as a custom session entry before publishing it to the panel. This includes `todo` calls nested inside codemode; persistence does not depend on a standalone tool result. Older standalone `todo` snapshots remain readable, and late results cannot replace newer revisions. Reload, resume, compaction and tree navigation reconstruct the active branch's plan. Failed writes leave the plan unchanged. A child must load its own Todos extension to mutate its session plan; a reused parent tool cannot journal into the parent's history. Persistence follows Pi session-history retention, including ephemeral sessions. No `.pi/todos` files are created by session planning. Manual updates appear in the next agent run's plan context; they do not submit prompts or interrupt a running agent.

Plans are limited to 100 steps, 200-character titles, 1,000-character notes, 20,000-character descriptions and a 200,000-character serialized plan. Session-to-project links, dependency graphs and observed subagent activity are deferred.

## Project storage

Project `todo` actions remain `list`, `list-all`, `get`, `create`, `update`, `append`, `delete`, `claim`, `release`. `list` excludes closed/done tasks; `list-all` includes them. Close clears assignment. `claim`/`release` respect session ownership unless `force: true`; other edits are not blocked by assignment. Claims coordinate work, not enforce permissions.

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

Lightweight plan/controller/TUI-component tests (no coding-agent SDK runtime import):

```bash
node --test --test-concurrency=1 pi/extensions/todos/session-plan.test.ts pi/extensions/todos/plan-controller.test.ts pi/extensions/todos/plan-view.test.ts
```

Full Todos integration tests, on a runner with the repository's required resource limits:

```bash
node --test --test-concurrency=1 pi/extensions/todos/*.test.ts
```

Interactive smoke after `/reload`: add disposable steps in `/todos plan`; edit descriptions, reorder, cancel edits/deletion, block with a reason, complete and reopen. Ask the agent to update a session plan; check the panel while active and idle, collapse it, reload and switch conversation branches. Test narrow widths, detail scrolling and theme changes. In `/todos project`, search tasks, view details and prepare work/refine prompts. Do not use existing user tasks for destructive smoke checks.
