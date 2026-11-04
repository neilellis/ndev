---
name: publish
description: "Merge the current change's pull request in a website or app project and confirm the live site. Use when the user types /publish or says \"Approve and publish\" in a website or app project (for a video project use video-publish). Fixes build problems it finds."
---

# Publish the current change

When the user types `/publish`, that is their approval to merge the pull request for the current change. Use `finish` to get it ready and `github` for pull request operations. Never push to the base branch directly. Report only results that tools confirm.

If `<project root>/.neil-dev.json` has a `branding` key, follow the project's brand copy rules for the publication report. Use the `copy` skill for those rules. Find the root with `git rev-parse --show-toplevel`.

## What you need from the project

Read these from the project's instructions. If one is missing, ask the user once and suggest they record it there:

- the production site URL;
- the deployment environment name that GitHub deployments use for production (often `Production`);
- the host's deployments page, if there is one.

The repository comes from `gh repo view --json nameWithOwner -q .nameWithOwner` (or `GH_REPO`). Never guess any of these values.

## Before merging

Find the pull request for the current branch, or the one the user names. Show its URL. Follow `finish` until the pull request is open, green and mergeable, and its preview is ready for the latest commit and passes the browser check. If the pull request is a draft, mark it ready for review with `gh pr ready <pr_number>` once it is green and mergeable.

If the preview build fails, read its build logs with the host's own tool (for example `vercel inspect <deployment_url> --logs`, with the scope the project names, or the Vercel MCP). Fix the cause in the same pull request and follow `finish` again. Never merge with a failed check, or a failed or missing preview.

## Merge

While a workflow runs, `done` merges where the project level allows it. A PR with migrations merges through `ndev:merge`. With no workflow, merge with `gh pr merge <pr_number> --merge`. Record the merge commit from `gh pr view <pr_number> --json mergeCommit`.

## Confirm production

Wait for the production deployment for the merge commit:

```bash
gh api "repos/<owner>/<repo>/deployments?sha=<merge_sha>&environment=<production environment>"
gh api repos/<owner>/<repo>/deployments/<deployment_id>/statuses
```

Wait with a supported bounded wait, such as `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-run.sh` when a workflow run does the deploy. Never run a manual polling loop. Production is confirmed only when its latest status is `success` for the merge commit. Then open the production site and each page the change affects at Laptop (1440 × 900), iPad (820 × 1180) and iPhone (390 × 844) sizes. Look at each screenshot yourself, then send them to the user with `SendUserFile`.

If the production build fails, read its build logs. Create a new fix branch from the current base branch and open a new pull request. Follow `finish` until it is green, mergeable and its preview passes. The user's `/publish` covers merging a fix that only repairs the failed build. Merge it and confirm production again. Ask the user before merging any other kind of fix.

## Report

Tell the user in plain English:

- the pull request URL;
- the host's deployments page, if the project has one;
- the live site, plus a direct link to each page the change affects;
- that production is ready on the merge commit and passed a browser check.

If a build fix was needed, say what failed and link its pull request. If access, an external service or a user decision blocks progress, stop at the last confirmed state and name the blocker.

## The workflow

If a workflow runs for this issue (`mcp__ndev__status` tells you), commit with `mcp__ndev__checkpoint`, and end with `mcp__ndev__done`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
