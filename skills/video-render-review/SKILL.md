---
name: video-render-review
description: "Render a video's stills and MP4, inspect them, show the user before-and-after comparisons and clips after each round of edits, and verify the final files. Use after any change to a video's narration, scenes, images or sound, and before sharing or finishing it."
---

# Render and review

Rendering needs Node 22 or later, the project's npm dependencies (`ffmpeg-static`, `ffprobe-static`, `playwright-core`) and Google Chrome. Do not rely on a system FFmpeg. Run every command in the video's folder.

## 1. Stills

Run `npm run stills`.
- It writes `out/stills/scene-N.png` shortly after each scene's last spoken word, when that scene is fully built, and `out/stills/sheet.jpg`, a contact sheet of every scene.
- The stills do not include a credits page. Check it with `node scripts/video-kit/render.mjs --stills <credits.start + 2>`, using `credits.start` from `timeline.json`.
- For specific moments, `--stills 12.5,40` writes `out/stills/t-12.50.png` and so on.
- The render fails on any page error, including a bad word cue or a missing image. Fix the cause. Never suppress the error.

Look at the contact sheet, then at each changed scene at full size. Check for:
- Text that overlaps other text, or is clipped at the frame edge.
- Content hidden behind the captions.
- A caption that does not match what is on screen.
- Elements that are still missing after their cue.
- Spelling, and the project's spelling variety (British English unless it says otherwise).
- Colours and fonts that differ from the page's tokens.
- The checks in the type's skill: `video-how-to`, `video-explainer` or `video-marketing`.

To check an animation, render several times across the scene. Fix what you find and render again.

## 2. Show the work as you go

The user reviews alongside you, so show each change as soon as you have made it. Do not wait for the final render.

Run `npm run review -- <scenes>`, for example `npm run review -- 7 credits`. It writes `out/review/`, which must not be committed:
- `scene-N-before-after.jpg`: the approved still beside the current one.
- `scene-N.mp4`: the scene as it now plays, with narration.
- `changes.md`: the narration and on-screen text, approved and now.

"Approved" means the review base in `video.config.json` (`origin/main` unless `review.base` is set). Look at each image and clip yourself first. Then send the user the comparison images and clips with your harness's file-sending tool. If it has none, link to the files. Quote the text changes as "before" and "now". After a narration change, rebuild the timeline first so that the clip has the new voice. After a change to the sound alone (`video-podcast-effect`), send short audio samples of each voice first, then the clips.

Do this after every round of edits, including small changes the user asks for. Ask the user what they think, and take the answer into the next round.

## 3. Final render

Run `npm run render`.
- It writes one film per voice: `out/<name>.mp4` for the main cut and `out/<name>-<id>.mp4` for each other voice. Each is H.264, 1920×1080, 30 fps, with AAC narration. `node scripts/video-kit/render.mjs --voice <id>` renders one.
- It takes a few minutes per minute of film, so run it in the background if your harness allows that.

Then verify each file:
- **Duration** matches that voice's timeline `total`, which includes the end-card hold and the credits page. Probe it with the `ffprobe-static` binary.
- **Loudness** is about −16 LUFS with no clipping.
- **Frames:** extract a few from the MP4 itself and look at them, including the densest scene. This catches encoding problems that the stills miss.
- **Captions** match the audio. Watch at least the changed scenes with sound.

## 4. Hand-off

Send the user the contact sheet and the MP4. If your harness cannot send files, link to them on the pull request branch. In one or two plain sentences, say what changed, the new length, and anything you were unable to check. Report voice quality (softness, pronunciation, pace) as unchecked unless someone listened.

Never describe a render you did not inspect as checked.
