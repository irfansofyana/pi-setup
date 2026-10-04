---
description: Commit scoped changes and push a branch; optionally open a PR or MR
argument-hint: "[scope, remote/branch, and optional PR or MR request]"
---
Commit and push request: $ARGUMENTS

Default: commit relevant changes and push one explicitly selected remote branch.
Create a pull request (PR) or merge request (MR) only when explicitly requested.
This is not publishing: no package publishing, releases, tags, deployment, merge,
or automatic deletion of branches. The parent owns every Git and host CLI action;
do not delegate these mutations to subagents.

1. Read repository instructions. Inspect current branch, full Git status,
   staged/unstaged diffs, relevant untracked files, remotes, upstream, recent
   commits, and ahead/behind state. Redact credentials in URLs and output.
   Establish the task's file/commit scope and destination remote/branch.
   Ask before mutation when scope, destination, ownership, fork, or host is
   ambiguous. Stop on detached HEAD or a default/protected branch and ask for
   an approved feature branch; do not push directly to a protected branch.
2. Review every outgoing commit and its diff, not only new working-tree changes.
   If outgoing history includes unrelated work, ask before pushing it.
   Check for secrets and accidental artifacts without exposing sensitive values.
3. Run the appropriate verification for the scoped change. Stop on failures.
   If required checks cannot run, report the gap and obtain explicit approval
   before continuing. Never claim unrun checks passed.
4. Stage only explicit approved paths or hunks. Never use blanket staging such
   as git add . or git add -A. Preserve unrelated working-tree and staged changes;
   if the index contains out-of-scope changes, stop and ask rather than
   unstaging them. Inspect the staged diff, then create a descriptive commit.
   Respect hooks; do not use --no-verify or amend existing commits.
   If nothing needs committing, do not create an empty commit.
5. Re-read Git state and outgoing history immediately before pushing. Stop on
   drift, unexpected divergence, or rejected push. Use an ordinary Git push with
   an explicit remote and one branch ref; set upstream when needed.
   Never force-push, rewrite history, rebase, reset, clean, or retry destructively.
   Confirm the intended remote branch resolves to the pushed local commit.
6. If a PR/MR was requested, identify the hosting service from the selected
   repository/remote, not the presence of an installed CLI:
   - GitHub: use gh. Select the exact repository with --repo and explicit
     --head/--base when using gh pr create to avoid implicit forks or pushes.
   - GitLab: use glab. Select the exact repository with --repo and explicit
     --source-branch/--target-branch when using glab mr create.
   For self-hosted or unclear providers, ask rather than guessing.
   Verify the required CLI is installed and authenticated; never print tokens.
   If unavailable, report the blocker without installing or logging in implicitly.
7. Inspect the installed CLI help before choosing flags. Reuse an existing open
   PR/MR only when source repository/branch and target repository/branch match.
   Do not create duplicates or change existing PR/MR metadata unless requested.
   For a new PR/MR, supply an explicit title and body/description based on the
   actual change, verification, and risk. Follow repository templates and use
   the installed pr skill when available; otherwise keep the body concise.
   Avoid auto-push flags such as glab --fill or --push. Use only the reviewed,
   already-pushed source branch; do not create forks or merge the request.

Report completed steps and blockers honestly:
- Committed files and commit SHA, or why no commit was needed.
- Selected remote/branch and verified pushed SHA.
- Verification outcomes and remaining worktree changes.
- PR/MR URL only if explicitly requested and created or verified.
- Any partial completion; never undo a successful push automatically.
