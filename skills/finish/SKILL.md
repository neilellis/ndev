---
name: finish
description: "Push the current change in a website or app project and keep fixing its pull request until it is green and mergeable, ready for approval, with preview links to each changed page. Use when the user says they are finished or types /finish in a website or app project (for a video project use video-finish)."
---

# Finish the current change

Read [the ndev CLI skill](${CLAUDE_PLUGIN_ROOT}/skills/cli/SKILL.md) for native commands and when to use them. Prefer those commands for workflow operations when `ndev` is available. Keep this skill's gates and ownership rules.

The user may not be technical. Tell them what is happening in plain English, with clear links. Never merge. Merging needs `/publish` or "Approve and publish" (see `publish`).

## The workflow

If a workflow runs for this issue (`mcp__ndev__status` tells you), do not use this skill's push and wait: call the tool for the current stage. `mcp__ndev__finishedDevelopment`, then `mcp__ndev__finishedReview`, push and mark the PR ready, and the workflow watches the checks. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Writing rules

If `<project root>/.ndev.json` has a `branding` key, follow the project's brand copy rules for progress and ready reports. Use the `copy` skill for those rules, and when a fix changes text on the site. Find the root with `git rev-parse --show-toplevel`.

## What the loop needs

- `gh`, signed in (`gh auth status`), in a checkout of the project's repository. The repository comes from `gh repo view`. Pass `--repo <owner/repo>` or set `GH_REPO` to change it.
- Local checks: an `npm run precheck` script, else `scripts/precheck.sh`. The push fails, and names the repair, if neither exists.
- Pull request checks, and a preview deployment that reports to GitHub deployments (for example, Vercel or Netlify). Both are the project's own. If the project has no preview, the loop waits and then reports that the preview is not ready. Tell the user and stop.
- The base branch is `main`. Pass `--base <branch>` if the project uses another.
- The production environment in GitHub deployments is `Production`. Pass `--production-env <name>` if the project's instructions name another.

## Before the loop

1. If the branch is the base branch, create a new branch from it.
2. Commit the remaining work with the required trailers.

## The loop

`scripts/finish.mjs` in this skill runs one round. It pushes through `scripts/push-checked.sh`, which merges the current base branch and runs the local checks. It waits for the pull request checks with `ndev wait checks`, and for the preview deployment. It checks every completion condition and marks a green, mergeable draft ready for review. It also enforces the limits: at most 5 fix rounds, and a stop when the same failure repeats. It keeps its round count in the git folder (`neil-dev-finish/`).

1. Tell the user: "I'm saving your change and checking it. I'll keep you posted."
2. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/finish/scripts/finish.mjs"` in the project's folder. If the branch has no open pull request, add `--title "<plain title>" --body-file <file>`. The body has a `## Lessons` section. The `## Lessons` section states what the work taught, or says that there is none and why (`${CLAUDE_PLUGIN_ROOT}/kb/proof.md`). When the project has `.github/workflows/ndev-proof.yml`, run `ndev proof run --local --base origin/<base> --body <body file>` before the push, and fix each check that fails. End the body with the required attribution lines. Add `--page /<path>` for each affected page that the diff does not show (see **Changed pages**).
3. Show the user every output line that does not start with `[agent]`, as written. `[agent]` lines are instructions for you.
4. Act on the exit code:
   - `0` ready: do the browser check below. If it fails, fix the cause and go back to step 2. Then report as below.
   - `1` fix needed: read the logs named in the `[agent]` lines and find the first causal error. Fix the cause without weakening any check. Add or keep a regression test for a behaviour change. Commit, and go back to step 2.
   - `2` cannot start: do what the `[agent]` line says, then go back to step 2.
   - `3` stopped: show the message, and explain in one or two plain sentences what the user can do next.
   - `4` still waiting: go back to step 2. This does not count as a fix round.

Never run your own polling loop and never bypass the script. Retry without a code change only when the evidence shows a transient failure.

## Changed pages

The script finds changed pages from the diff against the base branch:

- Next.js app router: `app/**/page.*` or `src/app/**/page.*`. Route groups `(name)` and slots `@name` are not in the URL.
- Next.js pages router: `pages/**` or `src/pages/**`, except `pages/api/` and files that start with `_`.
- Dynamic routes (`[slug]`) and all other files give no page.

When a change to a component, content file or style affects a page, pass that page with `--page /<path>`. For a dynamic route, pass one real path, for example `--page /blog/first-post`. If no page is known, the report links the preview's home page.

## Browser check

Open each preview link from the ready report at Laptop (1440 × 900), iPad (820 × 1180) and iPhone (390 × 844) sizes. When Orca runs, use `${CLAUDE_PLUGIN_ROOT}/scripts/browser/orca-shot.sh <url> <out.png> --viewport 1440x900` (then `820x1180` and `390x844`). Each call opens and closes its own tab. Orca's browser keeps the user's sign-in. Otherwise use the project's browser tool, or `claude-in-chrome`. Take a screenshot of each page at each size. Look at each screenshot yourself: the page loads, the change is present, and nothing overlaps or overflows. Then send the screenshots to the user with `SendUserFile`, and label each one with its page and device.

If the preview asks for a sign-in that you cannot pass, use the host's own access tool (for example, a Vercel share link from the Vercel MCP `get_access_to_vercel_url` tool). If you cannot get access, say that the browser check is not done, and why.

## Decisions

If a fix needs a decision from the user, stop the loop. If the answer changes the design or a requirement, record it with the `adr-pdr` skill. Ask one short, plain question, with the options and your recommendation. After they answer, apply it and restart the loop with `--restart`, which resets the round count.

## Report

Show the pull request URL as soon as it is known, and again at the end. The ready report links straight to each changed page on the preview deployment. If you used a share link to get access, give the user the share links, and say when they expire. Ask the user to open the pages and check that they are happy. Then say they can type `/publish` to put the change live.

## Test the loop's logic

`node --test tests/*.test.mjs` in `skills/finish/scripts/` runs the decision tests offline. `node scripts/finish.mjs --help` and `bash scripts/push-checked.sh --help` print the usage.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
