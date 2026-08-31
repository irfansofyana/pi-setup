# Handoff: Native Web Research

Date: 2026-08-31
Status: implementation and accepted review fixes complete; independent re-review and PR delivery pending
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

- Full repository suite: 486 passed, 0 failed.
- Focused web-research suite: 60 passed, 0 failed.
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

Initial independent Standards and Specification reviews inspected commit `8a43b0d0b8121e1ed417fd4f6e52c7de2a7fa83c` against `origin/main`.

Accepted and fixed:

- IPv4-compatible/mapped IPv6, 6to4, loopback, link-local, ULA, and documentation-address bypasses in public-URL validation.
- Cancellation bypass on cached search results and post-response persistence boundaries.
- Cross-instance artifact entry/byte-cap races.
- Sensitive query values and fragments leaking into output or artifact metadata.
- Unbounded provider JSON, result counts, metadata fields, request IDs, and formatted output.
- Unclamped `Retry-After` values and per-attempt timeouts without one end-to-end deadline.
- Permission/safety/policy extraction failures being eligible for fallback or lacking normalized classes.
- Missing per-attempt latency, cache age/state, returned/stored sizes, cancellation state, and normalized error telemetry.
- Artifact paths exposed without an opaque retrieval operation; default oversized evidence discarded before offload.
- Missing canonical URL and per-document provider identity.

Rejected:

- None. Every blocking finding was reproduced against the reviewed commit and accepted.

The second independent review inspected `d8e90ac045b75e3b5432b10c7298854b534b051e`. Its accepted fixes added:

- IPv4-translated IPv6 rejection (`::ffff:0:0:0/96`).
- Cancellation-aware artifact lock acquisition/publication and live-owner lock identity.
- One monotonic deadline shared across provider fallback, including post-response checks for transports that ignore abort signals.
- Redaction of sensitive URL values echoed through provider titles, snippets, bodies, metadata, failures, or artifacts.
- Distinct per-URL `timeout`, `rate_limit`, and `not_found` classes.
- Safe structured validation/artifact errors without local-path disclosure.
- Branch-wide trailing-whitespace cleanup.

The third independent review inspected `2741db9910b032870dbbf98622fce2ffb8c7f1c6`. Every finding reproduced and was accepted. Fixes added:

- Rejection of trailing-dot local/reserved hostnames.
- Raw, decoded, percent-encoded, and form-encoded sensitive-value redaction for fetch and search-query URL echoes.
- First-abort-cause preservation when transport rejection is delayed.
- A deadline and backoff for ownerless artifact-lock publication crashes.
- Transactional rollback of artifacts created earlier in a failed or cancelled multi-document preparation.
- Explicit missing-provider outcomes for every unmatched Tavily or Exa batch URL.
- Bounded allowlisted HTTP request-ID extraction and terminal-error telemetry.

The fourth independent review inspected `7c6f755a91086f4c7b0ccacd96b5ce89904467ec`. Every finding reproduced and was accepted. Fixes added:

- Tolerant bounded recursive redaction for malformed, multiply encoded, and short sensitive values.
- Redaction derived from provider-discovered signed URLs and from input URLs across success/error attempt telemetry.
- Cancellation of rejected response streams on declared oversize, timeout/cancellation, and non-2xx paths.
- Canonical public-domain filters, ISO publication bounds, and ordered publication bounds.
- Exactly one deterministic success/failure outcome per requested batch URL.
- One aggregate call-wide inline-content budget with artifact offload.
- Safe request IDs on every attempt and bounded retry-after data on terminal errors.

The fifth independent review inspected `be25e853f889df9073f54697ea74776c772bd135`. Every finding reproduced and was accepted. Fixes added:

- Fragment and URL-userinfo secret extraction before display sanitization, for input and provider-discovered URLs.
- Rejection of noncanonical numeric loopback domain forms before provider calls.
- Cancellation latching before transport deadline work and listener-race rechecks.
- Partial artifact-lock owner records treated as in-progress plus monotonic lock deadlines.
- A compact outcome/artifact index reserved ahead of inline fetched bodies.
- Cleanup failures cannot mask response-byte safety-policy failures or enable fallback.
- Auto/Tavily publication bounds accept calendar dates only; explicit Exa preserves supported ISO timestamp precision.

The sixth independent review inspected `fdbeb3688446ccfd4e38041b408c411d961441bc`. Every finding reproduced and was accepted. Fixes added:

- Best-effort response-body cleanup that cannot delay authoritative timeout, cancellation, HTTP, or byte-safety failures.
- Compound OAuth key, configured provider credential, and focus-URL secret redaction across output, telemetry, cache, errors, and artifacts.
- Per-entry defensive handling for malformed provider URLs.
- Atomic artifact-lock owner publication, recovery from legacy/partial crashes, monotonic deadlines, and leak-free abort-aware polling.
- Rejection of special-use IPv4 literals and reserved hostname suffixes at public boundaries.
- Fail-closed canonical resource correlation that preserves requested and provider-canonical URL identity.
- Complete artifact-retrieval observability with validated provider identity and retrieval truncation state.

Verdict: all six review rounds' accepted fixes are locally verified; a clean independent re-review against the exact current commit remains mandatory before delivery.

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

1. Commit the accepted review fixes and run fresh independent Standards and Specification reviews against that exact commit.
2. Resolve any new validated blockers and repeat until clean.
3. Rebase on `origin/main`, push, open the PR, and verify CI on the exact pushed commit.
4. Run automated PR review and address validated findings until clean.
