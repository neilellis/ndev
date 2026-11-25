---
name: hotfix
description: "Do the requested work directly on the main branch in the main checkout and push it to origin main, with no worktree and no pull request. User-invoked only."
disable-model-invocation: true
---

Use this skill only when the user invokes it by name for the current task. Never load it on your own judgement. Never carry it into a later task.

## The exception

The user gives an exception to the worktree-plus-PR rule in the project's CLAUDE.md or AGENTS.md. For this task only:

- Work in the main checkout, on the base branch (usually `main`).
- Do not make a worktree or a branch.
- Do not open a pull request.
- Commit to the base branch and push to `origin <base>`.

All other rules stay in force: test first, pass the guards, record every failure, never use `--no-verify`, never spend resources the user did not authorise.

## Procedure

1. Find the main checkout: the first path that `git worktree list` prints.
2. Run every command in that path. From a worktree session, use absolute paths or `git -C <path>`.
3. Make sure the checkout is on the base branch and clean: `git -C <path> status -sb`.
4. If it holds changes that you did not make, stop and ask the user. They can belong to a peer.
5. Update it: `git -C <path> pull --ff-only origin <base>`.
6. Make the change with the normal test-first steps.
7. Stage only your own files, by name. Never `git add -A`.
8. Commit with a message that starts with `hotfix:`, plus the required trailers.
9. Push from the main checkout with the repo's checked-push command named in its CLAUDE.md, else `git push origin <base>`.
10. If the push fails, read the error and fix the cause. Never force-push.
11. Report the commit SHA and the push result.

## The workflow

The `mcp__ndev__hotfix` tool is another route: it gives an urgent fix its own issue, worktree and PR, and its answer gives the steps. This skill commits directly and has no PR. Use it only when the user names it.

If a workflow runs for this issue (`mcp__ndev__status` tells you), commit with `mcp__ndev__checkpoint`, follow each answer and end with `mcp__ndev__done`. Only a `straw_man` project commits to the base branch. At another level, the hotfix goes through the PR. A project level that may merge lets `done` merge. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
