# Roadmap: Native Web Research

## Phase 0 — Contract and tracker

Status: in progress

- Approved requirements copied into the extension folder.
- Decisions, implementation tasks, roadmap, backlog, and handoff tracked beside the code.

## Phase 1 — One package delivery

Status: pending

- Native Tavily and Exa adapters over direct HTTP.
- `web_search` and provider-backed `web_fetch`.
- Cancellation, bounded retries, normalized errors, redaction, observable routing.
- Bounded cache and owner-only artifact storage.
- Bundled `my-web-search` skill.

## Phase 2 — Ciung integration

Status: pending

- Preload `my-web-search`.
- Replace Ciung's active tool allowlist with native read-only web tools.
- Preserve fresh context, no local tools, no transcript persistence, and compact claim ledger.
- Keep migration proposal/rollback explicit for existing devices.

## Phase 3 — Verification and dogfood

Status: pending

- Focused and full automated suites.
- Package dry-run and Pi load smoke test.
- Frozen research cases and baseline-versus-skill comparison.
- Live provider smoke tests when credentials are available.
- Side-by-side comparison with legacy routes before deprecation.

## Phase 4 — Later research orchestration

Status: deferred

- Code-backed claim/evidence ledger.
- Adaptive rounds and contradiction review.
- Durable report export.
- Direct local HTTP only after its SSRF, redirect, DNS-rebinding, and subresource boundary is separately approved and verified.
