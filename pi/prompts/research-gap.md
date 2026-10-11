---
description: Compare user-visible capabilities with reference systems
argument-hint: "<our feature and reference systems>"
---
Compare our implementation with reference systems: $ARGUMENTS

Produce a gap analysis, not implementation. Do not edit files.
If our feature or the reference systems are missing, ask before dispatching.

Use the package-owned native scout and researcher roles.
If required native roles are unavailable, report the blocker; do not substitute
project agents or broader built-in roles. Use isolated execution outside
untrusted repositories, following the agent team's trust guidance.

1. Define comparison criteria from the user's point of view. Identify reference
   versions and distinguish released behavior from repository main.
2. Run scout on our actual implementation and 1–2 researcher lanes on independent
   public references in one parallel batch. Use at most three concurrent agents.
3. Use agent_spawn with wait: false and maxTurns: 20. Bundled role policy
   enforces fresh context and no persisted child transcripts.
   Supply self-contained task packets with scope,
   questions, exclusions, evidence requirements, budget, and deliverable.
4. Keep local evidence with scout. Give researcher bundled my-web-search and sanitized
   public questions; keep private URLs, local file contents, personal data,
   proprietary identifiers, and credentials out of web requests.
5. Join complete results without polling. Apply my-web-search's evidence gate.
   Stopped, aborted, cancelled, or steered results are incomplete.
6. Compare observed behavior rather than matching names or internal architecture.
   Missing documentation is not proof that a feature is absent. Distinguish
   parity, meaningful gaps, intentional differences, and unknown behavior.

Return:
- Overall verdict.
- Matrix: user capability | ours | reference | evidence | gap.
- Confirmed/inferred/unknown labels and relevant source versions.
- Prioritized gaps by user impact, not feature count.
- Smallest worthwhile improvement, risks, and deliberate non-goals.
