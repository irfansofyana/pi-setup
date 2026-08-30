# Research Templates

## Parent-to-researcher task packet

```text
Goal:
Decision this result informs:
Questions to answer:
Scope and exclusions:
Freshness/version requirement:
Known public identifiers and URLs:
Primary-source expectations:
Evidence already collected:
Explicit non-goals:
Required deliverable:
Search/turn/time budget:
```

Sanitize the packet before it reaches a public provider. Remove secrets, local file content, private repository details, personal data, and proprietary identifiers.

## Compact claim ledger

```text
claim | status | primary source | version/date | conflicts
```

Statuses:

- `confirmed` — fetched evidence directly supports the claim.
- `inferred` — evidence supports an interpretation but not the complete claim.
- `unknown` — evidence is missing, contradictory, inaccessible, or outside the budget.

## Evidence record

```text
claim_id:
claim_text:
canonical_source_url:
source_title:
source_type:
source_date_or_version:
exact_supporting_passage:
relation: support | contradict | qualify
body_fetched: true | false
retrieved_at:
unresolved_caveat:
```

## Parent-facing result

1. Recommendation
2. Claim ledger
3. Important exact quotations or line-level evidence
4. Conflicts and caveats
5. Explicit unknowns and retrieval failures
6. Short actionable handoff
7. Optional owner-only artifact handles

Keep the handoff compact. Do not paste raw page bodies unless the parent explicitly asks for an artifact.
