# Checks and CI status

## Never trust `gh pr checks --watch`

`gh pr checks --watch` can stop early and exit 0 on a GraphQL authentication error (HTTP 401), while runs are still queued. A script that trusts its exit code thinks that all checks passed.
After any watch, read the explicit status and conclusion of each run or check.

## Wait for PR checks

While a workflow runs, follow its next step for the checks of its PR. With no workflow:

```bash
ndev wait checks <pr> [--period <seconds>] [--timeout <seconds>]
```

- It reads the checks every 60 seconds inside itself, and each read spends GitHub quota. Do not poll from the agent.
- Only the newest run of each check counts. A run that a newer run of the same check cancelled is not a failure.
- It returns when every check on the current head has finished. No checks is not completion.
- It exits 1 with each failed check and its log URL, and 3 on a timeout. The default timeout is 3600 seconds, at most 21600.

## Wait for CI on a branch

```bash
ndev wait branch-ci <branch> [--period <seconds>] [--timeout <seconds>]
```

It reads the newest head commit of the branch, then the runs on that commit. Only the newest run of each workflow counts. When a merge moves the head and cancels the old runs, it follows the new head. It returns each workflow's conclusion and URL. It exits 1 with each failed workflow and its log URL.

## Read check state directly

```bash
R=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/$R/commits/<sha>/check-runs" --jq '.check_runs[] | {name, status, conclusion, html_url}'
gh api "repos/$R/actions/runs/<run_id>" --jq '"\(.status) \(.conclusion)"'
gh pr view <pr> --json statusCheckRollup \
  --jq '.statusCheckRollup[] | {name: (.name // .context), status: (.status // .state), conclusion: (.conclusion // .state)}'
```

Prefix with `env -u GITHUB_TOKEN` when the ambient token lacks the `actions` scope.

## Status and conclusion values

Status: `queued` (waiting for a runner), `in_progress`, `completed`.

Conclusion of a completed run:

| Value | Meaning |
|---|---|
| `success` | Passed. |
| `failure` | Errors or test failures. |
| `skipped` | Excluded by path filters or workflow conditions. Report it as skipped, never as passed. |
| `cancelled` | Superseded or cancelled. |
| `timed_out` | Exceeded the time limit. |
| `action_required` | Needs manual action. |
