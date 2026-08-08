# Using Hindsight day to day

Hindsight is most useful when you treat it as a decision and learning log, not as a transcript dump. The Pi extension already recalls relevant memory before work and retains eligible sessions when memory hooks are enabled; explicit prompts are for facts or reasoning you want to control.

## The three scopes

| Scope | Reads | Good for |
| --- | --- | --- |
| `project` | Current project only | Architecture, conventions, bugs, commands, dependencies, local decisions |
| `global` | Explicit untagged memories only | Durable personal preferences and reusable procedures that apply everywhere |
| `all` | Current project plus global | Default recall and reflection during normal project work |

`all` never means every project. With `per-project-tagged`, it filters the shared bank to the current project plus untagged global memories. With `per-project`, it queries the current project's bank and the base global bank, then merges and deduplicates the results.

Automatic shutdown retention stays project-scoped. A memory becomes global only when you explicitly request it.

## Recall, reflect, and retain

- **Recall** retrieves concrete memories relevant to a query. Use it before implementing, debugging, selecting a library, or revisiting an old decision.
- **Reflect** reasons over memory. Use it when you want patterns, trade-offs, lessons, or a recommendation synthesized from prior experience.
- **Retain** writes new information. Use it after a decision, verified fix, failed approach, or durable preference becomes clear.

## Natural-language trigger prompts

You can ask Pi naturally; the agent should call the matching Hindsight tool.

### Start a task with recall

```text
Before changing authentication, recall the relevant project decisions, previous failures, and my global engineering preferences. Use Hindsight scope all.
```

```text
Recall what we previously learned about flaky integration tests in this project. Use project scope and cite any conflicting or stale memories.
```

### Save a project memory

```text
Remember this for the current project: OAuth callback tests require the local Redis container because the in-memory adapter does not reproduce TTL behavior. Category: workaround. Include why we made this decision and the command that verified it.
```

```text
Retain this verified fix as project memory: [problem, root cause, rejected attempts, final change, and test result]. Do not include secrets or raw credentials.
```

### Save a global memory

```text
Remember globally: I prefer incremental production changes, explicit rollback steps, and least-privilege sandboxes. Category: preferences.
```

```text
Retain this as a global procedure because it applies across repositories: [reusable workflow]. Exclude project names, proprietary code, and credentials.
```

Use global retention sparingly. If a fact contains a repository path, project-specific command, architecture detail, customer name, or local bug, it almost certainly belongs in `project` scope.

### Ask Hindsight to reason

```text
Reflect on our project and global memories about dependency upgrades. Recommend the safest rollout plan, explain which prior failures influenced it, and flag memories that may be stale. Use scope all.
```

```text
Reflect only on this project's past deployment incidents. What recurring failure pattern should we design out next?
```

## Direct tool examples

These are the effective payloads Pi should generate when exact control matters.

```json
{
  "tool": "hindsight_recall",
  "query": "authentication architecture decisions and prior failed approaches",
  "scope": "all",
  "budget": "mid"
}
```

```json
{
  "tool": "hindsight_retain",
  "text": "The verified facts, context, rationale, failed attempts, and outcome.",
  "category": "decision",
  "scope": "project"
}
```

```json
{
  "tool": "hindsight_retain",
  "text": "A durable preference or reusable cross-project procedure.",
  "category": "preferences",
  "scope": "global"
}
```

```json
{
  "tool": "hindsight_reflect",
  "query": "What do previous incidents suggest we should change in this design?",
  "context": "We are preparing the next implementation plan.",
  "scope": "all",
  "budget": "low"
}
```

## A practical workflow

1. **Before non-trivial work:** recall with `all` so project history and durable global preferences are available.
2. **During work:** do not retain guesses. Wait until a fact, decision, failure, or workaround is verified.
3. **After verification:** retain rich project context—what happened, why, rejected approaches, exact non-secret commands, and observed results.
4. **For reusable preferences or procedures:** explicitly retain with `global`; strip project-specific details first.
5. **Before a major choice or retrospective:** reflect with `all`, then verify the answer against current code and documentation.
6. **When memories conflict:** prefer recent evidence and ask Pi to surface dates and contradictions rather than silently choosing one.

Explicit `hindsight_retain` waits for the server to confirm the write (`async: false`), so an immediate recall can retrieve the retained memory. Hindsight may still consolidate richer observations afterward; if your next step depends on those derived observations rather than the exact retained text, prefer recalling on a later turn.

## Commands for checks and troubleshooting

```text
/hindsight status
/hindsight stats
/hindsight diagnose
/hindsight recall <query>
/hindsight memory enable
/hindsight memory disable
```

`/hindsight recall <query>` uses `all`. Use the explicit tools when you need project-only or global-only retrieval.

If recall is noisy, make the query concrete: name the component, decision, failure mode, time frame, or desired outcome. If recall is empty, check `/hindsight diagnose`, confirm memory hooks are enabled, and verify that the relevant memory was retained under the intended scope.

## What not to store

Never retain:

- API keys, tokens, passwords, cookies, connection strings, or `.env` contents;
- raw proprietary datasets or customer data;
- speculative conclusions presented as facts;
- routine command output with no durable lesson;
- complete session transcripts as global memory.

The extension redacts common secret patterns, but redaction is a backstop—not permission to send secrets.

## Upstream references

- [Hindsight overview](https://hindsight.vectorize.io/)
- [Hindsight best practices](https://hindsight.vectorize.io/best-practices)
- [Retain: storing memories](https://docs.hindsight.vectorize.io/retain/)
- [Memory-bank guidance](https://docs.hindsight.vectorize.io/memory-banks/)
