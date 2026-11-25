# GitHub Actions and workflow runs

## Authentication

If the ambient `GITHUB_TOKEN` lacks the `actions` scope, every `repos/<R>/actions/...` call returns `HTTP 401 Bad credentials`. Then use the keyring login: prefix raw calls with `env -u GITHUB_TOKEN`, or set `GH_USE_KEYRING=1` for the helpers (the `GH()` wrapper in `${CLAUDE_PLUGIN_ROOT}/scripts/github/lib.sh`).

For CI on a branch, such as main after a merge, use `ndev wait branch-ci <branch>` (see `checks.md`).

## Queries

```bash
R=$(gh repo view --json nameWithOwner -q .nameWithOwner)
# Recent runs
gh api "repos/$R/actions/runs" --jq '.workflow_runs[] | {id, name, head_branch, head_sha, status, conclusion, html_url}'
# Runs for one branch
gh api "repos/$R/actions/runs?branch=<branch>&per_page=10" --jq '.workflow_runs[] | {id, name, status, conclusion, created_at, html_url}'
# Jobs in a run
gh api "repos/$R/actions/runs/<run_id>/jobs" --jq '.jobs[] | {id, name, status, conclusion, started_at, completed_at}'
# Plain-text log of one job
gh api "repos/$R/actions/jobs/<job_id>/logs" > job.log
```

Save logs to a file and read the first causal error, not the whole log.

## Actions

```bash
gh api -X POST "repos/$R/actions/runs/<run_id>/rerun-failed-jobs"   # only failed jobs
gh api -X POST "repos/$R/actions/runs/<run_id>/rerun"               # all jobs
gh api -X POST "repos/$R/actions/runs/<run_id>/cancel"
gh api -X POST "repos/$R/actions/workflows/<file_or_id>/dispatches" -f ref=<branch>
```

Rerun a job only when the cause is fixed or the evidence shows a transient failure.

## Self-hosted runners

If runs stay queued and never start, check the runners:

```bash
gh api "repos/$R/actions/runners" --jq '.runners[] | {name, status, busy, labels: [.labels[].name]}'
```

An `offline` runner needs its service restarted on its host. Use the project's runner skill or runbook if it has one. Never restart a busy runner.
