# Subagent Team

This setup turns `@tintinweb/pi-subagents` into a small agent team instead of a generic delegation button. The templates live under [`pi/agents`](../../pi/agents) and are copied to the trusted global directory, not activated from a project checkout.

## Team

| Identity | Role ID | Job | Authority | Preloaded skills |
| --- | --- | --- | --- | --- |
| **Ciung** | `researcher` | Current public-web research with primary-source evidence | Native `web_search`/`web_fetch` only; no local file tools; Headroom routing only | bundled `my-web-search` |
| **Laya** | `code-mapper` | Trace architecture, execution flow, change surface, and tests | Read-only; no shell; Headroom routing only | `mermaid`, `teach` |
| **Sangkur** | `builder` | Prepares behavior tests and implementation in a Git worktree; parent executes tests | Local read/edit/write only; no shell, test execution, network; Headroom routing only | `code-review` |
| **Prabu** | `reviewer` | Independent diff, risk, and test review | Read-only; no shell; Headroom routing only | `code-review` |

The main Pi session remains coordinator. Specialists return evidence and branches; they do not become a second autonomous hierarchy.

## Why these boundaries

- Research and code understanding can run in parallel without sharing a checkout or modifying state.
- Builder uses `isolation: worktree` so its file edits do not collide with the parent checkout. Worktree isolation is only checkout separation, not a security boundary and not protection against external side effects. The builder separately has only `read`, `grep`, `find`, `ls`, `edit`, and `write`; it has no shell, network, or nested-agent tools. Headroom is loaded only to preserve provider routing; `headroom_stats` remains disallowed. A changed worktree is preserved on a local `pi-agent-*` branch for explicit review/integration.
- Reviewer is separate from builder and has only `read`, `grep`, `find`, and `ls`; it cannot execute shell commands or use extension tools. Headroom loads only for provider routing. The parent supplies the actual diff and verification evidence so review authority remains genuinely read-only.
- Ciung loads package-owned `web-research` plus Headroom routing. It cannot read repository files or use Headroom tools. Give it sanitized public questions and URLs; Laya handles local repository evidence, and the parent reconciles both streams.
- Every role sets `inherit_context: false`; the coordinator must supply a self-contained task packet instead of leaking unrelated conversation context.
- Subagent transcripts are disabled by default. This reduces one source of local copies; it does not disable normal Pi logs, builder worktree commits, or Tavily/Exa API-side logs and retention. Pi log locations and lifetime follow the local Pi configuration. Provider-side storage follows the account settings and published policies of each provider and is not controlled by this extension. Extension-owned cache/artifact locations and retention are documented in [Local Extensions](local-extensions.md#native-web-research).

## Prerequisites

`@tintinweb/pi-subagents` is a separately managed [required companion package](../../README.md#required-npm-package-manifest). Pi package resources do not natively include agents, so continue to review and deploy the global templates in this guide. The native web extension and `my-web-search` skill are already package resources; do not install either separately. Install only the remaining role skills from [Skills and optional tools](skills-and-tools.md):

```bash
npx skills add irfansofyana/ai-marketplace --global --skill mermaid
npx skills add irfansofyana/ai-marketplace --global --skill code-review
npx skills@latest add mattpocock/skills --global --skill teach
```

The Pi process running `researcher` needs `TAVILY_API_KEY`; `EXA_API_KEY` is optional unless Exa is explicitly requested or selected for semantic/code intent. Keep credentials in the process environment, never in the agent template. Existing `pi-9router-ext` and Tavily/Exa MCP configuration may remain during side-by-side dogfood, but Ciung cannot call those legacy tools after this template is deployed.

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

## Model selection

Keep the reviewed repository templates model-neutral. They inherit the parent's current `/model` by default, while the coordinator can select a model for one invocation:

```javascript
Agent({
  subagent_type: "builder",
  model: "<provider>/<model-id>",
  thinking: "high",
  prompt: "<self-contained task packet>",
  description: "Implement the assigned vertical slice"
})
```

Use an exact `provider/model-id` when reproducibility matters. Avoid persistent fuzzy aliases such as `fast`, `smart`, or `sonnet`.

For a stable machine-local preference, edit the installed copy under `~/.pi/agent/agents/`, add `model: <provider>/<model-id>` to its frontmatter, then run `/reload`. Do not add personal model pins to the canonical `pi/agents/` templates. Inspect effective assignments and availability warnings with `/agents`.

Model precedence is: frontmatter model > invocation model > parent model. A frontmatter pin therefore prevents a caller from overriding that role for one invocation. In v0.14.3, an unavailable frontmatter model falls back to the parent model; `/agents` reports the unavailable assignment and inherited fallback.

Use `/scoped-models` to maintain Pi's exact `enabledModels` entries. With `scopeModels: true`:

- a runtime-selected out-of-scope model produces a hard error;
- a frontmatter-pinned out-of-scope model emits a warning and then runs;
- an inherited out-of-scope parent model emits a warning and then runs;
- if `enabledModels` is absent or empty, scope checking is a no-op.

Direct RPC and scheduled paths do not make this a strict policy boundary; enforce compliance outside the agent runtime when that is required. The v0.14.3 scope resolver accepts exact entries only: globs, bare model IDs, and `:thinking` suffixes are silently dropped. If every configured entry is dropped, the resulting empty exact allowlist makes scope checking a no-op. Prefer `/scoped-models`, which writes exact `provider/model-id` entries.

Treat model scoping as an operator guardrail, not a compliance boundary. Confirm the actual model in `/agents`, especially after provider or profile changes.

Run `/reload` or restart Pi. Open `/agents` and confirm all four roles appear as global agents.

## Task packets and completion gates

Because every role starts with fresh context, give it a self-contained packet instead of relying on conversation inheritance:

```text
Goal:
Decision this result informs:
Acceptance criteria:
Relevant scope:
Known constraints:
Invariants:
Evidence already collected:
Explicit non-goals:
Required deliverable:
Effort/turn budget:
```

Narrow the packet to the role. Give Ciung sanitized public questions and URLs, Laya repository paths and the execution path to trace, Sangkur an explicit file allowlist and one vertical slice, and Prabu the review evidence packet below.

A result marked `steered`, `aborted`, or `stopped` is incomplete. It may contain useful evidence, but it cannot authorize implementation, approval, integration, or publication. The parent must reframe or resume the task and obtain a complete result.

For Prabu, supply:

```text
Base/head revision:
Actual diff:
Affected-file context:
Acceptance criteria and invariants:
Verification commands:
Exact command output:
Known gaps and unverified assumptions:
```

The parent owns every gate: acceptance criteria, test execution, interpretation of partial results, branch integration, commit, push, deployment, and publication.

## Daily orchestration

### Fast understanding

```text
Run Ciung (`researcher`) and Laya (`code-mapper`) in parallel for this task. Wait for both, reconcile disagreements, then give me one implementation recommendation. Do not edit yet.
```

### Amp-like build loop

```text
Use the agent team for this change:
1. Ciung (`researcher`) checks current external constraints only if needed;
2. Laya (`code-mapper`) traces the relevant code and tests;
3. synthesize acceptance criteria and send a self-contained task packet;
4. Sangkur (`builder`) prepares the smallest behavior test and expected implementation in its worktree, marking execution as pending;
5. the parent executes focused tests and feeds exact failure output back for a narrowly scoped repair when needed;
6. the parent supplies the actual diff, affected-file context, and exact verification results to Prabu (`reviewer`) for independent, read-only assessment.
Do not merge or push. Return the branch and a go/no-go verdict.
```

### Parallel reconnaissance

```text
Spawn Ciung (`researcher`) for upstream behavior and Laya (`code-mapper`) for our current implementation in the background. Keep working on the task framing while they run, then join their results before deciding.
```

Use foreground mode when the next decision depends immediately on one result. Use background mode for independent work; the default smart join consolidates agents spawned in the same turn.

## Integrating builder output

Builder's worktree isolation creates a local `pi-agent-*` branch only when changes exist. Builder cannot execute tests, so this is a test-first preparation loop—not autonomous RED/GREEN TDD. The parent should:

1. Inspect the returned branch and commit.
2. Capture `git diff <base>...<branch>` and the affected-file context.
3. Run the focused behavior test and relevant regression suite in a clean integration checkout; retain exact command output.
4. If verification fails, send Sangkur the exact failure, current acceptance criteria, and same file allowlist for one focused repair.
5. Run verification again. Use at most two focused repair rounds; after that, reframe the task or escalate instead of widening authority.
6. Supply Prabu the review evidence packet and obtain a complete verdict.
7. Cherry-pick or merge only after the review verdict and tests pass.
8. Push or open a PR from the parent session, never from the subagent by default.

## Trust boundary

`@tintinweb/pi-subagents` discovers project definitions from `.pi/agents/*.md` and `.agents/agents/*.md`. A globally loaded package can discover those files even when Pi is launched with `--no-approve`. Extension selection or exclusion is not a sandbox: discovered extension factory code may execute before child binding or filtering decides which extensions and tools the role receives.

Therefore:

- Reusable trusted roles belong in `~/.pi/agent/agents/`.
- The repository keeps inert templates under `pi/agents/`, which is not an auto-discovery path.
- Do not run any team role directly in an untrusted repository, including a trusted global role. Use a container, VM, or dedicated user first.
- Before using any project agent, inspect `extensions`, `tools`, `model`, `skills`, `memory`, `prompt_mode`, and isolation fields.
- `isolated: true`, worktrees, extension exclusions, tool filters, and permission prompts may reduce authority or separate files, but none is an operating-system sandbox or a guarantee against external side effects.

## Lightweight evaluation

[`pi/agents/evaluation-scorecard.json`](../../pi/agents/evaluation-scorecard.json) freezes eight synthetic/public cases—two per role—and five 0–2 outcome criteria. It is data only, not another agent or routing runtime.

Use it when comparing prompts or model assignments:

1. Change one variable at a time.
2. Run the same frozen cases with self-contained packets.
3. Score correctness, evidence, scope discipline, tool efficiency, and actionability.
4. Record concrete reasons for deductions; compare outcomes, not identical trajectories.
5. Keep private repositories and transcripts out of the fixture. If more cases are needed, add them only after a repeated failure mode is observed.

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
Ask Laya (`code-mapper`) to explain this repository's setup-document ownership. Do not edit anything.
```

Expected: the role appears as global, uses only read/grep/find/ls, cites repository files, and returns an explicit deliverable. Then run a researcher query and confirm only `web_search`/`web_fetch` are exposed from the `web-research` extension, `my-web-search` is preloaded, and no local/MCP/9router tools are available.

## Rollback

Restore each prior `*.md` from the printed private backup directory, or remove a newly added role if no prior file existed. Restore the separately backed-up `~/.pi/agent/subagents.json`; if the package itself must be rolled back, reinstall the previously reviewed package tag before running `/reload` or restarting Pi. Do not delete legacy skills, MCP configuration, credentials, caches, or logs as part of rollback unless they were separately audited and explicitly approved for removal.
