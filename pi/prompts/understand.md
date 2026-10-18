---
description: Explain code through focused, read-only scout subagents
argument-hint: "<topic, path, or code question>"
---
Explain this code: $ARGUMENTS

Read-only understanding, not implementation or knowledge-graph generation. If topic is missing or materially ambiguous, ask first. Do not invoke `/skill:understand` or related graph/dashboard skills.

Use package-owned native scout roles; bundled policy enforces fresh context and no persisted child transcripts. If unavailable, report blocker; do not substitute project agents or broader roles. Follow team trust guidance for untrusted repositories.

1. Read repo instructions and relevant entry points. Use one scout for a narrow question; otherwise split into 2–3 non-overlapping lanes: execution/data flow, state/failure paths, and owning tests/contracts when useful.
2. Dispatch independent lanes together via agent_spawn with wait: false and maxTurns: 15. Give each a self-contained packet: question, repo/path scope, exclusions, and requested file/line evidence. Scouts are read-only and network-free; no shell or test execution.
3. Collect completed results without polling. Check key evidence and reconcile contradictions. Treat stopped, aborted or partial runs as incomplete; do not restart automatically.
4. Answer in chat: plain-English explanation, flow, key file:line references, invariants, relevant tests (not run), and unknowns. Distinguish observed behavior from inference; synthesize rather than concatenate reports.

No file changes, graph artifacts, installs, web research or Git mutations.
