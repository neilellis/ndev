---
name: fix-all-prs
description: "Fix and merge every outstanding open pull request one at a time, oldest first, working with the agents that already worked on each pull request. Use when the user asks to fix all PRs, clear the PR queue, or get every open PR green and merged."
---

# Fix all pull requests

Read [the ndev CLI skill](${CLAUDE_PLUGIN_ROOT}/skills/cli/SKILL.md) for native commands and when to use them. Prefer those commands for workflow operations when `ndev` is available. Keep this skill's gates and ownership rules.

Fix each open PR one at a time, oldest first. Merge it when it is fixed. Then merge `origin/<base>` into the next PR, fix it and merge it. Repeat until no open PRs remain.
Where an agent has already worked on a PR, work with that agent. It has context that you do not have.

## Start the recorded queue

Read the repository's CLAUDE.md and AGENTS.md first. Check their merge requirements and select the queue's merge option before starting it: `start` can merge a green PR immediately.

Inspect existing workers before `start` or `resume`. If a worker already edits an open PR, complete its handoff or stop its editing before starting the queue. The command can dispatch a worker immediately.

Run the queue from the coordinator's worktree before you launch a worker:

```bash
ndev fix-prs status --json
ndev fix-prs start --json
```

Use `start` when no run is recorded or the recorded phase is `done`. For a paused run, use `ndev fix-prs resume --json`. Keep an existing running queue. Do not restart it. The run belongs to this worktree. `start` records the queue, publishes the **Fix all PRs** panel and dispatches its worker. A manual PR list, an Orca message or a separately launched worker does not register this run.

Use `ndev fix-prs start --no-merge --json` when the user wants repairs only. Use it also when the repository requires a merge procedure the queue cannot perform. For example, migrations can require the merge skill. Complete those merges through that procedure.

Read the start receipt, then run `ndev fix-prs status --json` once to verify the recorded phase, current PR and worker. Report that state to the human. If the panel still says “No run is recorded for this worktree”, check the coordinator's worktree and the command's error. Do not substitute an orchestration worker for the missing queue record.

The queue owns ordering, dispatch and its 15-minute GitHub checks. Do not launch a second worker or run a second queue beside it. If work was already delegated, inspect the existing worker and arrange a handoff before the queue's worker edits the PR. A message receipt proves acceptance. Check the dispatch receipt before claiming that an agent started.

Workers report to the coordinator's recorded queue:

```bash
ndev fix-prs report <pr> pushed --worktree <coordinator-path>
ndev fix-prs report <pr> blocked --reason "<reason>" --worktree <coordinator-path>
```

Use `ndev fix-prs pause`, `resume`, `skip <pr>` and `retry <pr>` for queue controls. Do not edit its state files. A worker resumes the existing issue and PR with `ndev flow start`, commits with `ndev flow checkpoint`, and ends with `ndev flow done`. Check the PR binding first: a local alias branch must not open a duplicate PR. The workflow guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

The sections below describe the repair work of the assigned owner. They do not authorise a second dispatch beside the recorded queue.

## Before you start

1. Read the repository's CLAUDE.md and AGENTS.md. Where they name a push script, a wait helper, a precheck or a fix-CI skill, use it. Follow the merge requirements in those files. This skill authorises the merge when those requirements are met.
2. Use the recorded queue, which lists open PRs by the authenticated user, oldest first. For a read-only diagnosis outside a running queue:
   ```bash
   gh pr list --state open --author @me --json number,title,createdAt,headRefName,isDraft --jq 'sort_by(.createdAt)'
   ```
   This is the queue. Include another author's PR only when the user says so.
3. Before a manual repair, list the agents you can reach (`ListAgents`, or Orca terminals through the `orca-cli` skill). Match each agent to a PR by name, worktree path or branch (for example `issue-168`, `pr-190`, `claude/issue-168`). Record the match, or that none exists.

## The assigned repair

Take the oldest remaining PR. Finish it before you start the next. Never fix two PRs at the same time.

1. **Recheck its state.** If it is merged, confirm that `origin/<base>` contains it and go to the next. If it is closed without a merge, record that and go to the next.
2. **Bring it up to date.** In the PR's worktree (or a new worktree on its head branch), fetch and merge `origin/<base>`. Resolve conflicts with the `resolving-merge-conflicts` skill. Never use a bare `git stash`; all worktrees share the stash.
3. **Keep one owner.** Use the worker recorded by the queue. Ask a previous owning agent for context through Orca when one matches the PR. Do not ask it to edit while the queue's worker owns the repair. New agents use Codex. If the recorded dispatch fails, inspect its receipt and record the blocker before retrying through `ndev fix-prs retry <pr>`. Never launch a replacement beside a worker whose exit is unproved.
4. **Fix it.** Read the failing checks, review comments and mergeability. Reproduce each failure, add a failing test where one applies, make the smallest fix and run the focused checks. Address each open review comment.
5. **Push and wait.** While a workflow runs, commit with `ndev flow checkpoint` and let the workflow watch the checks. With no workflow, push only the head branch, with the repository's push script if it has one (never `--no-verify`). Wait with one blocking helper, for example `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh <pr> --skip-success --json`. Never poll by hand. A finished wait is not a pass: read each check's result.
6. **Merge.** Merge only when every required check passed and the PR is mergeable. Mark a finished draft ready first. Merge through GitHub (`gh pr merge <pr> --merge`, or the repository's method). A PR with migrations merges through `ndev:merge`, which runs them. Never push to the base directly. Fetch `origin/<base>` and confirm that it contains the merge commit.
7. **Tell the agent.** If an agent owned the PR, tell it the PR is merged so it can stop and clean up its worktree.
8. Go to the next PR. Step 2 merges the new base into it.

## Stop and ask

Stop, ask the user, and do not merge when:

- a fix needs a product or design decision that the PR and its issue do not settle;
- the fix can weaken, skip or silence a check;
- a reviewer asked for changes that you cannot make.

Record the blocked PR with its reason, then continue with the next one in sequence.

## Report

List each PR in the queue as merged (with the merge SHA), blocked (with the reason), closed, or skipped (with the reason). Name the agent that fixed each one. Say which checks you did not run.

Once you have user feedback that unblocks you start on that PR(s) in the same sequential manner.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
