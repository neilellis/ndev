---
name: green-merge-open-prs
description: "Green and merge each eligible open pull request in number order, one at a time, into origin/main."
---

# Green and merge open pull requests

Use this when the user asks you to make their open PRs pass CI and merge them. It does not apply to one PR, a review-only request, or PRs by another person. Running this skill is the user's authorisation to merge.

At the start, create this goal with the goal tool (or a task list if there is no goal tool):

> Get each eligible open PR to pass CI and merge it into `origin/<base>`. An eligible PR has the author `<login>`. Work in ascending PR number order. Finish one PR before work starts on the next. Do not pause the goal until every eligible PR is green and merged.

`<login>` is `@me` (the authenticated user) unless the user names another author. Load `github`, `work-heavy` (or `work-light`), `testing` and `r` before you act. The lead agent owns the queue, decisions, merges and goal state. It can delegate a bounded investigation or fix, but only one PR is active at a time.

## Queue

1. List open PRs by the eligible author:
   ```bash
   gh pr list --state open --author <login> --json number,title,baseRefName,headRefName --jq 'sort_by(.number)'
   ```
2. Record the queue in ascending number order. This is the goal scope. Recheck each item before work starts; another actor can merge or close it.
3. If an item is already merged, verify that `origin/<base>` contains its merge commit, then mark it complete. If it is closed without a merge, record its number and state and keep the goal active. Do not claim success.

## One PR at a time

For the lowest remaining number:

1. Read the PR, reviews, comments, checks, mergeability, base and head. The base must be the repository's default branch.
2. Use the existing head worktree when that is safe. Else make an isolated worktree from the head branch. Keep unrelated uncommitted work.
3. Fix CI failures with the repository workflow: reproduce, add a failing test where it applies, make the smallest fix, run focused checks, then run the repo's precheck command named in its CLAUDE.md. Push only the PR branch, with hooks (never `--no-verify`).
4. After every push, rerun, pending check, review or mergeability change, run exactly:
   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh <pr> --skip-success --json
   ```
   Read the result when it exits. Never poll by hand. A change is not a pass.
5. Read the explicit check results. Merge only when required CI is complete and successful, the PR is mergeable and GitHub permits the merge. Resolve a behind-base state first.
6. Merge through GitHub (`gh pr merge <pr>` with the repository's merge method). Never push directly to the base. Fetch `origin/<base>` and verify that it contains the merge commit before the next item starts.

Do not batch fixes, merges or waits. Never merge with a failed, cancelled, timed-out or pending required check. If a failure needs a user decision or authority, record it and keep the goal active. Do not mark it complete.

Complete the goal only when every PR in the first eligible queue has passed CI and is merged. Report each PR number, its merge SHA and the checks that supported the merge.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
