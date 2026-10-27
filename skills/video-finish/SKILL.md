---
name: video-finish
description: "Push the current video change and keep fixing its pull request until it is green and mergeable, ready for approval, with preview links to each changed scene. Use when the user says they are finished with a video change or types /finish in a video project."
---

# Finish the current change

The user may not be technical. Tell them what is happening in plain English, with clear links. Never merge. Merging needs `/publish` or "Approve and publish" (see `video-publish`).

## What the loop needs

- `gh`, signed in (`gh auth status`), in a checkout of the video project's repository. The repository comes from `gh repo view`; pass `--repo <owner/repo>` or set `GH_REPO` to change it.
- An `npm run precheck` script in the project (see `video-setup`). The push fails, and names the repair, without it.
- A pull request check that renders the video, and a preview deployment that reports to GitHub deployments. Both are the project's own. If the project has no preview, the loop waits and then reports that the preview is not ready: tell the user and stop.
- The base branch is `main`. Pass `--base <branch>` if the project uses another.

## Before the loop

1. If the branch is the base branch, create a new branch from it.
2. Follow `video-render-review` if anything the video is built from changed since the last render: render the stills and the MP4, and inspect them. The pull request must carry a fresh render if the preview shows the committed `out/` files.
3. Commit the remaining work with the required trailers.

## The loop

`scripts/finish.mjs` in this skill runs one round. It pushes through `scripts/push-checked.sh`, which merges the current base branch and runs `npm run precheck`. It waits for the pull request checks with `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh`, and for the preview deployment. It checks every completion condition and marks a green, mergeable draft ready for review. It also enforces the limits: at most 5 fix rounds, and a stop when the same failure repeats. It keeps its round count in the git folder (`video-finish/`).

1. Tell the user: "I'm saving your change and checking it. I'll keep you posted."
2. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/video-finish/scripts/finish.mjs"` in the video's folder. If the branch has no open pull request, add `--title "<plain title>" --body-file <file>`. Write the body in viewer terms: what changes on screen and in the voice, and the new length. End it with the required attribution lines. Add `--scene <n>` or `--scene credits` for any affected scene the script cannot see, for example after an animation change in the page's script file.
3. Show the user every output line that does not start with `[agent]`, as written. `[agent]` lines are instructions for you.
4. Act on the exit code:
   - `0` ready: open each preview link in a browser and confirm the video plays and cues to the scene. If that fails, fix it and go back to step 2. Then hand off as below.
   - `1` fix needed: read the logs named in the `[agent]` lines and find the first causal error. Fix the cause without weakening any check. Re-render if the fix changes the video. Commit, and go back to step 2.
   - `2` cannot start: do what the `[agent]` line says, then go back to step 2.
   - `3` stopped: show the message, and explain in one or two plain sentences what the user can do next.
   - `4` still waiting: go back to step 2. This does not count as a fix round.

Never run your own polling loop and never bypass the script. Retry without a code change only when the evidence shows a transient failure.

## Decisions

If a fix needs a decision from the user, stop the loop. Ask one short, plain question, with the options and your recommendation. After they answer, apply it and restart the loop with `--restart`, which resets the round count.

## Hand-off

Show the pull request URL as soon as it is known, and again at the end. Send the user the contact sheet (`out/stills/sheet.jpg`) and the MP4 (`out/<name>.mp4`), as `video-render-review` describes. The ready report links straight to each changed scene on the preview (`?t=<seconds>` and `#scene-N`). Ask the user to watch them, and say the preview host may ask them to sign in. Then say they can type `/publish` to make it the approved video.

## Test the loop's logic

`node --test tests/*.test.mjs` in `skills/video-finish/scripts/` runs the decision tests offline. `node scripts/finish.mjs --help` and `bash scripts/push-checked.sh --help` print the usage.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
