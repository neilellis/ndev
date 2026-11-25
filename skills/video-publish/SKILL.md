---
name: video-publish
description: "Merge the current video change's pull request and confirm the production deployment plays the video. Use when the user types /publish or says \"Approve and publish\" in a video project. Fixes build or render problems it finds."
---

# Publish the current change

When the user types `/publish`, that is their approval to merge the pull request for the current change. Use `video-finish` to get it ready. Never push to the base branch directly.

## The workflow

If a workflow runs for this issue (`mcp__ndev__status` tells you), commit with `mcp__ndev__checkpoint`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## What you need from the project

Read these from the project's instructions. If one is missing, ask the user once and suggest they record it there:

- the production viewing page's URL;
- the deployment environment name that GitHub deployments use for production (often `Production`);
- the host's deployments page, if there is one;
- whether the viewing pages ask for a sign-in.

The repository comes from `gh repo view --json nameWithOwner -q .nameWithOwner` (or `GH_REPO`). Never guess any of these values.

## Before merging

Find the pull request for the current branch, or the one the user names. Show its URL. Follow `video-finish` until it is open, green, mergeable, and its preview is ready for the latest commit and plays the video in a browser. If the pull request is a draft, mark it ready for review with `gh pr ready <pr_number>` once it is green and mergeable.

If the GitHub check fails to render the video, read its log with `gh run view <run_id> --log-failed`. If the preview build fails, read its build logs with the host's own tool (for example `vercel inspect <deployment_url> --logs`, with the scope the project names). Fix the cause in the same pull request and follow `video-finish` again. Never merge with a failed check, or a failed or missing preview.

## Merge

Merge with `gh pr merge <pr_number> --merge`. Record the merge commit from `gh pr view <pr_number> --json mergeCommit`.

## Confirm production

Wait for the production deployment for the merge commit:

```bash
gh api "repos/<owner>/<repo>/deployments?sha=<merge_sha>&environment=<production environment>"
gh api repos/<owner>/<repo>/deployments/<deployment_id>/statuses
```

Wait with a supported bounded wait, such as `ndev wait branch-ci <branch>` when a workflow run on that branch does the deploy. Never run a manual polling loop. Production is confirmed only when its latest status is `success` for the merge commit. Then open the production viewing page in a browser and confirm the video plays, including at each changed scene.

If the production build fails, read its build logs. Create a new fix branch from the current base branch and open a new pull request. Follow `video-finish` until it is green, mergeable and its preview plays. The user's `/publish` covers merging a fix that only repairs the failed build. Merge it and confirm production again. Ask the user before merging any other kind of fix.

## Report

Tell the user in plain English:

- the pull request URL;
- the host's deployments page, if the project has one;
- the viewing page, plus a link to each changed scene, in the form `<viewing page>/?t=<seconds>` (the scene's start in `timeline.json`);
- that production is ready on the merge commit and the video played in a browser check;
- whether the viewing page asks for a sign-in, and with which account, as the project's instructions say.

If a build fix was needed, say what failed and link its pull request. If access, an external service or a user decision blocks progress, stop at the last confirmed state and name the blocker.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
