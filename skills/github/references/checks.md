# Checks and CI status

## Never trust `gh pr checks --watch`

`gh pr checks --watch` can stop early and exit 0 on a GraphQL authentication error (HTTP 401), while runs are still queued. A script that trusts its exit code thinks that all checks passed.
After any watch, read the explicit status and conclusion of each run or check.

## Wait for PR checks

While a workflow runs, do not wait for the checks of its PR: the plugin watches them and refuses the wait helper. With no workflow:

```bash
wait-for-pr-change.sh <pr> --skip-success [--json] [--interval 120] [--timeout <s>]
```

- The script checks every 120 seconds inside itself (each check spends GitHub quota). Do not poll from the agent.
- `--skip-success` is required in skill workflows. It ignores intermediate successes and unrelated PR changes, and returns on a failure or on completion of CI for the current revision.
- A revision that already failed or completed returns at once. No checks is not completion.
- Read the result before you claim success. Do not restart the waiter for a completed revision.

## Wait for one Actions run

```bash
wait-for-run.sh <run_id> [--max-polls 120] [--interval 120]
```

It reads the run once, then checks every 120 seconds with no progress output (each check spends GitHub quota, once for each agent waiting). It returns on a status change, or exits 2 after more than `--max-polls` unchanged checks. A completed run returns at once. A changed status is not a pass: read the conclusion.

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
