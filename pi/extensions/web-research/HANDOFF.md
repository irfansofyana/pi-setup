# Handoff: Native Web Research

Date: 2026-08-31
Status: implementation complete; independent review and PR delivery pending
Spec: `REQUIREMENTS.md`

## Current state

The feature branch contains native `web_search` and `web_fetch`, Tavily-first/Exa-selective routing, provider-backed extraction, lifecycle hardening, bounded cache/artifacts, bundled `my-web-search`, Ciung source-template migration, setup/migration documentation, and frozen evaluation cases.

No live Pi installation, global Ciung template, legacy skill, MCP entry, credential, cache, log, or user state has been changed or removed.

## How to verify

From the repository root:

```bash
npm ci
npm test
node --test pi/extensions/web-research/*.test.ts
npm pack --dry-run --json
```

Strict isolated typecheck used for the three new TypeScript modules:

```bash
npm exec --yes --package=typescript@5.9.3 -- tsc -p /tmp/pi-web-research-tsconfig.json
```

Pi load smoke used RPC mode with only `pi/extensions/web-research/index.ts` loaded and the strict allowlist `web_search,web_fetch`. It returned a successful `get_state` response with no unknown-tool diagnostics.

## Observed verification

- Full repository suite: 448 passed, 0 failed.
- Focused web-research suite: 19 passed, 0 failed.
- Strict isolated TypeScript check: passed.
- Package dry-run: passed; extension code/trackers/evaluation corpus and bundled skill/references are present.
- Package contract: 7 passed, 0 failed.
- Agent templates: 12 passed, 0 failed.
- Pi strict-tool-allowlist load smoke: passed.
- README invariant: 201 lines, within the required 180–250 range.
- Secret-pattern scan: no credential literals in this delivery; only pre-existing redaction fixtures matched.

## Decisions

See `DECISIONS.md`.

## Review

Pending independent Standards and Specification reviews against the current branch. Accepted and rejected findings will be recorded here before delivery.

## Known limitations and open gates

- `TAVILY_API_KEY` and `EXA_API_KEY` were unset, so live provider calls were not claimed or fabricated.
- The branch was not installed into the live Pi configuration; fresh-context Ciung dogfood requires separate deployment approval.
- Direct local target-URL HTTP, browser/authenticated fetching, PDF/media handling, and a model-facing `web_research` tool remain deferred.
- Baseline-versus-skill and native-versus-legacy benchmark runs remain required before legacy deprecation.
- Existing 9router/MCP resources remain intentionally untouched for coexistence and rollback.
- The repository defines no root build or lint script. Runtime loading, Node tests, package dry-run, and strict isolated TypeScript checking are the applicable verification surfaces.

## Rollback

Reinstall the previously reviewed package tag and run `/reload` (or restart Pi after environment changes). Restore backed-up global agent templates only if a later approved live-device migration changes them. Do not delete legacy skills, MCP configuration, credentials, caches, logs, or user state as part of rollback unless separately audited and explicitly approved.

## Next steps

1. Complete independent Standards and Specification review loops.
2. Re-run exact verification after accepted fixes.
3. Rebase on `origin/main`, push, open the PR, and verify CI on the exact pushed commit.
4. Run automated PR review and address validated findings until clean.
