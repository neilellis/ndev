---
name: goal-work
description: "Work every open GitHub issue that matches a condition the user gives, through grouped, mergeable pull requests, with the user reviewing the plan and the handoffs. Use when the user names a set of issues by label, milestone, search or epic and asks to work them all."
disable-model-invocation: true
---

# Work a goal

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Use this check before you rank or group issues that affect the project goals.

`$ARGUMENTS` selects a set of issues. If it is empty, ask for the condition. This skill is for an attended set. Use `work-heavy-auto` for the Ready column and `work-light` or `work-heavy` for one issue that is already specified.

## The workflow

Call `mcp__ndev__started(issue, shortName)` for each issue, and follow each answer until `mcp__ndev__done`. The workflow keeps the agent on track, so do not add a second loop for it. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

Load `work-heavy` and `testing` first. They define worktree isolation, PR-only delivery, commit trailers, TDD, test tiers, verification and knowledge ingest. This skill adds selection, duplicate detection, grouping and user handoffs. Never close an issue that seems solved without the user's decision.

## Settings

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
```

Issue, milestone, sub-issue and blocker queries use `${CLAUDE_PLUGIN_ROOT}/scripts/github/gh.sh`. Card moves use `${CLAUDE_PLUGIN_ROOT}/scripts/board/board.sh`, which needs `GH_PROJECT_OWNER` and `GH_PROJECT_NUMBER` from the arguments or the project's `CLAUDE.md`. If the set has board cards and the board is not set, stop and say which variable to set.

## Select and classify

1. Expand each epic through its sub-issues (`gh.sh subissues list <n>`). Read every candidate and its comments.
2. Search for an open or merged PR for each one. Read the code and the test before you call an issue solved.
3. Classify each issue as solved, partly solved or not solved, with evidence.

## Group

Group only related work that can ship as one coherent change: an epic's contiguous dependency chain, or a small coupled cluster. Keep unrelated work, schema, auth or migration work, and oversized work separate. For each group, record the lead, the members in commit order, the blockers, and a `Test entry point:` for each member. Record external blockers with `gh.sh blocked-by add`. Do not guess dependencies.

## Hand the plan to the user

Show the selected issues, the evidence for solved ones, the grouping, the blockers and the proposed PRs. Ask numbered questions about scope, closing solved issues, grouping corrections and material assumptions. Do not create branches, move cards or open PRs until the user accepts the plan.

## Deliver

For the first accepted group, call `mcp__ndev__started(<lead>, shortName)` and follow each answer. For each other group, call `mcp__ndev__followUp` with the mode `worktree` and `issues`, because a second `started` in this session joins the first group's PR. With no workflow, follow `work-heavy` F0 → F6 and claim the worktree with `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree_claim.sh <repoDir> <lead> origin/$BASE`. A non-zero exit means the worktree is not yours: stop and report it. Either way:

- One PR for the group. The PR body has one section and one `Closes #<n>` per member.
- Run cheap tests per member. Run expensive deployment, E2E or smoke work once per group.
- Move cards only after the matching gates pass.
- A related discovery becomes a linked sub-issue carried in the same PR (`mcp__ndev__followUp` with `this_agent`). Unrelated work becomes a separate issue with no second PR (`issue_only`).

## Report

One line per PR, the solved or dropped issues with evidence, and anything blocked or waiting for the user.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
