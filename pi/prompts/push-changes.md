---
description: Quickly commit, push and create or reuse a PR/MR
argument-hint: "[scope, destination, base branch, or push only]"
---
Ship current task changes: $ARGUMENTS

Default: commit, push, create or reuse a PR/MR. "push only" skips PR/MR.
Use conversation scope, current feature branch and existing upstream.
Proceed without another confirmation when those are clear.

1. Check repo instructions, status and diffs (including outgoing commits) for unrelated work, secrets and artifacts. Stage explicit paths/hunks only; preserve unrelated work. Stop if index or outgoing history includes unrelated changes, or branch is detached/default/protected.
2. Reuse fresh checks for unchanged content. Otherwise run the smallest required checks and `git diff --check`. Stop on failures; ask before skipping required checks. No optional full suites or CI waiting unless requested.
3. Review staged diff, make a descriptive commit (skip if nothing to commit), honor hooks. Recheck branch/remote state, push an ordinary explicit remote/branch ref, verify remote SHA. Stop on divergence, drift or rejected push.
4. Unless push-only, detect host from remote: GitHub `gh`, GitLab `glab`; ask if unclear. Use exact repo/head/base; infer base from a matching open PR/MR or repo default. Reuse that request, otherwise create from the already-pushed branch with a concise title/body and checks/gaps. No duplicate requests or edits to existing metadata. If CLI/auth is unavailable, report blocker; no automatic installs, login or forks.

Ask only for unsafe or genuinely ambiguous scope/destination/base. Parent owns mutations; no delegation. Keep secrets redacted. No force-push, history rewrites, hook bypass, tags, releases, publishing, deployment or merge.

Report commit SHA, pushed remote/branch, PR/MR URL, checks/gaps and remaining changes. Keep brief.
