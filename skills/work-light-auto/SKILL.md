---
name: work-light-auto
description: "The non-interactive lightweight development skill (light mode, auto steering). Deliver the issues in the GitHub project board's Ready column one unit at a time through isolated PRs, with native agent dispatch, explicit continuation state and no merges. Use for an attended Ready-board pass, or when the Workflow tool is not available; flags --dry-run, --issue <n>, --parallel."
---

# Ready-board delivery, one unit at a time

Read [the ndev CLI skill](${CLAUDE_PLUGIN_ROOT}/skills/cli/SKILL.md) for native commands and when to use them. Prefer those commands for workflow operations when `ndev` is available. Keep this skill's gates and ownership rules.

Read the applicable parts of the project’s `NORTH_STAR.md`.

Records: search `docs/adr` and `docs/pdr` for each issue's area (`adr-pdr` skill). Never change a requirement on your own: write the PDR as `Proposed`, say in the PR what human approval is missing, and leave the requirement's text as it is. Do not set an old record to `Superseded` until a human has accepted its replacement.

This is the attended, native-dispatch form of `work-heavy-auto`. Survey and order the Ready column, then give each independent issue or dependency batch to one disposable worker. Report one line per unit. A human merges.

## The workflow

A worker in its own session or Orca workspace calls `mcp__ndev__started(issue, shortName)`, then `mcp__ndev__setSteering` with `auto` and the reason, as no human answers an unattended run, and follows each answer until `mcp__ndev__done`. A subagent cannot move a workflow, so an `issue-implementer` subagent follows the stages of its brief and files other work with `mcp__ndev__followUp` with `issue_only`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Settings

Use the settings section of `work-heavy-auto`: `REPO` and `BASE` from `gh repo view`, and `GH_PROJECT_OWNER`, `GH_PROJECT_NUMBER` and any non-default column names from the arguments or the project's `CLAUDE.md`. If the board is not set, stop and say: "Set GH_PROJECT_OWNER and GH_PROJECT_NUMBER (and any non-default column names) in CLAUDE.md or pass them as arguments."

Board reads and moves use `ndev github board ready|awaiting|items|move <itemId> <status>`. Issue and PR queries use `ndev github`. Before each dispatch, run `${CLAUDE_PLUGIN_ROOT}/scripts/work/peer_activity.sh` and `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree_claim.sh`. Exit 2, 3, 4 or 5 means: do not dispatch, report the issue as owned or unmeasured.

## Survey

1. Check the base-branch health (`work-heavy` F0b) and `ndev github labelled incomprehensible`. Rewrite labelled items first.
2. Delegate the read-only survey to the `board-survey` agent. For each issue it reads the comments, sub-issues, open PR, card id, dependencies and size.
3. Ready is authorisation. Awaiting Feedback parks a question. Expand epics. Skip carried work. Treat open PRs as resumes. Record external blockers with `ndev github blocked-by add`.
4. Batch only dependent or coupled issues, in commit order. Keep risky schema, auth or migration work and unrelated issues separate.

Under `--dry-run`, report the ordered units and stop. Under `--issue <n>`, do the same checks for that issue only. Under `--parallel`, dispatch only independent units at the same time, and hold a lock for a shared browser or E2E resource. The default is sequential.

## Each unit

Dispatch one `issue-implementer` agent per unit (named `issue-<lead>`). Size the model: a trivial unit can use a smaller model; when you are not sure, size up. A worker in its own session follows the answers of the workflow, which does these stages. A subagent worker cannot move a workflow, so this list is its brief. It loads `work-heavy` and `testing` and runs F0 → F6:

- Worktree `.claude/worktrees/issue-<lead>`, branch `claude/issue-<lead>`, one draft PR based on the base branch.
- One body section and one `Closes #<n>` per member, each with a `Test entry point:`. The body also has a `## Lessons` section. The `## Lessons` section states what the work taught, or says that there is none and why (`${CLAUDE_PLUGIN_ROOT}/kb/proof.md`). When the project has `.github/workflows/ndev-proof.yml`, run `ndev proof run --local --base origin/<base> --body <body file>` before the PR leaves draft, and fix each check that fails.
- Focused checks, typecheck and lint from the project's `CLAUDE.md`; the `deadcode` skill's sweep for code changes; preview and smoke test where the project has one.
- `gates.sh` (the `work-heavy-auto` skill) passes before the PR leaves draft.
- Card to progress after the plan; to review only after verification.
- A related discovery is carried as a linked sub-issue in the same PR. Unrelated work becomes a separate issue.
- Continuation markers updated before exit (`work-heavy` skill, `references/state.md`).

Return the worker's one-line result or its blocking question. Never open a second PR, wait silently, merge, or push the base branch.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
