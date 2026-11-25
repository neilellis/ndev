# Precheck and push

[kb](README.md) › precheck-and-push

**The local gates run the same checks as the CI guards job, on the committed tree, before the push.** The pre-push hook enforces this. A precheck script gives faster feedback on the changed paths, and a reminder hook prompts for it after each commit.

In a project that runs the [workflow](workflow.md), the workflow tools run the checks. The project keeps them in `scripts/ndev/workflow/`.

## Three layers

| Layer | When | Forced? | Scope |
|---|---|---|---|
| Edited-file guards | After each `Edit` or `Write` | Blocks the model (exit 2), not the edit | One file. See [guards.md](guards.md#edited-file-guards). |
| Precheck script | Before a push, by choice | Recommended. A reminder hook prompts for it. | The paths changed since the base. |
| Pre-push hook | On every `git push` | Yes | Every check of the CI guards job, on the whole tree. |

None of these replaces CI. CI on a pull request tests the merge result, which no local check can see. See [ci.md](ci.md).

## The precheck script

- It runs on the paths changed since `--base`. The `--base` option has no default and no fallback.
- It never fetches. Fetch first.
- Run it before the push. After the push, the diff against upstream is empty and the script checks nothing.
- It runs every check with no early stop, so one run shows every defect.
- It runs the unit lane through the same lane script that CI uses. Two copies of a lane drift apart.
- Exit codes: 0 pass, 1 defect, 2 could not measure (the message names the fix).
- An environment variable that skips a check must print loudly that the check was skipped.
- Every type-checker rule is at zero. Never widen the config to get green ([type-safety.md](type-safety.md)).

## The pre-push hook

[hooks/pre-push](hooks/pre-push) is a reusable copy. Its design:

1. **A clean worktree is required.** The checks must test the committed tree, including untracked files.
2. **Each pushed local object id must equal `HEAD`.** This worktree can test only `HEAD`. Push another branch from its own worktree.
3. **No commits to push means exit 0 with an INFO line.** A branch deletion needs no checks.
4. **Fetch only the base branch's tracking ref, and never merge.** Git has already prepared the push.
5. **The base must be an ancestor of `HEAD`.** If not, the message names the checked-push script that pulls and retries.
6. **Inspect every outgoing commit** (`git log --name-only --diff-merges=separate`) and the tree diff. A change and its revert still need checks, even when the final tree is identical.
7. **Run the whole-tree checks under a logged runner with a generous timeout.** The timeout ends a hung run. It is not a speed limit. A busy machine must never refuse a push, because that refusal tempts the next person to use `--no-verify`. Set the timeout at about three times the slowest healthy run on a loaded machine.
8. **Unset Git's local environment variables for the subprocesses** (`git rev-parse --local-env-vars`). In a linked worktree, those variables force every nested Git command to this root, and fixtures that create their own repositories break.
9. **After the run, check that `HEAD` is unchanged and the worktree is still clean.** A check that writes files is a defect.

## Sharing the hook across worktrees

Every worktree of one repository shares one Git common folder. Install the hook once, there.

- [hooks/pre-push-dispatch.sh](hooks/pre-push-dispatch.sh) is a small dispatcher. It finds the current worktree root and runs that worktree's tracked `.githooks/pre-push`. It refuses when that file is missing.
- [hooks/install-guard-hooks.sh](hooks/install-guard-hooks.sh) copies the dispatcher into the common folder and sets `core.hooksPath` to it.
- The installer writes through a temporary file and a rename.
- The installer preserves hooks it does not know. It refuses to replace a hook that lacks its marker comment.

Each worktree then runs the version of the hook that its own branch carries.

## The checked push

[hooks/push-checked.sh](hooks/push-checked.sh):

1. Refuses any `--no-verify` style option.
2. Requires a clean worktree.
3. Installs the hooks (idempotent).
4. Pulls the base branch with a merge, not a rebase.
5. Pushes with the arguments given. The pre-push hook then runs.

## A green push is not a green branch

The pre-push hook proves only that its checks passed on this commit. Run each suite that the change touches, and confirm that the file count is whole (for example "254 test files", not "some tests ran"). Report what you did not run ([core belief 8](core-beliefs.md#8-never-overclaim)).
