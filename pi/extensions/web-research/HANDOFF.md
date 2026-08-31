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

- Full repository suite: 505 passed, 0 failed.
- Focused web-research suite: 79 passed, 0 failed.
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

The seventh independent review inspected `2f7d8d6902ae13463c7c4961228dd87d809fbf76`. Every finding reproduced and was accepted. Fixes added:

- Exact query-preserving fetch correlation with ArXiv-only `/abs`/`/pdf` canonicalization and explicit requested/canonical identities in output and artifacts.
- Redaction of secrets discovered only in raw Tavily/Exa fetch result and status URLs.
- Cancellation- and deadline-aware streaming body reads plus deterministic abort-listener cleanup.
- SQLite capacity transactions were introduced during this review round, then removed before delivery after an explicit architecture correction; filesystem-only locking is the final design.
- Fail-closed artifact stat/unlink handling, post-cleanup capacity verification, dead-owner temporary cleanup, and live-owner temporary byte accounting.
- Shared strict DNS-label validation and RFC 9476 `.alt` rejection at domain and URL boundaries.

Verdict: all seven review rounds' accepted fixes are locally verified; a clean independent re-review against the exact current commit remains mandatory before delivery.

The eighth independent review inspected `8e734b6da3affe09d2fe7f00b011aee50978083f`. Every finding reproduced and was accepted. Fixes added:

- Raw request identity retained through batch reconciliation so redacted display collisions cannot duplicate evidence or artifact handles.
- Same-process capacity-gate failure handling was reviewed; the gate and SQLite design were subsequently removed.
- Every pre-existing artifact temporary removed while the exclusive capacity transaction is held, avoiding PID-reuse ambiguity.
- Post-publication compensation for target cleanup after post-link failures.
- SQLite control-file validation was implemented during review and subsequently deleted with the SQLite integration.

Verdict: all eight review rounds' accepted fixes are locally verified; a clean independent re-review against the exact current commit remains mandatory before delivery.

Architecture correction after the eighth review:

- Removed the `node:sqlite` import and `.capacity.sqlite` control file entirely.
- Restored an atomic filesystem lock directory for both same-process and cross-process serialization.
- Narrowed the guarantee deliberately: uncertain or crash-left lock directories are never reclaimed automatically; writers time out or cancel without publishing, and manual removal requires first confirming that no Pi process is writing artifacts.
- Added a regression asserting that the extension source and artifact directory contain no SQLite runtime or control file.

The ninth independent review inspected `2e1a57ced2ed5e71e5f09b68cd0a174df7b56460`. Its accepted findings are resolved in the current draft:

- Cache inputs now use opaque per-process HMAC digests, and ordinary reads/writes sweep every expired in-memory entry so TTL is a retention bound.
- Artifact capacity admission now prunes only expired records. Valid artifacts are never evicted for a new save; the new overflow fails closed when the retained entry or byte cap is full.
- Operational documentation now distinguishes extension-owned cache/artifact retention from Pi logs and Tavily/Exa provider-side retention.

Codex reviewed draft PR #34 at `c81bde945afea21938de9741322ba081a903a8c0`:

Accepted:

- The two disclosed P1 findings matched the ninth independent review and are fixed as described above.
- Per-fetch URL size was unbounded. Runtime validation and the tool schema now cap each URL at 4,096 characters before provider work.
- The first cache-expiry remediation still required later cache traffic. A single unref'd nearest-expiry timer now removes idle entries at TTL without keeping the Pi process alive.
- Artifact cleanup now validates bounded persisted records and uses each record's `expiresAt`, so process restarts or TTL configuration changes cannot delete valid evidence or retain expired evidence.
- IPv6 target validation now requires globally routable unicast, blocks the current IANA non-global ranges including `100:0:0:1::/64` and the unassigned remainder of `2001::/23`, and explicitly permits its globally reachable registered exceptions.
- Search and fetch cache TTLs now use the monotonic clock, so a backward wall-clock adjustment cannot extend retention or idle expiry.
- Per-attempt and end-to-end search/fetch latency telemetry now uses the same monotonic clock; wall time remains limited to persisted artifact timestamps.
- Configured provider credentials are now literally redacted after structural URL sanitization, including URL paths, ordinary query parameters, normalized search/fetch output, failure indexes, artifact handles, and stored metadata.
- Once the provider byte ceiling is observed, a later timeout or caller abort caused by best-effort stream cleanup cannot replace the authoritative non-retryable safety-policy failure.
- Artifact parsing uses a stable 4 MiB per-record safety ceiling rather than the mutable aggregate capacity, so expired records remain inspectable and prunable after a configured byte-cap reduction.
- Cache expiry uses both monotonic and nonnegative wall-clock elapsed time, with an unref'd one-second recheck bound while entries exist; rollback cannot extend TTL and suspend time still counts toward retention.

Rejected as a current PR blocker:

- Running every frozen baseline/skill/Ciung/legacy evaluation case. `REQUIREMENTS.md` G-6 and M-3 explicitly keep these as dogfood and legacy-deprecation gates, some require credentials and deployment approval, and the draft PR already states they are incomplete. The frozen corpus remains shipped and legacy routes remain untouched; no benchmark result is fabricated.

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
