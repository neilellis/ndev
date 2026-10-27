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
| `GH_REPO=OWNER/REPO` | Repository. Default: `gh repo view --json nameWithOwner -q .nameWithOwner` in the current checkout. |
| `GH_USE_KEYRING=1` | Drop `GITHUB_TOKEN` so the gh keyring login is used. Set it when the ambient token lacks `project`, `actions` or organisation scopes. |
| `GH_PROJECT_OWNER`, `GH_PROJECT_NUMBER` | Optional Projects v2 board. Field and option ids are looked up by name. |
| `GH_PROSE_CHECK` | Optional command that checks an issue or PR body file before it is posted. |

```bash
gh.sh help
gh.sh milestones | issues-by-milestone "<exact title>"
gh.sh issue-new | issue-edit ...         # bodies from files
gh.sh pr-new ... | pr-edit <n> ...       # draft by default; REST edit
gh.sh subissues list|link <parent> [child...]
gh.sh blocked-by list|add|remove|blocking <issue> [blocker]
gh.sh board items [<column>] | move <itemId> <column> | set <itemId> <field> <option> | add <issue> [<column>]
gh.sh unpushed                           # before you discard any branch
dump.py issue|pr <n> [--out DIR]         # one markdown file plus images
merge-main-into-open-prs.sh [--dry-run] [--pr <n>]
wait-for-pr-change.sh <pr> --skip-success --json
wait-for-run.sh <run_id> [--max-polls 480] [--interval 30]
```

Rules:

- Write human-facing prose to a file and post it with the helpers. Use `gh.sh pr-edit` (REST); `gh pr edit` can fail on GraphQL deprecations.
- Keep every `Closes #<n>` reference after a PR body edit.
- Never push directly to the base branch. Use a branch and a PR. Include the commit trailers that the repository requires.
- Never trust the exit code of `gh pr checks --watch` (see `references/checks.md`).

To add a helper: source `${CLAUDE_PLUGIN_ROOT}/scripts/github/lib.sh`, call `gh_resolve_repo`, make it executable, list it here, and describe non-obvious behaviour in the relevant reference.
