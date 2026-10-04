---
description: Research a topic through parallel evidence-first specialists
argument-hint: "<topic and decision>"
---
Research request: $ARGUMENTS

Research only. Return findings in chat; do not edit files or implement changes.
If the topic is missing, ask before dispatching agents.

Use trusted global researcher (Ciung) definitions with bundled my-web-search.
If the required global role is unavailable, report the blocker; do not substitute
project agents or a broader built-in role. Use isolated execution outside
untrusted repositories, following the agent team's trust guidance.

1. Define the decision, scope, exclusions, and freshness/version requirements.
   Ask only when missing information would materially change the research.
2. Divide the question into 2–3 non-overlapping lanes. Cover authoritative facts,
   practical examples, and limitations or counterevidence as appropriate.
   Generate focused candidate queries for each lane.
3. Launch the lanes in one parallel batch with inherit_context: false,
   run_in_background: true and max_turns: 15. Require output_transcript: false
   in the deployed global role configuration; do not pass it as an Agent argument.
4. Give each agent a self-contained, sanitized public task packet: objective,
   questions, exclusions, date/version requirements, evidence already collected,
   budget, and required deliverable. Keep private URLs, local file contents,
   personal data, proprietary identifiers, and credentials out of web requests.
5. Apply my-web-search's evidence gate: fetch material sources, distinguish
   released behavior from main, and record contradictory evidence.
6. Join complete results without polling. Reconcile disagreements and inspect
   decisive evidence. Stopped, aborted, cancelled, or steered results are
   incomplete; label unresolved claims instead of claiming completion.

Return:
- Direct answer or recommendation.
- Findings grouped by research question.
- Claim ledger: claim | confirmed/inferred/unknown | source | date/version.
- Contradictions, unknowns, retrieval failures, and next decision.
