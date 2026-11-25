---
title: Workflows (ndev flow)
description: Start, checkpoint, review, verify and finish work on an issue or pull request using the ndev flow state machine.
---

# Workflows (`ndev flow`)

`ndev flow` keeps an agent on one issue from start to finish in a recorded, auditable state. Each command validates its preconditions, runs the mechanical Git and GitHub steps, and returns the exact next action.

For the full formally verified state machine generated directly from `models/workflow/issue_workflow.qnt`, see [Formal models (Quint)](/architecture/formal-models/). For the detailed policy guide, read [the workflow knowledge base page](/kb/workflow/).

## Workflow modes and steering

Choose a **mode** based on the size and risk of the change:

| Mode | Interview | Plan | Hardening | Typical use |
| --- | --- | --- | --- | --- |
| `light` | Yes (in interactive) | No | No | Focused fixes and small, well-scoped features. |
| `heavy` | Yes (in interactive) | Yes | No | Larger or higher-risk changes that need a written plan and staged review. |
| `hack` | No | No | Yes | Exploratory prototypes that must harden before review. |

Choose **steering** based on whether a person is present:

- **`interactive`** — runs structured interviews in the Orca panel (or chat) and pauses for plan sign-off when the project level requires it.
- **`auto`** — skips interactive interviews for autonomous runs. `hack` mode cannot combine with `auto` steering.

## Standard issue lifecycle

1. **Start the workflow** in an isolated worktree:

```sh
ndev flow start 42 --short-name fix-login
ndev flow status --json
```

Or create a new issue and start immediately:

```sh
ndev flow create fix-login --description-file /tmp/issue.md --mode light
```

2. **Interview and plan** (when the mode and steering require them):

```sh
ndev flow interview --round-file round.json
ndev flow finished-interview
ndev flow finished-plan --markdown-file plan.md
```

3. **Commit and push via checkpoints** during development:

```sh
ndev flow checkpoint --message "Validate empty tokens" --file src/auth.ts --file tests/auth.test.ts
```

Direct `git commit` and `git push` are guarded by `ndev hook pre-tool-use` while a workflow is active. Always pass named files to `ndev flow checkpoint`; never stage whole trees blindly.

4. **Finish development** and enter independent review:

```sh
ndev flow finished-development --issue 42 --body-file /tmp/pr-body.md
```

If a human needs to inspect a reviewed commit before marking the draft PR ready, push the reviewed SHA while staying in `reviewing`:

```sh
ndev flow push-draft --sha <full-40-char-sha> --review "Independent review summary"
```

5. **Record independent review** and mark the PR ready for CI:

```sh
ndev flow finished-review --review "Reviewed diff and tests" --deadcode "None introduced" --remembered "No new project lessons"
```

6. **Verify CI checks and smoke tests**:

```sh
ndev wait checks <pr>
ndev flow finished-checks
ndev flow finished-smoke --report-file /tmp/smoke.md
```

7. **Complete the workflow**:

```sh
ndev flow done --message "All checks green and ready for human merge"
```

If new review feedback or a merge conflict arrives later on an open PR, `ndev flow revisit` returns the workflow to `revising`. After addressing feedback, run `ndev flow finished-revision`.

## Resume an existing PR or repair an association

To resume an existing open PR in an isolated checkout without creating a duplicate PR:

```sh
ndev flow start 1401 --pr 1402
```

If a local workflow already points at an alias branch or an accidental duplicate PR, repair the association in place:

```sh
ndev flow repair --issue 1401 --pr 1402
```

`ndev flow repair`:

- Verifies the open PR, issue link, origin remote, canonical head branch and local Git ancestry.
- Keeps the local branch, working tree files, commits and existing canonical branch intact.
- Routes future checkpoints to the canonical PR branch.
- Clears prior review, CI and smoke evidence so fresh verification runs on the resulting head.
- Refuses takeover from another active owner unless `--take-over` is passed **and** Orca confirms that owner has finished.
- Never closes duplicate PRs or merges anything automatically.

## Reuse a worktree after a PR closes

`ndev flow start` refuses to start a new issue in a worktree that still carries an active record for a closed or merged PR. Disable the finished record first:

```sh
ndev flow off --pr <old-pr>
ndev flow start <new-issue> --short-name <slug>
```

Disabling preserves the historical record and local files.

## Human overrides

| Command | Effect |
| --- | --- |
| `ndev flow mode [light\|heavy\|hack]` | View or change the workflow mode. |
| `ndev flow steering [interactive\|auto]` | View or change steering. Agents must pass `--reason` to switch to `auto`. |
| `ndev flow skip [<reason>]` | Advance past the current stage. |
| `ndev flow goto <state> [<reason>]` | Move to a named state (`setup`, `interviewing`, `planning`, `developing`, `hardening`, `reviewing`, `ci`, `smoke`, `finishing`, `revising`, `done`). |
| `ndev flow blocked --message <text>` | Pause the workflow and record why it cannot proceed. |
| `ndev flow unblock [<answer>]` | Restore the state saved before `blocked`. |
| `ndev flow off [<reason>] [--project]` | Turn off the workflow for this worktree or the whole project. |
| `ndev flow on [--project]` | Turn the workflow back on. |

## Next step

Explore every command group and JSON response convention in the [CLI reference](/guides/cli/).
