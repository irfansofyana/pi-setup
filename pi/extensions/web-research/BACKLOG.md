# Backlog: Native Web Research

Legend: `[ ]` pending, `[x]` complete, `[-]` deferred.

## Required for this PR

- [ ] Register exactly `web_search` and `web_fetch`.
- [ ] Validate bounded provider-neutral inputs.
- [ ] Tavily search normalization and profile mapping.
- [ ] Exa search normalization and explicit semantic/code routing.
- [ ] Observable Tavily-first fallback on empty or retryable failure only.
- [ ] Tavily Extract batch outcomes.
- [ ] Exa Contents batch and partial-failure outcomes.
- [ ] Caller cancellation propagated through requests, retries, and waits.
- [ ] Retry only timeout, network, 429, and transient 5xx classes.
- [ ] Redact credentials and unsafe upstream payloads from errors/details.
- [ ] Bounded in-memory search/fetch cache.
- [ ] Owner-only TTL artifact storage for oversized fetched content.
- [ ] Compact output with explicit truncation and artifact handles.
- [ ] Bundle `skills/my-web-search` with source hierarchy and evidence rules.
- [ ] Update Ciung template, agent tests, setup docs, permissions, and migration procedure.
- [ ] Preserve coexistence and explicit rollback for 9router/MCP paths.
- [ ] Package contract and npm dry-run prove extension + skill ship together.
- [ ] Full test suite, typecheck/load smoke, review loop, PR CI, and Codex review.

## Deferred

- [-] Direct local HTTP fetch.
- [-] Headless browser and authenticated-cookie fetch.
- [-] PDF OCR, media, YouTube, and image handling.
- [-] Git repository cloning.
- [-] Additional providers.
- [-] Vector knowledge store.
- [-] Nested research agents.
- [-] Model-facing `web_research` tool.
- [-] Provider-generated answers presented as verified research.
