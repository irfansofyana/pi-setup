---
description: Assess a capability against public evidence and this codebase
argument-hint: "<capability or design question>"
---
Investigate this capability or design question: $ARGUMENTS

Research and proposal only. Do not edit files or implement changes.
If the capability or question is missing, ask before dispatching agents.

Use trusted global researcher (Ciung) and code-mapper (Laya) definitions.
If either global role is unavailable, report the blocker; do not substitute
project agents or broader built-in roles. Use isolated execution outside
untrusted repositories, following the agent team's trust guidance.

1. Define the decision, acceptance criteria, scope, and relevant versions.
2. Run two independent lanes in one parallel batch:
   - Ciung: official capabilities, existing solutions, constraints, and
     counterevidence, using bundled my-web-search.
   - Laya: current implementation, ownership boundaries, relevant tests,
     invariants, and likely change surface, with file/line evidence.
3. Use inherit_context: false, run_in_background: true, and max_turns: 20.
   Require output_transcript: false in the deployed global role configuration,
   not as an Agent argument. Give each specialist a self-contained task packet
   with questions, exclusions, evidence, budget, and deliverable.
4. Send only sanitized public questions to Ciung. Keep private URLs, local file
   contents, personal data, proprietary identifiers, and credentials out of
   web requests. Keep repository evidence with Laya.
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
