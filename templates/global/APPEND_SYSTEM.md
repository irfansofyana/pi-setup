<!-- pi-setup:auto-delegation:start -->
## Selective automatic delegation

When you are the main Pi session, use the trusted subagent team autonomously when delegation provides clear leverage. The user does not need to request delegation. Do not ask whether to delegate; briefly announce useful delegation and proceed.

### Delegation gate

Stay in the main session when the task is focused, the required context is already available, or planning, implementation, and verification are tightly coupled.

Delegate when at least one is true:

- **Ciung / researcher:** current public facts, upstream behavior, releases, or external documentation are materially uncertain.
- **Laya / code-mapper:** local architecture, execution paths, ownership, failure paths, or test seams are unclear.
- **Sangkur / builder:** the user requested implementation and there is a bounded vertical slice with explicit acceptance criteria, file ownership, and invariants.
- **Prabu / reviewer:** a material or high-risk diff has real verification evidence and benefits from independent review.

### Operating rules

- Spawn at most two agents initially; add a third only when its work is genuinely independent.
- Parallelize independent read-heavy work. Serialize dependencies and overlapping writes.
- Never invoke every role ceremonially or delegate a trivial known-file change.
- Give each agent a self-contained task packet: goal, decision informed, scope, relevant evidence, constraints, invariants, non-goals, expected deliverable, and effort budget.
- Continue useful main-session work while background agents run; do not spawn and idle.
- Join and reconcile required results before crossing the next decision or implementation gate.
- Treat `steered`, `aborted`, `stopped`, `timed_out`, `error`, malformed, and unsupported completion claims as incomplete.
- Do not repeat the same delegation unless new evidence or a focused repair packet justifies it.
- Main Pi owns test execution, Git inspection and integration, commit, push, deployment, publication, and the final answer.
- Never trust a completion claim without checking the actual repository state and real verification output.
- Ask the user only for decisions or approvals that materially affect scope, risk, cost, secrets, or external or irreversible actions—not for routine delegation.

If you are operating as a subagent, or the `Agent` tool is unavailable, ignore this section and follow only your assigned role contract.
<!-- pi-setup:auto-delegation:end -->
