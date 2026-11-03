---
name: github
description: "Operate GitHub issues, pull requests, checks, milestones, Actions runs and an optional project board through compact helper scripts. Use for any issue, PR, check or board operation, and for waiting on CI without polling."
---

# GitHub operations

Use the helpers in `${CLAUDE_PLUGIN_ROOT}/scripts/github/` (the plugin's shared `scripts/` folder; other skills use them too). Pass absolute paths to other agents. `${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`. Read the matching reference before complex work:

- `references/issues.md`: issues, sub-issues, blockers, milestones, board.
- `references/prs.md`: PRs, closing references, merging the base into open PRs.
- `references/checks.md`: checks and waiting.
- `references/actions.md`: Actions REST and logs.

Settings (see `${CLAUDE_PLUGIN_ROOT}/scripts/github/lib.sh`):

| Variable | Effect |
|---|---|
| `GH_REPO=OWNER/REPO` | Repository. Default: the origin remote of the current checkout (no GitHub call), else gh. |
| `GH_USE_KEYRING=1` | Drop `GITHUB_TOKEN` so the gh keyring login is used. Set it when the ambient token lacks `project`, `actions` or organisation scopes. |
| `GH_PROJECT_OWNER`, `GH_PROJECT_NUMBER` | Optional Projects v2 board. Field and option ids are looked up by name. |
| `GH_PROSE_CHECK` | Optional command that checks an issue or PR body file before it is posted. |

Every GitHub call in this plugin's code goes through `gh.sh`. It runs the gh command first and uses REST when that fails (a rate limit, a GraphQL error). Reads and idempotent writes fall back on any failure. A post that is not idempotent (comment, review, `pr-new`, `issue-new`) falls back only on a rate-limit message, so it cannot post twice. Every command prints REST's shape. `issue-new` with a milestone or type uses REST directly. Do not call `gh` from a script: use a `gh.sh` command, or add one. `scripts/github/tests/no_raw_gh.test.mjs` fails on a raw call and lists the exceptions (`gh release *`, `gh run watch`, `gh run view --log-failed`, `gh pr view --web`, `gh auth *`).

```bash
gh.sh help
gh.sh milestones | issues-by-milestone "<exact title>"
gh.sh issue-new | issue-edit ...         # bodies from files
gh.sh pr-new ... | pr-edit <n> ...       # draft by default; REST edit
gh.sh pr-list [--head <b>] [--state s] | pr-search "<query>" | pr-diff <n> | pr-commit-dates <n> | pr-reopen <n>
gh.sh view-json pr|issue <n> --fields f  # gh's own shape; pr --open lists open PRs (no REST route)
gh.sh pr-rows [--limit n]                # Open PRs with checks and merge state in one GraphQL call: the row list that /fix-all-prs reads
gh.sh run-status <id>                    # {status}
gh.sh feedback <issue> [<pr>]            # rows with surface (issue|pr|review|inline) and path; first 100 of each
gh.sh subissues list|link <parent> [child...]
gh.sh blocked-by list|add|remove|blocking <issue> [blocker]
gh.sh board items [<column>] | fields | move <itemId> <column> | set <itemId> <field> <value> | add <issue> [<column>]
gh.sh unpushed                           # before you discard any branch
dump.py issue|pr <n> [--out DIR]         # one markdown file plus images
merge-main-into-open-prs.sh [--dry-run] [--pr <n>]
wait-for-pr-change.sh <pr> --skip-success --json
wait-for-run.sh <run_id> [--max-polls 120] [--interval 120]
```

Rules:

- Write human-facing prose to a file and post it with the helpers. Use `gh.sh pr-edit` (REST); `gh pr edit` can fail on GraphQL deprecations.
- Keep every `Closes #<n>` reference after a PR body edit.
- Never push directly to the base branch. Use a branch and a PR. Include the commit trailers that the repository requires.
- Never trust the exit code of `gh pr checks --watch` (see `references/checks.md`).

To add a helper: source `${CLAUDE_PLUGIN_ROOT}/scripts/github/lib.sh`, call `gh_resolve_repo`, make it executable, list it here, and describe non-obvious behaviour in the relevant reference.

## The workflow

While a workflow runs, it watches the checks and the conflicts of its PR and tells the agent, so do not run `wait-for-pr-change.sh` or `wait-for-run.sh` for that PR: the guard refuses them. Read the state with `mcp__ndev__status`. Commit and push with `mcp__ndev__checkpoint`. Mark a PR ready with `mcp__ndev__finishedReview`. File other work with `mcp__ndev__followUp`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
