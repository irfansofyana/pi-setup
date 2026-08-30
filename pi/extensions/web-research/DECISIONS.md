# Decisions: Native Web Research

Date: 2026-08-30

1. The main agent keeps `web_search` and `web_fetch`; multi-source or iterative research goes to Ciung.
2. Deeper research starts through the existing `Agent` tool, not a new `web_research` tool.
3. First release fetches through Tavily Extract and Exa Contents; direct local HTTP is deferred.
4. Artifacts use a bounded task/session cache with explicit handles/export; no automatic project knowledge store.
5. `my-web-search` is a bundled first-party skill containing methodology and source hierarchy.
6. Extension and skill ship as one package version/tag and share verification, migration, and rollback.
7. Tavily is the ordinary default; Exa is selected explicitly or for declared semantic/code intent.
8. Provider changes and fallbacks are observable; auth, quota, validation, policy, and safety failures never silently switch providers.
9. Existing 9router and MCP installations remain during side-by-side evaluation and are removed only through explicit approved migration.
10. Branch must be rebased on `origin/main` immediately before final push.
