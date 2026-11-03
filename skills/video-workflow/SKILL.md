---
name: video-workflow
description: "Make any change to a narrated video built with the video kit, from the request to an approved pull request: classify the change, branch, edit, rebuild only what changed, review, commit the render, finish and publish. Use when the user asks for any change to a video and no narrower video skill covers the whole request."
---

# Changing a video

The `video-*` skills hold the method. The project's instructions (`CLAUDE.md`, `AGENTS.md`) hold the facts about each video: its type, its voices, its sources and any scene-specific code.

## The workflow

If a workflow runs for this issue (`mcp__ndev__status` tells you), commit with `mcp__ndev__checkpoint`, and end with `mcp__ndev__done`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

1. **Understand the request.** Translate it into the kinds of change it needs:
   - narration, voice, pronunciation or length: `video-narration`;
   - the sound of the voices: `video-podcast-effect`. The effect is shared, so change it in the plugin;
   - visuals, on-screen text and animation: `video-scenes`;
   - photography, logos and credits: `video-images`.

   Many requests touch more than one. If a request is ambiguous, propose your reading in one sentence and go ahead. Ask only when the choice belongs to the user.
2. **Branch.** Create a feature branch from the current base branch (usually `main`), for example `edit/shorter-intro`. Continue an open pull request if it already covers the work. Never push to the base branch.
3. **Make the change.** Follow the matching skills, and the rules of the video's type (`video-types`). Keep any readable script copy (`script.md`) in step with the script file.
4. **Rebuild only what changed**, for every voice in `video.config.json`:
   - Narration text or voice: `npm run voice -- --voice <id> <scene numbers>`, then `npm run timeline -- --voice <id>`.
   - Timing or a new kit version: `npm run timeline -- --voice <id>`.
   - Visuals only: no rebuild step.
5. **Review.** Follow `video-render-review`: show the user each change as you make it, render the stills, inspect every one, fix the problems, render the MP4 and check it.
6. **Commit everything the video is built from.** That means the sources, and for every voice its `audio/vo*/*`, `audio/narration*.wav`, `timeline*.json`, `film/timeline*.js` and `out/<name>*.mp4`, plus `out/stills/*`. A reviewer can then watch the result straight from the branch. Never commit `out/review/`.
7. **Show your progress.** After every round of edits, show the user the before-and-after stills, the text changes and a clip of each changed scene, with sound. Send the contact sheet and the MP4 after each full render. Take their tweaks on the same branch.
8. **Finish.** When the user says they are finished or types `/finish`, follow `video-finish`. It pushes, opens the pull request as a draft, fixes failures until it is green and mergeable, and hands off with preview links to each changed scene.
9. **Publish.** Merge only when the user types `/publish` or gives equally clear approval. Then follow `video-publish`.

## The kit

`scripts/video-kit/` is a copy of the plugin's engine. Never edit it in a project: `npm run check` fails on a local edit. To change the kit, change `skills/video-setup/scripts/` in the plugin, then sync it into the project with `video-setup`.
