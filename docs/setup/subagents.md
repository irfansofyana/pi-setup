# Subagent Team

This setup turns `@tintinweb/pi-subagents` into a small agent team instead of a generic delegation button. The templates live under [`pi/agents`](../../pi/agents) and are copied to the trusted global directory, not activated from a project checkout.

## Team

| Agent | Job | Authority | Preloaded skills |
| --- | --- | --- | --- |
| `researcher` | Current web/repository research with primary-source evidence | Read-only local tools plus only 9router search/fetch | `9router-web-researcher` |
| `code-mapper` | Trace architecture, execution flow, change surface, and tests | Read-only; no shell or extensions | `mermaid`, `teach` |
| `builder` | Writes tests first, then implementation in a Git worktree | Local read/edit/write only; no shell, test execution, network, or extensions | `code-review` |
| `reviewer` | Independent diff, risk, and test review | Read-only tools; shell remains permission-gated | `code-review` |

The main Pi session remains coordinator. Specialists return evidence and branches; they do not become a second autonomous hierarchy.

## Why these boundaries

- Research and code understanding can run in parallel without sharing a checkout or modifying state.
- Builder uses `isolation: worktree` so its file edits do not collide with the parent checkout. Worktree isolation is only checkout separation, not a security boundary and not protection against external side effects. The builder separately has only `read`, `grep`, `find`, `ls`, `edit`, and `write`; it has no shell, network, extensions, or nested-agent tools. A changed worktree is preserved on a local `pi-agent-*` branch for explicit review/integration.
- Reviewer is separate from builder. It validates the actual diff rather than approving its own work.
- Researcher combines local reads with external 9router search/fetch. Its prompt forbids sending local file contents, secrets, personal data, or proprietary identifiers; still use it only where external research is allowed.
- No template pins a model. Each inherits the current configured model, so the setup stays portable across providers. Thinking levels and turn limits are pinned per role.
- Subagent transcripts are disabled by default. This reduces stray local copies; normal Pi/provider logs and builder worktree commits may still persist.

## Prerequisites

Install the package from the canonical [README manifest](../../README.md#required-npm-package-manifest). Install the role skills from [Skills and optional tools](skills-and-tools.md):

```bash
npx skills add irfansofyana/ai-marketplace --global --skill 9router-web-researcher
npx skills add irfansofyana/ai-marketplace --global --skill mermaid
npx skills add irfansofyana/ai-marketplace --global --skill code-review
npx skills@latest add mattpocock/skills --global --skill teach
```

`researcher` also needs `pi-9router-ext` configured with working web search/fetch routes. Run `/9router-config` if either tool reports that no route is available.

## Install the trusted templates

Review every agent file first. Agent definitions and preloaded skills are executable-capability configuration, not harmless prose.

From the repository root:

```bash
set -eu
umask 077

agent_dir="$HOME/.pi/agent/agents"
mkdir -p "$agent_dir" "$HOME/.pi/agent/backups"
if [ -L "$agent_dir" ]; then
  printf 'Refusing symlinked agent directory: %s\n' "$agent_dir" >&2
  exit 1
fi
backup_root=$(mktemp -d "$HOME/.pi/agent/backups/agent-team-XXXXXXXX")
tmp=""
trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT INT TERM

for name in researcher code-mapper builder reviewer; do
  if [ -e "$agent_dir/$name.md" ]; then
    cp "$agent_dir/$name.md" "$backup_root/$name.md"
  fi
  tmp=$(mktemp "$agent_dir/.$name.md.XXXXXXXX")
  install -m 600 "pi/agents/$name.md" "$tmp"
  mv -f "$tmp" "$agent_dir/$name.md"
  tmp=""
done

trap - EXIT INT TERM
printf 'Agent backups: %s\n' "$backup_root"
```

Do not blindly replace an existing global `~/.pi/agent/subagents.json`. Review [`pi/agents/subagents.json`](../../pi/agents/subagents.json), back up the current file, then merge only the desired keys. The supplied defaults are:

```json
{
  "maxConcurrent": 3,
  "defaultMaxTurns": 40,
  "graceTurns": 5,
  "defaultJoinMode": "smart",
  "scopeModels": true,
  "toolDescriptionMode": "compact",
  "fleetView": true,
  "widgetMode": "background",
  "outputTranscript": false
}
```

`scopeModels` checks caller-selected models against Pi's exact `enabledModels` entries. If that list is absent or empty, the package treats the check as a no-op. Frontmatter-pinned models are authoritative, which is why these templates deliberately do not pin one.

Run `/reload` or restart Pi. Open `/agents` and confirm all four roles appear as global agents.

## Daily orchestration

### Fast understanding

```text
Run researcher and code-mapper in parallel for this task. Wait for both, reconcile disagreements, then give me one implementation recommendation. Do not edit yet.
```

### Amp-like build loop

```text
Use the agent team for this change:
1. researcher checks current external constraints only if needed;
2. code-mapper traces the relevant code and tests;
3. synthesize acceptance criteria;
4. builder writes tests first, then implementation in its worktree without executing tests;
5. the parent runs real verification, then reviewer independently reviews the resulting branch and evidence.
Do not merge or push. Return the branch and a go/no-go verdict.
```

### Parallel reconnaissance

```text
Spawn researcher for upstream behavior and code-mapper for our current implementation in the background. Keep working on the task framing while they run, then join their results before deciding.
```

Use foreground mode when the next decision depends immediately on one result. Use background mode for independent work; the default smart join consolidates agents spawned in the same turn.

## Integrating builder output

Builder's worktree isolation creates a local `pi-agent-*` branch only when changes exist. Builder cannot execute tests, so its deliverable lists tests changed and commands to run without claiming pass/fail results. The parent should:

1. Inspect the returned branch and commit.
2. Review `git diff <base>...<branch>`.
3. Re-run relevant tests in a clean integration checkout.
4. Ask `reviewer` to inspect the real branch/diff.
5. Cherry-pick or merge only after the review verdict and tests pass.
6. Push or open a PR from the parent session, never from the subagent by default.

## Trust boundary

`@tintinweb/pi-subagents` discovers project definitions from `.pi/agents/*.md` and `.agents/agents/*.md`. A globally loaded package can discover those files even when Pi is launched with `--no-approve`. Extension selection or exclusion is not a sandbox: discovered extension factory code may execute before child binding or filtering decides which extensions and tools the role receives.

Therefore:

- Reusable trusted roles belong in `~/.pi/agent/agents/`.
- The repository keeps inert templates under `pi/agents/`, which is not an auto-discovery path.
- Do not run any team role directly in an untrusted repository, including a trusted global role. Use a container, VM, or dedicated user first.
- Before using any project agent, inspect `extensions`, `tools`, `model`, `skills`, `memory`, `prompt_mode`, and isolation fields.
- `isolated: true`, worktrees, extension exclusions, tool filters, and permission prompts may reduce authority or separate files, but none is an operating-system sandbox or a guarantee against external side effects.

## Verification

From the repository root:

```bash
node --test pi/agents/agent-templates.test.ts
node --test pi/extensions/*/*.test.ts
npx -y tsx --test pi/extensions/pi-signature.test.ts
```

Inside Pi:

```text
/reload
/agents
```

Smoke test with a harmless read-only request:

```text
Ask code-mapper to explain this repository's setup-document ownership. Do not edit anything.
```

Expected: the role appears as global, uses only read/grep/find/ls, cites repository files, and returns an explicit deliverable. Then run a researcher query and confirm only `ninerouter_web_search`/`ninerouter_web_fetch` are exposed from 9router.

## Rollback

Restore each prior `*.md` from the printed private backup directory, or remove a newly added role if no prior file existed. Restore the separately backed-up `~/.pi/agent/subagents.json`, then run `/reload` or restart Pi.
