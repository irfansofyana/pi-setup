---
description: Diagnose a failure with a reproducible evidence loop
argument-hint: "<symptom, reproduction, and optional fix request>"
---
Debug request: $ARGUMENTS

Diagnosis only unless the user explicitly requests a fix. Otherwise do not edit
source or configuration. Never commit or push as part of this workflow.
If the symptom or expected behavior is unclear, ask before testing.

Use the installed diagnosing-bugs skill when available, within this scope.
If unavailable, follow the workflow below; do not install anything implicitly.

1. Read repository instructions. Capture the exact symptom, expected behavior,
   environment/version, recent relevant changes, and any existing evidence.
2. Establish a safe local reproduction and a tight pass/fail signal for this
   specific bug. Ask before destructive, production, or external side effects.
   If reproduction is unavailable, state what is missing rather than guessing.
3. Rank hypotheses. For each, identify a discriminating check; execute the
   smallest safe check and update the hypothesis from actual results.
4. Use trusted global code-mapper (Laya) only when execution-path mapping helps.
   Use inherit_context: false and max_turns: 20 with a self-contained evidence
   packet. Require output_transcript: false in the deployed global role
   configuration, not as an Agent argument. Keep this role read-only and network-free.
   If unavailable, report the limitation; do not substitute project agents or
   broader built-in roles. Use isolated execution outside untrusted repositories.
5. The parent owns command execution and test evidence. Redact credentials and
   sensitive output; distinguish observed facts from inferred causes.
6. If a fix was explicitly requested, prepare a focused regression test,
   observe it fail for this bug, apply the smallest fix, then verify the original
   reproduction and relevant regressions. Stop on failing verification.

Return:
- Reproduction status and exact redacted symptom.
- Root cause with evidence, or ranked hypotheses and missing evidence.
- Smallest fix/proposal, affected files, and risks.
- Checks marked passed, failed, or not run; report commands and outcomes.
