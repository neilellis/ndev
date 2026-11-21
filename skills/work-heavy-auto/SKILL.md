---
name: work-heavy-auto
description: "The non-interactive heavyweight development skill (heavy mode, auto steering). Deliver the issues in the GitHub project board's Ready column through isolated, PR-only work, one PR per unit, with continuation state for blockers and human review before merge. Use when the user asks to work the Ready column, run a board pass, or run work-heavy-auto with --dry-run or --issue <n>."
---

# Ready-board delivery

Read [the ndev CLI skill](${CLAUDE_PLUGIN_ROOT}/skills/cli/SKILL.md) for native commands and when to use them. Prefer those commands for workflow operations when `ndev` is available. Keep this skill's gates and ownership rules.

Read the applicable parts of the project’s `NORTH_STAR.md`.

Do one bounded pass: read the board, sort the startable issues, work each unit in its own worktree, branch and PR, verify it, smoke-test it where the project has a preview, and leave each PR for a human to merge. Never merge. Never push the base branch.

## The workflow

A worker in its own session or Orca workspace calls `mcp__ndev__started(issue, shortName)`, then `mcp__ndev__setSteering` with `auto` and the reason, as no human answers an unattended run, and follows each answer until `mcp__ndev__done`. A subagent cannot move a workflow, so an `issue-implementer` subagent follows the stages of its brief and files other work with `mcp__ndev__followUp` with `issue_only`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

With a subagent worker or no workflow, ask the user for authorisation immediately before each GitHub write and each preview deployment. Read-only discovery can run without a prompt.

## Settings

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
```

Take the board from the arguments or the project's `CLAUDE.md`: `GH_PROJECT_OWNER`, `GH_PROJECT_NUMBER`, and column names if they are not `Backlog`, `Ready`, `In progress`, `In review`, `Awaiting Feedback`, `Done` (`WORK_READY_COL_BACKLOG`, `_READY`, `_PROGRESS`, `_REVIEW`, `_AWAITING`, `_DONE`). If the board is not set, stop and say: "Set GH_PROJECT_OWNER and GH_PROJECT_NUMBER (and any non-default column names) in CLAUDE.md or pass them as arguments." Set `GH_USE_KEYRING=1` when the ambient `GITHUB_TOKEN` lacks the `project` scope.

Take the typecheck, lint, test, E2E and preview commands from the project's `CLAUDE.md`. If a command is not there, say which one is missing. Do not guess it.

## Helpers

`board.sh` is in `${CLAUDE_PLUGIN_ROOT}/scripts/board/`; `worktree_claim.sh`, `peer_activity.sh`, `gates.sh` and `pr_feedback.sh` are in `${CLAUDE_PLUGIN_ROOT}/scripts/work/`. `work_ready_workflow.js` and its two `.mjs` tests stay in this skill's `scripts/` folder. The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

| Script | Job | Exit codes |
|---|---|---|
| `board.sh ready\|awaiting\|items\|move <itemId> <status>` | Board reads and moves through `${CLAUDE_PLUGIN_ROOT}/scripts/github/gh.sh`. Status is `backlog\|ready\|progress\|review\|awaiting\|done` or a column name. | 0 ok, 2 not configured |
| `worktree_claim.sh <repoDir> <n> <baseRef> [<worktreeParent>]` | Claim `.claude/worktrees/issue-<n>` on `claude/issue-<n>` without destroying work. Prints the path last. | 0 ready, 2 cannot measure, 3 dirty, 4 unpushed |
| `peer_activity.sh <repoDir> <n>` | Is another live session working that worktree? (git operation in flight, recent transcript, process holding the path) | 0 clear, 2 cannot measure, 5 peer active |
| `gates.sh <n> <ref> <pr>` | Plan of record in the PR body, `Test entry point:` line, issue-pinned unit and E2E tests. JSON verdict. | 0 pass, 1 fail, 2 cannot measure |
| `pr_feedback.sh [--issue N] [--exclude N,…]` | New human feedback on four surfaces, latest state comment, check status, smoke staleness, for In progress and In review cards. | 0 ok, 2 cannot measure |
| `work_ready_workflow.js` | The Workflow-tool runner for the whole pass. | — |

Exit 2 is never a pass. Exit 3, 4 or 5 means the issue belongs to somebody else: touch nothing and report it as owned. Never run `git worktree remove --force`, `git branch -D` or `git worktree add -B` on an issue worktree.

Tests: `${CLAUDE_PLUGIN_ROOT}/scripts/work/tests/test_gates.sh`, `test_worktree_claim.sh` and `test_peer_activity.sh` there; `node scripts/test_dispatch_dedupe.mjs` and `node scripts/test_peer_candidates.mjs` in this skill. They use throwaway repositories and stubs, with no network.

## Before the survey

1. Check that no other pass is active.
2. Check that the base branch is healthy (`work-heavy` skill, F0b).
3. Run `gh.sh labelled incomprehensible` (the `github` skill). Rewrite those items first.

## The pass

- Ready authorises work. Awaiting Feedback means parked.
- Expand an epic into its children in sub-issue order. An epic in Ready authorises its children.
- Skip an issue that has a `Carried by #` comment or whose parent is In progress: another session owns it.
- Treat an open `claude/issue-<n>` PR as a resume, not a new start. Run `peer_activity.sh` and `worktree_claim.sh` before any dispatch. Give each issue at most one agent per pass.
- Record an explicit blocker with `gh.sh blocked-by add`. A dependency on another Ready card in the same pass means "batch together", not "wait".
- Batch only contiguous dependent or coupled issues. Keep unrelated work and risky schema, auth or migration work separate.

For each startable unit, a worker in its own session follows the answers of the workflow. A subagent worker cannot move a workflow, so it loads `work-heavy` and `testing` and runs F0 → F6. Use one worktree `.claude/worktrees/issue-<lead>`, one branch `claude/issue-<lead>` and one draft PR based on the base branch. The PR body has one section and one `Closes #<n>` per batched issue, each with a `Test entry point:`. Move the card to progress after the plan. Move it to review only after `gates.sh`, the checks and the smoke test pass. Run the `deadcode` skill's sweep for code changes.

A related discovery becomes a sub-issue carried in the same PR (`Carried by #<pr>`, `Closes #<child>`). An unrelated discovery becomes a separate issue with no PR.

Agents never wait for a human. A worker in a workflow calls `mcp__ndev__blocked`. For any other agent, when only a human can move work forward, post the `<!-- work-heavy-auto:state -->` comment (or the question, plan-confirm, feedback or smoke marker; `work-heavy` skill, `references/state.md`) and exit. The next pass resumes from it. Every pipeline comment starts with `<!-- work-heavy-auto` or `**work-heavy-auto`.

## Runner

If the host has the Workflow tool, run `scripts/work_ready_workflow.js` with these args:

- Required: `repoDir` (absolute shared checkout), `skillDir` (absolute path of this skill folder), `repoSlug` (`$REPO`), `commitTrailer` (the trailer the repository or session requires).
- Optional: `baseBranch` (default `main`), `checkCommands`, `e2eCommand` with `e2eConfigPath`, `previewCheck` (without it the pass skips smoke tests and says so), `wikiDir`, `dryRun`, `onlyIssue`, `onlyIssues`, `excludeIssues`, `sequential`, `noConfirm`.

The runner throws and names the missing arg. If the Workflow tool is not available, do the same pass with native agent dispatch (`work-light-auto`), the same helpers and the same markers. Do not start an unsupported runtime.

## Flags

- `--dry-run`: survey and report the ordered plan. No writes.
- `--issue <n>`: work only that issue. Do the resume, peer and dependency checks.

## Report

List the PRs, the parked questions, the blockers, and the cards that are finished or waiting. Human review and merge are outside this skill.
