---
description: Assess a capability against public evidence and this codebase
argument-hint: "<capability or design question>"
---
Investigate this capability or design question: $ARGUMENTS

Research and proposal only. Do not edit files or implement changes.
If the capability or question is missing, ask before dispatching agents.

Use the package-owned native researcher and scout roles.
If either native role is unavailable, report the blocker; do not substitute
project agents or broader built-in roles. Use isolated execution outside
untrusted repositories, following the agent team's trust guidance.

1. Define the decision, acceptance criteria, scope, and relevant versions.
2. Run two independent lanes in one parallel batch:
   - Researcher: official capabilities, existing solutions, constraints, and
     counterevidence, using bundled my-web-search.
   - Scout: current implementation, ownership boundaries, relevant tests,
     invariants, and likely change surface, with file/line evidence.
3. Use agent_spawn with wait: false and maxTurns: 20. Bundled role policy
   enforces fresh context and no persisted child transcripts.
   Give each specialist a self-contained task packet
   with questions, exclusions, evidence, budget, and deliverable.
4. Send only sanitized public questions to researcher. Keep private URLs, local file
   contents, personal data, proprietary identifiers, and credentials out of
   web requests. Keep repository evidence with scout.
5. Join complete results without polling. Apply my-web-search's evidence gate
   to public claims; reconcile those claims with actual local code.
   Distinguish supported behavior, local limitations, and unverified assumptions.
   Treat stopped, aborted, cancelled, or steered runs as incomplete.

Return:
- Recommendation: reuse, extend, build, or defer.
- External source/date evidence and local file/line evidence.
- Smallest viable approach and meaningful alternatives.
- Files affected, invariants, risks, and verification plan.
- Unknowns and decisions needing approval before implementation.
