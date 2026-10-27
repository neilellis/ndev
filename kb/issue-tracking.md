# Issue tracking

[kb](README.md) › issue-tracking

**An issue states the problem. A PR closes one unit of work. A board column says who acts next.** These rules use GitHub issues, sub-issues and a GitHub Project board through the `gh` CLI.

## The board

| Column | Meaning | Who acts |
|---|---|---|
| Ready | Specified well enough to start. | An agent or a developer picks it up. |
| In progress | Somebody owns it and works on it. | The owner. |
| In review | A PR is open and ready for review. | A reviewer. |
| Awaiting Feedback | The work needs a decision or an answer from the user. | The user. |

- Move a card when its owner changes, not at the end of the day.
- A card in Awaiting Feedback carries a comment with the question, as numbered options.

## Issues

- Lead the body with the problem and the evidence (the command, the output, the identifier that failed).
- Say what "done" means: the test that proves it.
- Refer to other issues and PRs by bare number (#1000). GitHub shows the title on hover. A repeated title buries the sentence.
- Write in [Simple English](writing.md). Run the readability check before you post. Prose that a human wrote is theirs: do not rewrite it.
- Use a heredoc or a body file for a multi-line body.

## Sub-issues

- A related find during work becomes a sub-issue of the current issue.
- Fix it on the same PR only when it is part of the same unit of work. Otherwise it waits for its own PR.
- An unrelated find becomes its own issue. Keep it out of the diff.
- Use GitHub's native issue dependencies for "blocked by". A blocked issue is not Ready.

## Pull requests

- One PR per unit of work ([core belief 9](core-beliefs.md#9-work-only-in-a-worktree-with-a-pr-one-pr-per-unit-of-work)).
- Open as a draft while work remains. Mark it ready only when every required check ran.
- The body leads with what changed and why, then the evidence: the tests that you ran and their result, and what you did not run.
- Report passed, failed, skipped (with the reason) and not run as separate states.
- Link the issue with a closing keyword (`Closes #123`).
- A human merges.

## `gh` traps

- A stale `GITHUB_TOKEN` in the environment overrides the keyring login and fails. Run `env -u GITHUB_TOKEN gh ...` when that happens.
- `gh issue edit` and `gh pr edit` can fail silently on a repository linked to a classic Projects board. Verify that the edit landed, or use `gh api -X PATCH`.
- Issues and PRs share one number space. Resolve a bare number with `gh pr view` first, then `gh issue view`.
