# Backlog: Native Web Research

Legend: `[ ]` pending, `[x]` complete, `[-]` deferred.

## Required for this PR

- [x] Register exactly `web_search` and `web_fetch`.
- [x] Validate bounded provider-neutral inputs.
- [x] Tavily search normalization and profile mapping.
- [x] Exa search normalization and explicit semantic/code routing.
- [x] Observable Tavily-first fallback on empty or retryable failure only.
- [x] Tavily Extract batch outcomes.
- [x] Exa Contents batch and partial-failure outcomes.
- [x] Caller cancellation propagated through requests, retries, waits, and the artifact boundary.
- [x] Retry only timeout, network, 429, and transient 5xx classes.
- [x] Redact credentials and unsafe upstream payloads from errors/details.
- [x] Bounded in-memory search/fetch cache.
- [x] Owner-only TTL artifact storage for oversized fetched content.
- [x] Compact output with explicit truncation and artifact handles.
- [x] Bundle `skills/my-web-search` with source hierarchy and evidence rules.
- [x] Update Ciung template, agent tests, setup docs, permissions, and migration procedure.
- [x] Preserve coexistence and explicit rollback for 9router/MCP paths.
- [x] Package contract and npm dry-run prove extension + skill ship together.
- [x] Full automated suite, isolated typecheck, and Pi load smoke.
- [ ] Independent standards/specification review loop.
- [ ] PR CI and automated PR review on the exact pushed commit.

## Dogfood and retirement gates

- [ ] Run frozen baseline-versus-skill cases.
- [ ] Run live Tavily, Exa, direct-tool, and fresh-context Ciung smoke tests after deployment approval.
- [ ] Compare native and legacy routes for quality, latency, cost, and parent-context size.
- [ ] Audit exact legacy deletion targets and obtain explicit removal approval.

## Deferred

- [-] Direct local target-URL HTTP fetch.
- [-] Headless browser and authenticated-cookie fetch.
- [-] PDF OCR, media, YouTube, and image handling.
- [-] Git repository cloning.
- [-] Additional providers.
- [-] Vector knowledge store.
- [-] Nested research agents.
- [-] Model-facing `web_research` tool.
- [-] Provider-generated answers presented as verified research.
