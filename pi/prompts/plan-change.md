---
description: Define an evidence-backed change plan before implementation
argument-hint: "<requested change>"
---
Plan this change: $ARGUMENTS

Planning only. Do not edit files, implement changes, commit, or push.
If the requested change is missing or materially ambiguous, ask first.

1. Read repository instructions and the relevant requirements. State the user
   outcome, scope, explicit non-goals, and observable acceptance criteria.
2. Use the trusted global code-mapper (Laya) to trace the existing behavior,
   owning files, invariants, failure paths, and test seams.
   Use inherit_context: false, run_in_background: true, and max_turns: 20
   with a self-contained task packet. Require output_transcript: false in the
   deployed global role configuration, not as an Agent argument.
   If the global role is unavailable, report the blocker; do not substitute
   project agents or a broader built-in role. Use isolated execution outside
   untrusted repositories, following the agent team's trust guidance.
3. Add one trusted global Ciung research lane only when external factual
   uncertainty affects the decision. Use bundled my-web-search and sanitized
   public questions; never send local file contents or private identifiers.
4. Join complete results without polling. Compare the smallest viable approach
   with meaningful alternatives. Identify compatibility, migration, security,
   operational risks, and rollback needs.
5. Divide the preferred approach into bounded vertical slices. For each slice,
   identify files that must change, files that must not change, invariants,
   acceptance criteria, and commands the parent should use for verification.
   Treat stopped, aborted, cancelled, or steered evidence as incomplete.

Return:
- Recommended approach and trade-offs.
- Numbered implementation steps with completion criteria.
- Verification plan and rollback considerations.
- Open decisions and blockers.
- Explicit approval gate: stop here and wait for implementation approval.
