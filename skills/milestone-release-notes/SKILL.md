---
name: milestone-release-notes
description: "Produce stakeholder-facing release notes for a GitHub milestone by reading all included issues and merged PRs."
disable-model-invocation: true
---

# Release notes

Use only when the user invokes it with a milestone. This skill reads GitHub and writes only the notes file. Do not comment, move cards or publish a release (that is `milestone-release`).

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## 1. Resolve the inputs

1. Get the repository: `gh repo view --json nameWithOwner -q .nameWithOwner`.
2. Resolve the exact milestone title through GitHub. Titles drift, so do not guess from a partial name:
   `gh api repos/<owner>/<name>/milestones?state=all --paginate -q '.[] | [.number, .title, .state] | @tsv'`
3. List its issues: `gh issue list --repo <owner>/<name> --milestone '<title>' --state all --limit 500 --json number,title,url`.
4. Choose the output path: the repository's existing release-notes folder, else `docs/release-notes/<slug>.md`.

## 2. Run the workflow

`scripts/milestone_release_notes_workflow.js` in this skill's folder is a Workflow tool script. One cheap agent summarises each issue in full (body and every comment) in plain words. Then one stronger agent classifies and groups all the summaries and writes the file.

Its arguments:

| Argument | Meaning |
|---|---|
| `milestone` | exact title (required) |
| `repo` | `OWNER/NAME` (required) |
| `repoDir` | absolute path of the local checkout (required) |
| `issues` | `[{number, title, url}]` from step 1 (required) |
| `outFile` | notes path, absolute or relative to `repoDir` |
| `dumpScript` | optional project command that dumps one issue to markdown; else agents use `gh issue view --comments` |

If any issue fails to summarise, the workflow stops and names the issues. It never writes notes that drop an issue in silence.

Without the Workflow tool, do the same steps by hand: read each issue in full, write one plain paragraph each, then group them.

## 3. Check the notes

- Classify by the outcome that a user sees, not by labels alone: new features, improvements, fixes, then a short "Other" section for internal work.
- Group related issues and remove duplicates. Keep caveats that matter.
- Write for stakeholders: what changed and why it matters, with little implementation detail and no unsupported claims.
- Include the milestone, the date, a short headline led by the outcome, and a short section for work that did not ship or needs follow-up.
- Check each issue number and status against GitHub before you finish.

Report the path of the notes file.
