# Pull requests

## Rules

While a workflow runs, its tools claim the worktree, open the draft, commit, mark the PR ready and merge. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`. These rules are the same limits for work with no workflow.

1. **PR only.** Never push directly to the base branch. Every change lands through a PR from its own branch.
2. **Worktree isolation.** Work in your own worktree (`${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree_claim.sh`, or an Orca worktree). Never work in the shared checkout.
3. **Trailers.** Include every commit trailer that the repository or session requires.
4. **Draft first.** Open the PR as a draft with the first meaningful commit. Mark it ready when all checks pass.

## Write the PR body

- Describe the problem and the resulting behaviour. Then say what changed, its scope and how you verified it.
- Include `Test entry point:` and keep `Closes #<n>` references.
- Define project terms that a reviewer needs. Link code or screenshots when they help.
- Link changed files with commit-pinned permalinks when a reviewer needs a stable reference. Quote only key 5 to 15 line snippets and say why they matter. Add before and after screenshots for visual changes.
- Read the body once before you post it. Fix unclear wording, missing scope and claims that go beyond the checks you ran.

## Commands

| Command | Does | Output |
|---|---|---|
| `ndev project pr-new --title <t> --body-file <f> [--base <b>] [--head <h>] [--ready]` | Open a PR, draft by default. The base defaults to the default branch. | the PR URL; `--json` gives `{number,url}` |
| `ndev github pr-edit <n> [--title <t>] [--body <t> \| --body-file <f>]` | Edit with REST. `gh pr edit` can fail on GraphQL deprecations. | `{number,url}` |
| `ndev github dump pr <n> [--out DIR]` | Body, comments, images and full diff in one markdown file. | `MARKDOWN: <path>`, `IMAGES_DIR: <path>` |
| `ndev github unpushed` | Local commits on no remote. Run it before you discard a branch or worktree. | JSON lines, or `{"unpushed": 0}` |
| `ndev wait checks <n>` | Wait until every newest check run on the PR head has finished. | each check's conclusion and URL |

## Carry a sub-issue in your PR

Related work you find becomes a sub-issue of the issue you work on, and your PR carries it:

1. `ndev github subissues link <parent> <child>`
2. `ndev github comment <child> --body 'Carried by #<pr>'`
3. If a board is configured: `ndev github board move <itemId> "In progress"` (`ndev github board add <child>` prints the item id).
4. Add `Closes #<child>` to the PR body, one line for each sub-issue.

## Merge the base branch into open PRs

```bash
ndev github merge-main [--dry-run] [--pr <n>]... [--worktree-dir <dir>] \
  [--install-cmd "<cmd>"] [--push-cmd "<cmd>"] [--trusted-file <path>]... [--trailer "<line>"]...
```

- The base is the repository's default branch. Draft PRs are included. Fork PRs and PRs with another base are refused.
- It fetches origin and makes one worktree for each branch (default `<repo>/.claude/worktrees/merge-main-pr-<n>`).
- `--install-cmd` installs dependencies in each worktree. `--trusted-file` refuses a branch that changes that file (for example a push hook) from the base copy.
- It pushes with `git push` or `--push-cmd`, so hooks run. It refuses `--no-verify` and never force-pushes.
- The first failure stops the batch with exit code 1. Logs and state are in `<worktree-dir>/merge-main-evidence/`.
- On a conflict, resolve and commit in the reported worktree, then rerun. A rerun resumes prepared work and skips branches that already contain the base.
- If another author moves a prepared branch, inspect the kept worktree before you update it. Worktrees from other sessions are not touched.
- It does not check CI. Wait with `ndev wait checks <n>` and read the checks before you say CI passed.
