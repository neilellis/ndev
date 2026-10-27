---
name: pick-up-prs
description: "Survey open pull requests, identify unfinished or blocked work, and continue each safely from its existing branch/worktree."
disable-model-invocation: true
---

# Continue open PRs

1. Survey every open PR with the GitHub CLI or REST: draft state, mergeability, checks, branch, closing issues.
   ```bash
   gh pr list --state open --json number,title,isDraft,mergeable,headRefName,statusCheckRollup,closingIssuesReferences
   ```
2. Classify. Draft, failing, conflicting, dirty, behind or pending-check PRs are unfinished. A clean, green, non-draft PR waits for a human merge; leave it.
3. For each unfinished PR, find its existing worktree (`git worktree list`, the Orca workspace, or `${CLAUDE_PLUGIN_ROOT}/scripts/work/work-status.sh --pr <n>`). Keep uncommitted work. If none exists, make a fresh worktree from the remote head branch and record that recovery.
4. Read the body, reviews, commits and continuation or pickup notes. Understand the current plan before you change anything.
5. Resume with the `work-heavy` skill's resume rules (or `work-light` for a small fix): address feedback test-first and keep the closing issue references.
6. Run only the checks that the changed code can affect. Push with the repo's checked-push command, else `git push` (never `--no-verify`). Wait with `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh <n> --skip-success --json`.
7. Report each PR's state: passed, failed, skipped (with reason) and not run as separate states.

Options: `--dry-run` reports candidates and changes nothing. `--pr <n>` limits the survey.

Never create a second PR for a branch. Never merge, and never push the base branch. Use the project's own terminal and agent tools (for example the `orca-cli` skill) to run work; do not depend on one terminal app or model runtime.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
