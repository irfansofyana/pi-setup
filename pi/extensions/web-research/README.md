# Native Web Research

First-party Pi web-search and fetch extension backed by direct Tavily and Exa HTTP APIs. The extension and bundled `my-web-search` skill are one reviewed delivery.

## Planned tools

- `web_search` — compact source discovery; Tavily by default and Exa for explicit semantic/code intent.
- `web_fetch` — provider-backed page extraction through Tavily Extract or Exa Contents. Direct local HTTP is deliberately deferred.

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
- [Handoff](HANDOFF.md)

## Credentials

Use `TAVILY_API_KEY` and `EXA_API_KEY` in the environment. Never place credentials in tool arguments, config examples, logs, artifacts, or this repository.
