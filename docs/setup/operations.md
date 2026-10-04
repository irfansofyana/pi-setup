# Operations

## Daily commands

| Task | Command |
| --- | --- |
| Reload config/extensions/skills | `/reload` |
| Configure providers | `/login` |
| Switch model | `/model` |
| MCP status | `/mcp` |
| Native MCP setup (shell) | `pi mcp add <name> -- <command> [args...]` |
| MCP tools/exposure | `/mcp`, then select a server |
| Subagent team/status/settings | `/agents` |
| Allowed subagent models | `/scoped-models` |
| Headroom status | `/headroom status` |
| Hindsight diagnose | `/hindsight diagnose` |
| BTW status | `/btw status` |
| Caveman status | `/caveman status` |
| Search/manage project todos | `/todos` |
| Disposable structured-question smoke UI | `/ask-demo` |
| Goal status | `/goal` (or `/goal status`) |
| Context diagnostics | `/context` |
| Update Pi | `pi update` |
| Update extensions | `pi update --extensions` |
| List packages | `pi list` |

## Packaged prompt templates

The root manifest loads `pi/prompts/*.md` directly from the installed package. Templates expand into prompts, not executable lifecycle hooks. Package updates refresh them after `/reload`; do not copy them into `~/.pi/agent/prompts/`. Pinned release tags move only when you select a newer reviewed release.

| Command | Purpose | Default boundary |
| --- | --- | --- |
| `/research <topic>` | 2–3 parallel Ciung lanes, focused queries, fetched evidence | Findings in chat; no edits |
| `/research-fit <capability>` | Ciung public constraints + Laya local feasibility | Proposal only |
| `/research-gap <feature and references>` | User-visible parity and gap matrix | Analysis only |
| `/plan-change <change>` | Acceptance criteria, vertical slices, verification, risks | Wait for implementation approval |
| `/debug <symptom>` | Reproduction, discriminating checks, root-cause evidence | Diagnosis only unless a fix is requested |
| `/review-change [base or focus]` | Independent Prabu standards/spec lanes | Read-only; parent owns test execution |
| `/push-changes [scope and destination]` | Scoped commit and ordinary branch push | No PR/MR unless explicitly requested |

Research, planning, mapping, and review lanes require the reviewed global roles from [Subagent team](subagents.md); package prompts do not deploy agents. Follow that guide's isolation requirements before invoking specialists in an untrusted repository. Research uses bundled `my-web-search`; `diagnosing-bugs` and `pr` are optional installed skills, not new package requirements. Templates do not change permission policy; their instructions are not a sandbox or enforced security boundary. Missing CLIs or skills are not installed implicitly.

Examples:

```text
/research Ways to evaluate agent setup bloat repeatedly
/research-fit Add provider-backed capability discovery
/research-gap Our goal loop versus public reference implementations
/plan-change Add a bounded cancellation path
/debug Extension fails when optional provider config is missing
/review-change main, focus on cancellation and lifecycle behavior
/push-changes Current task changes only; push to the agreed feature branch
/push-changes Current task changes; create a GitHub PR against main
/push-changes Current task changes; create a GitLab MR against develop
```

`/push-changes` keeps Git mutations in the parent session. It checks file scope, outgoing history, destination, secrets, and verification before committing/pushing; it preserves unrelated staged changes and stops on ambiguity or failures. Git alone handles commit/push. An explicitly requested GitHub PR uses `gh`; a GitLab MR uses `glab`. The selected remote determines the provider, including reviewed self-hosted configuration. Existing matching requests are reused. No force-push, history rewrite, publishing, releases, tags, deployment, or automatic merging is authorized.

After updating the package, run `/reload` and confirm all seven commands appear in completion. A harmless smoke test is `/plan-change Explain the change surface for adding another prompt, without implementation`. Adding the templates does not itself commit or push this repository.

## Verify setup

From shell:

```bash
pi --version
pi list
```

Confirm `pi list` shows the tagged first-party package and each required companion as a separate source. Companion packages are expected; audit them for missing or below-minimum sources, not aggregate duplication. Installed versions meeting documented minimums are compliant.

Inside Pi:

```text
/reload
/context
/mcp
/agents
/scoped-models
/settings
```

Todos verification: open `/todos` and search existing entries, then close without edits. Confirm `todo` is registered once and resolves the intended project store (or `PI_TODO_PATH` override). Do not create/delete tasks, migrate old data, or enable GC merely to verify installation. See [Todos](local-extensions.md#todos).

Structured-question verification: confirm `ask_user_question` is registered once, then invoke `/ask-demo` yourself. Check custom answers, single-select previews (wide side-by-side and narrow stacked), Space multi-select toggles, arrow/number selection, Enter advance, Tab/ShiftTab navigation, and final review before submission. Repeat with Esc: the whole questionnaire must cancel without partial answers. Demo must not auto-submit a model turn or write state files. RPC uses native select/input dialogs and review; print/JSON must report that interactive UI is required, not invent answers. Use non-sensitive sample text: normal tool answers remain in session results. See [Structured questions](local-extensions.md#structured-questions), the [component README](../../pi/extensions/ask-user-question/README.md), and [design research](ask-user-question-research.md).

`/context` verification: confirm the report separates all session-file branches from active context, shows only provider-reported token usage and measured char/byte sizes (no token estimates), and flags only a tool-bloat threshold. In TUI, close with `q`, `Escape`, or `Ctrl-C`; in print/RPC modes, confirm readable output (print emits the full report to stdout; RPC sends a dashboard-summary notification; JSON writes the dashboard summary to stderr).

Smoke-test prompts:

```text
/btw what is current task context?
Ask Laya (`code-mapper`) to explain this repository's setup-document ownership. Do not edit anything.
Run Ciung (`researcher`) and Laya (`code-mapper`) in parallel for this task, then reconcile their findings before proposing changes.
Use my-web-search to find current native Pi MCP docs.
Create a Mermaid diagram of this repository setup.
Review README.md for clarity and missing setup steps.
```

Notion smoke test:

```bash
ntn --version
ntn api ls
```

Inside Pi:

```text
Use the notion-cli skill to list Notion API endpoints.
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Pi cannot find npm command | Check `npm bin -g`, `PATH`, restart shell |
| MCP server does not start | Run `/mcp`, inspect error, verify env keys |
| OAuth server unauthorized | Run `/mcp login <server-name>` |
| Direct MCP tools missing | Run `/mcp reconnect <server-name>`, then `/reload` |
| Too many MCP tools in context | Use native `codemode` or `deferred` exposure; reserve `direct` for small tool sets |
| Skills do not trigger | Restart Pi or `/reload`; confirm skill in startup header |
| Headroom offline | Run `/headroom doctor`, then `/headroom start` |
| Hindsight offline | Run `/hindsight diagnose`, check daemon port/config |
| Duplicate `todo` tool or `/todos` manager | Verify bundled Todos, audit `pi list` for retired `npm:@juicesharp/rpiv-todo`, and remove that source only after separate approval; preserve old data/settings |
| Duplicate `ask_user_question` | Verify included tool, audit loaded extension sources for duplicate tools, and remove only after separate approval; old config cleanup also needs approval, with local settings preserved |
| Questions fail in print/JSON | Use interactive TUI or RPC native dialogs; no non-interactive answer is fabricated |
| Duplicate command/tool such as `/caveman` | Use the bundled `pi-setup` skill to identify first-party package and manual loaders; back up and remove only the explicitly approved manual duplicate |
| Transcript blinks or will not scroll | Update theme-owned `signature.ts`; offscreen header animation must pause to preserve scrollback |
| Theme not applied | Confirm the first-party package exposes the theme and inspect `/settings`; do not overwrite settings or copy a theme manually |

## Maintenance

```bash
pi update
pi update --extensions
pi list
```

After changing extensions, themes, prompt templates, MCP config, permission policy, or skills: run `/reload` or restart Pi. After changing environment variables, restart Pi so process inherits new values; `/reload` alone does not refresh shell environment.

First-party package updates change repository-owned extensions, themes, skills, and prompt templates. Companion packages update independently. Neither path should rewrite user-owned settings/config/state; re-run the bundled `pi-setup` audit and approve any migration separately.

## Migration rollback

- Keep private migration backups until package resources and user-owned state pass verification.
- Restore only the failed component's approved legacy loader; do not restore stale settings/config over newer user data.
- Run `/reload` or restart Pi and repeat the component checks.
- If package ownership, removal mechanics, or rollback safety is uncertain, stop and leave the item `blocked`.
