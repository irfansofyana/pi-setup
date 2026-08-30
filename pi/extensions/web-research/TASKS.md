# Tasks: Native Web Research

Spec: `REQUIREMENTS.md`  
Date: 2026-08-30

## Task 1 — Tavily search tracer bullet

Blocked by: none  
Seam under test: registered `web_search` tool through an injected HTTP transport.

1. Write a failing test for registration, request mapping, compact normalization, and metadata.
2. Observe expected failure.
3. Implement the smallest Tavily adapter and tool registration.
4. Observe focused and extension suites passing.
5. Commit.

## Task 2 — Exa selection and safe fallback

Blocked by: Task 1  
Seam under test: provider router through `web_search`.

Test explicit Exa selection, declared semantic/code intent, Tavily default, empty/transient fallback, and no fallback on auth/validation/quota failures.

## Task 3 — Provider-backed fetch

Blocked by: Task 2  
Seam under test: registered `web_fetch` tool through Tavily Extract and Exa Contents fixtures.

Test per-URL success/failure, focused passages, output bounds, and absence of direct local HTTP.

## Task 4 — Lifecycle hardening

Blocked by: Tasks 2 and 3  
Seam under test: provider transport and artifact store public behavior.

Test cancellation, deadline composition, retry classes and `Retry-After`, redacted failures, bounded cache, owner-only atomic artifacts, TTL and size pruning, and compact telemetry.

## Task 5 — Bundled research skill

Blocked by: Task 1  
Seam under test: package contract and skill content contract.

Test package discovery, narrow trigger, provider-neutral methodology, source hierarchy, fetched-body evidence rule, contradiction handling, and no stale 9router/MCP tool names.

## Task 6 — Ciung and migration

Blocked by: Tasks 3 and 5  
Seam under test: agent-template and owning documentation contracts.

Test exact native tool allowlist, `my-web-search` preload, isolation invariants, coexistence/rollback instructions, and setup audit ownership.

## Task 7 — Delivery verification

Blocked by: all implementation tasks  
Seam under test: repository package as installed artifact.

Run focused/full tests, typecheck/import smoke, npm pack dry-run, credential-gated live smoke, independent standards/spec reviews, rebase, PR CI, and Codex review.
