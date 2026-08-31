# Roadmap: Native Web Research

## Phase 0 — Contract and tracker

Status: complete

- Approved requirements copied into the extension folder.
- Decisions, implementation tasks, roadmap, backlog, evaluation cases, and handoff tracked beside the code.

## Phase 1 — One package delivery

Status: complete

- Native Tavily and Exa adapters over direct provider API HTTP.
- `web_search` and provider-backed `web_fetch`.
- Cancellation, bounded retries, normalized errors, redaction, observable routing.
- Bounded cache and owner-only artifact storage.
- Bundled `my-web-search` skill.

## Phase 2 — Ciung integration

Status: complete in repository; live-device deployment remains approval-gated

- Preload `my-web-search`.
- Replace Ciung's source template tool allowlist with native read-only web tools.
- Preserve fresh context, no local tools, no transcript persistence, and compact claim ledger.
- Keep migration proposal and rollback explicit for existing devices.

## Phase 3 — Verification and dogfood

Status: in progress

- [x] Focused and full automated suites.
- [x] Strict isolated TypeScript check for the new extension.
- [x] Package dry-run and Pi strict-tool-allowlist load smoke test.
- [x] Frozen research cases checked into `evaluation-cases.json`.
- [ ] Independent standards/specification review loop.
- [ ] PR CI and automated PR review on the exact pushed commit.
- [ ] Baseline-versus-skill comparison.
- [ ] Live provider and fresh-context Ciung smoke tests when credentials are available and deployment is approved.
- [ ] Side-by-side comparison with legacy routes before deprecation.

## Phase 4 — Later research orchestration

Status: deferred

- Code-backed claim/evidence ledger.
- Adaptive rounds and contradiction review.
- Durable report export.
- Direct local target-URL HTTP only after its SSRF, redirect, DNS-rebinding, and subresource boundary is separately approved and verified.
