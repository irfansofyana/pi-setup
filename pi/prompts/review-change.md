---
description: Independently review changes against standards and requirements
argument-hint: "[base revision, scope, or review focus]"
---
Review request: $ARGUMENTS

Read-only review. Do not edit files, implement fixes, commit, or push.

1. Read repository instructions and establish the base/head revisions, actual
   change scope, requirements, acceptance criteria, and explicit non-goals.
   If no base is supplied, review current working-tree changes, including
   staged, unstaged, and relevant untracked files. Ask when scope is ambiguous.
2. The parent collects the actual diff, affected-file context, and verification
   evidence. Run appropriate safe checks when feasible; mark other checks not
   run. Reviewers cannot execute shell commands or tests.
3. Use two trusted global reviewer (Prabu) instances in one parallel batch:
   - Standards lane: documented repository rules, ownership, compatibility,
     security, and maintainability.
   - Spec lane: requirements, correctness, acceptance criteria, failure paths,
     and test coverage.
4. Use inherit_context: false, run_in_background: true, and max_turns: 20.
   Require output_transcript: false in the deployed global role configuration,
   not as an Agent argument. Supply each lane a self-contained task packet with
   actual diff, affected-file context, criteria, exact redacted test outcomes,
   gaps, exclusions, and required deliverable. Keep reviewers read-only and
   network-free; they may not spawn nested agents.
   If the global role is unavailable, report the blocker; do not substitute
   project agents or broader built-in roles. Use isolated execution outside
   untrusted repositories, following the agent team's trust guidance.
5. Join complete results without polling. Treat stopped, aborted, cancelled,
   or steered runs as incomplete. Verify findings against actual code,
   deduplicate overlap, and distinguish blockers from optional improvements.
   Keep the lanes focused; do not start an automatic repair loop.

Return:
- Verdict: approve, approve with follow-up, or request changes.
- Standards and spec findings, each with severity, file/line evidence,
  violated requirement/invariant, impact, and smallest fix.
- Test gaps, unverified assumptions, and residual risk.
- If no material findings exist, say so; never claim proof of no bugs.
