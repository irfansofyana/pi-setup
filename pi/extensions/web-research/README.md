# Native Web Research

First-party Pi web-search and fetch extension backed by direct Tavily and Exa HTTP APIs. The extension and bundled `my-web-search` skill are one reviewed delivery.

## Tools

- `web_search` — compact source discovery; Tavily by default and Exa for explicit semantic/code intent.
- `web_fetch` — provider-backed page extraction through Tavily Extract or Exa Contents. Direct local HTTP is deliberately deferred.

Both tools accept `provider: "auto" | "tavily" | "exa"`. Explicit overrides win. Search also accepts a portable `fast | balanced | thorough` profile, domain/date filters, and a declared `general | semantic | code` intent. Fetch accepts up to 20 public HTTP(S) URLs, optional focused extraction, a per-result character ceiling, and cache bypass.

## Runtime behavior

- `TAVILY_API_KEY` is required for ordinary `auto`; `EXA_API_KEY` is required only when Exa is selected or used as an allowed fallback.
- Retryable 429/timeout/network/transient-5xx failures retry twice before policy allows fallback. Auth, quota/payment, permission, validation, cancellation, and safety failures never switch providers.
- Search and fetch caches use opaque per-process keys, are bounded, expire independently of later cache traffic, and live only for the loaded extension instance.
- Fetch content is capped at 50,000 characters per source by default and 12,000 characters inline. Oversized content is atomically offloaded to owner-only, TTL-pruned artifacts under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/web-research/artifacts/`; valid artifacts are preserved and new overflow fails closed when capacity is full. `web_fetch` pages stored content by opaque `artifactId` without exposing filesystem paths.
- Search snippets are candidate-discovery material, not confirmation; fetch important sources before making material claims.
- Search results include a conservative URL-derived source type (documentation, repository, community, academic, or independent publication). It is a navigation aid, not a trust score or filter: public results remain eligible regardless of source type.

## Delivery boundary

- Extension code owns routing, validation, cancellation, retries, cache/artifacts, redaction, evidence metadata, and telemetry.
- `skills/my-web-search/` owns provider-neutral research method and source hierarchy.
- `pi/agents/researcher.md` keeps Ciung isolated and preloads the bundled skill.
- Existing 9router and MCP paths coexist until benchmark, dogfood, migration approval, and rollback gates pass.

## Tracker

- [Requirements](REQUIREMENTS.md)
- [Decisions](DECISIONS.md)
- [Implementation tasks](TASKS.md)
- [Roadmap](ROADMAP.md)
- [Backlog](BACKLOG.md)
- [Frozen evaluation cases](evaluation-cases.json)
- [Handoff](HANDOFF.md)

## Credentials

Use `TAVILY_API_KEY` and, when needed, `EXA_API_KEY` in the environment. Never place real credentials in tool arguments, repository files, logs, artifacts, or examples.
