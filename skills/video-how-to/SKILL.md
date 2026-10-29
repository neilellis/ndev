---
name: video-how-to
description: "Write and review a how-to video that shows one task from start to a result the viewer can check, with the real product on screen. Use when the video type is how-to, or for a quick start, a walkthrough or a task guide on video."
---

# How-to videos

A how-to video shows one task, from its start to a result the viewer can check. It is documentation in moving form. It must be accurate enough that a viewer can follow it with the product open beside it. The shared rules are in `video-types`.

## Purpose and scope

- One task per video, named in its title: "Sign in for the first time", not "Getting started with the product".
- State what the viewer needs before they start, such as access, a role or an installed tool.
- End when the viewer can see the result. Name the next task and where the documentation is. Never ask for a meeting, a purchase or a sign-up.
- Never sell. Words like "powerful", "seamless", "effortless" and "transform" do not belong here.
- If the task changes in the product, the video is wrong, not just old. Update it before anyone else watches it (see `video-docs`).

## Sources

- Every scene names the documentation pages that support it. Keep that list with the scene, for example a `sources` list in the scene's data.
- Compare every button label, menu path, field name and command with the documentation and with the product. Show them exactly as the product shows them.
- When a cited page changes, read the page again and review each scene that cites it. A changed page that needs no script change still needs a recorded review.

## Words

- Use the documentation register: strict simple English (ASD-STE100). Use "must" for a requirement. Do not use contractions. For operators, common technical terms are allowed when the viewer knows them.
- Say each step as an instruction: "Select **Sign in**." One action per sentence.
- Say the name of each control the way it appears on screen, and show it highlighted when it is said.
- Define a product term the first time it is used.
- Number the steps on screen when a task has more than three steps.

## Pictures

- Show the real product: screenshots or a terminal. The kit's page cannot play video yet, so show a screen recording as a sequence of stills. Use diagrams only to show where a step fits.
- Use real but non-sensitive values. Never show real keys, passwords, tokens or personal data. Blur or replace them.
- Label example and demonstration data as such.
- Point at the control the narration names. In a kit film, cue an arrow on the word that names it, with a short sign (the `video-scenes` skill, "Arrow cues"). In a live browser recording, the `browser-arrows` skill draws the pointer, the arrow and the zoom. Hold each result on screen long enough to read: at least two seconds after the narration ends.
- Set long commands in a monospace font, and make them fit the frame. Break them on the screen only where the shell allows it.
- No photography, unless the task happens in a physical place.

## Pace and length

- The kit's how-to timing: `tempo` 1.0, longer holds between scenes, no end card or credits page.
- A quick start may run up to 4 minutes. A full guide may run up to 30 minutes, and must have chapters at each major step so a viewer can jump. The kit does not make chapters yet: until it does, keep how-to videos to a quick start, and tell the user a full guide needs a change to the kit first.
- Captions are burned in. The kit does not write a separate VTT file or a chapter list yet; say so when the player could use them.

## Voice

- Each voice listed in `video.config.json` reads the whole script and makes its own cut. The kit cannot yet mix two voices in one video, so chapter titles appear on screen only.

## Review

Before you share a how-to, also check:
- Every step on screen matches the documentation and the current product.
- A viewer could do the task with only this video. Follow it yourself where you can.
- No real secrets or personal data appear in any frame.
- The video ends on the visible result and the next task.
