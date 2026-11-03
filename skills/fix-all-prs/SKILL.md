---
name: fix-all-prs
description: "Fix and merge every outstanding open pull request one at a time, oldest first, working with the agents that already worked on each pull request. Use when the user asks to fix all PRs, clear the PR queue, or get every open PR green and merged."
---

# Fix all pull requests

Fix each open PR one at a time, oldest first. Merge it when it is fixed. Then merge `origin/<base>` into the next PR, fix it and merge it. Repeat until no open PRs remain.
Where an agent has already worked on a PR, work with that agent. It has context that you do not have.

## The workflow

A worker on a PR calls `mcp__ndev__started(issue)` to resume its record, commits with `mcp__ndev__checkpoint`, and ends with `mcp__ndev__done`. This pass reads GitHub at most each 15 minutes. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Before you start

1. Read the repository's CLAUDE.md and AGENTS.md. Where they name a push script, a wait helper, a precheck or a fix-CI skill, use it. The repository's rules win over this skill, but this skill authorises the merge.
2. List open PRs by the authenticated user, oldest first:
   ```bash
   gh pr list --state open --author @me --json number,title,createdAt,headRefName,isDraft --jq 'sort_by(.createdAt)'
   ```
   This is the queue. Include another author's PR only when the user says so.
3. List the agents you can reach (`ListAgents`, or Orca terminals through the `orca-cli` skill). Match each agent to a PR by name, worktree path or branch (for example `issue-168`, `pr-190`, `claude/issue-168`). Record the match, or that none exists.

## The loop

Take the oldest remaining PR. Finish it before you start the next. Never fix two PRs at the same time.

1. **Recheck its state.** If it is merged, confirm that `origin/<base>` contains it and go to the next. If it is closed without a merge, record that and go to the next.
2. **Bring it up to date.** In the PR's worktree (or a new worktree on its head branch), fetch and merge `origin/<base>`. Resolve conflicts with the `resolving-merge-conflicts` skill. Never use a bare `git stash`; all worktrees share the stash.
3. **Ask the owning agent first.** If an agent matches, send it (`SendMessage`) the PR number, the failing checks or conflicts and the open review comments. Ask it to fix them, push and reply when finished or blocked. Wait for the reply; never edit the same files at the same time. If it does not reply, or it is blocked on something you can do, fix the PR yourself.
   If no agent matches, or the matched agent is no longer listed, start a Claude agent in Orca (the `orca-cli` skill). This is the last recourse. If you cannot list the agents, fix the PR yourself instead: the owner can still be at work on it. If the owner is listed later, stop and give the PR to it. Use the Orca worktree that holds the PR (linked to it, or on its head branch, never a main checkout), else a new one: `orca worktree create --name pr-<n> --base-branch origin/<head branch> --reference <PR URL> --agent claude --prompt <brief>`. The brief gives steps 2 to 5, tells the agent to push to `HEAD:<head branch>`, and tells it to message you when it has pushed or is blocked. Then work with it as the owning agent. Ask no other agent while you wait for its session. If Orca cannot list its worktrees or start an agent, record the PR as blocked with Orca's output. If its session is not listed within 30 minutes, record the PR as blocked and name the workspace to look at.
4. **Fix it.** Read the failing checks, review comments and mergeability. Reproduce each failure, add a failing test where one applies, make the smallest fix and run the focused checks. Address each open review comment.
5. **Push and wait.** Push only the head branch, with the repository's push script if it has one (never `--no-verify`). Wait with one blocking helper, for example `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh <pr> --skip-success --json`. Never poll by hand. A finished wait is not a pass: read each check's result.
6. **Merge.** Merge only when every required check passed and the PR is mergeable. Mark a finished draft ready first. Merge through GitHub (`gh pr merge <pr> --merge`, or the repository's method). Never push to the base directly. Fetch `origin/<base>` and confirm that it contains the merge commit.
7. **Tell the agent.** If an agent owned the PR, tell it the PR is merged so it can stop and clean up its worktree.
8. Go to the next PR. Step 2 merges the new base into it.

## Stop and ask

Stop, ask the user, and do not merge when:

- a fix needs a product or design decision that the PR and its issue do not settle;
- the fix would weaken, skip or silence a check;
- a reviewer asked for changes that you cannot make.

Record the blocked PR with its reason, then continue with the next one in sequence.

## Report

List each PR in the queue as merged (with the merge SHA), blocked (with the reason), closed, or skipped (with the reason). Name the agent that fixed each one. Say which checks you did not run.

Once you have user feedback that unblocks you start on that PR(s) in the same sequential manner.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
