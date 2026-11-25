# Git and worktrees

[kb](README.md) › git-and-worktrees

**Each unit of work has its own worktree, its own branch and one PR. Nobody commits to the main branch.** Use Orca to make and manage worktrees, terminals and handoffs. In a project that runs the [workflow](workflow.md), its `started` tool claims the worktree and opens the PR.

## Worktrees

- One worktree per unit of work. Independent fixes get separate worktrees, branches and agent contexts.
- The main checkout is shared. Another session can have uncommitted edits in it at any time. Do branch work in a worktree, not in the main checkout.
- If `git status` shows changes that your task did not make, stop. Do not commit them. Find out whose they are.
- File separation alone does not prove independence. Check shared interfaces, schema, fixtures and runtime state (ports, database names, containers) before you run two units in parallel.
- Never delete another worktree, unpushed work or unknown files to make a task pass.
- Run commands from the tree that you test. A command run from the main checkout tests the main checkout.
- A tool that resolves paths from the working directory can read a sibling worktree. Resolve paths from the repository root (`git rev-parse --show-toplevel`).
- Submodules are not initialised in a new worktree. [hooks/init-worktree-submodules.sh](hooks/init-worktree-submodules.sh) runs `git submodule update --init` after `git worktree add`.

### Orca

Orca manages the worktrees, the terminals in each worktree and the handoff of work between agents. Use the `orca-cli` skill.

- Make a child worktree through Orca, not with a raw `git worktree add`, so that Orca knows about it.
- Read, wait for and send to an agent's terminal through Orca. Do not open a second terminal on the same worktree.
- To hand a strand of work to another agent, use an Orca handoff. Give it a brief ([agent-collaboration.md](agent-collaboration.md#briefs)).
- Orca worktree comments are a good place for a short status that the next agent reads first.

## Branches

- Never commit to the main branch. If you are on it, make a branch first.
- Name the branch after the unit of work and its issue number.
- A dependency between two changes is a commit order on one branch, not a second PR.
- Merge the base branch into the work branch to update it. Do not rebase a branch that someone else may have pulled.
- Resolve a conflict by reading both sides. Never take one side of a list (for example an `__all__` export list) without a check: Git can merge a removed name back in with no conflict ([type-safety.md](type-safety.md#traps)).

## Commits

- Commit at the smallest unit that passes its tests.
- A commit message says what changed and why, in [Simple English](writing.md).
- Never stage while a mutation test is applied ([testing.md](testing.md#mutation-proof)).
- Never use `git stash` without a unique message: the stash stack is shared by every worktree. Prefer a work-in-progress commit.
- Stage by path. Never stage with `git add -A` or `git add .`: they take every change in the tree, including another session's.

## Moves and removals

Use `git mv` and `git rm`, not plain `mv` and `rm`.

- `git mv` refuses to overwrite a file that exists. Plain `mv` overwrites it without a message, and the old content is lost.
- `git rm` records the removal at the moment that you decide it. A plain `rm` is recorded only if a later `git add` covers that path.

Traps in `git rm`:

1. `git rm` refuses a tracked file that has local changes, and leaves it on disk. If you already decided that the file goes, use `git rm -f`. Use `-f` deliberately, not as a habit.
2. `git rm -r <folder>` removes only the tracked files, and it still succeeds. An untracked file stays on disk, and a later `git add` stages it as an addition. After a recursive removal, check that the folder is gone.
3. Git translates its messages. A script that tests git's error text stops working in another locale. Set `LC_ALL=C`, and test the result (is the file gone?), not the message.

## Pushes

Push only through the checked push and the pre-push hook ([precheck-and-push.md](precheck-and-push.md)). Never use `--no-verify`.

## Pull requests

- One PR per unit of work. Open it as a draft while work remains.
- A human merges.
- Keep unrelated discoveries out of the diff. Record each one as an issue.
- Inspect the final diff for scope and accidental changes before you ask for review.
- More rules: [issue-tracking.md](issue-tracking.md#pull-requests).
