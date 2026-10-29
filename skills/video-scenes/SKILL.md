---
name: video-scenes
description: "Change what a video shows: layout, on-screen text, animation, colours, word cues, or adding, removing and reordering scenes on the film page. Use for any visual change to a narrated video built with the video kit."
---

# Scenes

The kit renders a film page: an HTML file (`"page"` in `video.config.json`, by default `film/index.html`) that draws any frame on request. For a new film, start from the template in `skills/video-setup/scripts/templates/film/` (see `video-setup`). The page holds one section per scene, the credits page and the CSS. Its script file (`film/film.js` in the template) holds the animation.

## The page contract

The page must provide:
- `window.ready`: a promise that resolves when every font and image has loaded. It must reject with the failed file's name if one fails.
- `window.seek(t)`: draws the frame at `t` seconds.
- One `<section class="scene" id="sN">` per script line, numbered from `s0` in order. The check fails if the count differs from the script.
- An optional `<section class="post" id="credits">` for the credits page.
- The page loads `timeline.js`, or `timeline-<voice>.js` when the address has `?voice=<voice>`. That file sets `window.TIMELINE`: `total`, `filmEnd`, `credits`, `scenes` (`start`, `duration`, `voiceAt`, `speech`), `captions` (`text`, `start`, `end`) and `words` (`scene`, `word`, `start`).

## Every frame is a pure function of time

A frame must look the same however the renderer reaches it.
- Never use CSS transitions, CSS animations, `setTimeout`, `Date.now()` or `Math.random()`.
- Use a GSAP timeline sought with `tl.time(t)`, or compute from `t` in a render function. Use a seeded random function for generated layouts.
- Throw on any bad state, such as an unknown word cue or a missing image. Never hide the error. The render fails on any page error.

## Cues

The template's runtime reads these attributes:

| Attribute | Effect |
|---|---|
| `data-in="s+0.4"` | Fades and rises in 0.4 s after the scene starts. |
| `data-in="w:4:maps"` | Enters when the narrator says "maps" in scene 4. `w:4:maps+0.2` adds an offset. |
| `data-in="c+1.2"` | On the credits page: enters 1.2 s after the page appears. |
| `data-kb="1.04 1.12"` | A slow zoom on a photo, from the first scale to the second, over the scene. |
| `data-shot="w:4:what"` | Crossfades in a screenshot. |
| `data-bar="w:5:shown 0.67"` | Grows a bar to 67 % width on that word. |
| `data-arrow="w:4:settings"` with `data-sign="Open Settings"` | Points an arrow at the element on that word, with the sign beside it. |

A word cue is the spoken word in lower case, with only letters, digits and hyphens.

### Arrow cues

An arrow cue draws a `browser-arrows` arrow (`arrow.js`, calm look, size L, a box round the target). The kit ships `arrow.js` as `scripts/video-kit/arrow.js`, and the template loads it before `runtime.js`. To point at a control in a screenshot, put a box over it: `<span class="spot" style="left: 62%; top: 8%; width: 6%; height: 4%" data-arrow="w:4:settings" data-sign="Open Settings"></span>` inside the screenshot's positioned frame.

- Cue the arrow on the word that names the control, so it appears as the viewer hears it.
- The arrow holds until the next arrow in its scene, or until the next scene starts.
- Write the sign as an instruction or a name: 3 to 6 words, 1 to 40 characters.
- Leave at least 1.8 s from one arrow to the next, and from an arrow to the scene's end. The arrow draws on in 0.6 s and pulses twice; the render refuses a cue with less time.
- Keep the target and the sign clear of the title and of the captions band.
- The arrow draws on when the film plays through its cue. A still or a `?t=` preview that jumps past the cue shows it drawn, so a still depends only on its time.
- The renderer drives `arrow.js` with Playwright's clock, so every render draws the same frames.
- The render refuses a cue whose element has no size, or whose sign `arrow.js` cannot draw, before it starts.

## Look and text

- Use the tokens on `:root` and the page's fonts.
- Body text at least 26 px. Headlines much larger. Text must read on a phone.
- Captions sit in the bottom 150 px. Keep important content above that area.
- A `.dark` class marks scenes with dark backgrounds. The type's skill sets the backgrounds and pictures: `video-how-to`, `video-explainer` or `video-marketing`.
- On the credits page, wrap each photographer's name in `<span class="nm">` (or the page's equivalent) so it never breaks across lines.
- Record scene-specific behaviour (for example a generated network or a globe drawn in a render function) in the project's instructions, as a table of scene and behaviour, so the next editor finds it.

## Branding

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`). Set the `:root` tokens and fonts from it before you change any colour or font, and match its logo use. Otherwise skip this section.

## Preview

Open the page with `?t=12` to freeze one frame, or `?play` to play it in real time without sound. For review, use `npm run stills` and `npm run review -- <scenes>`, as `video-render-review` describes.

## Adding, removing or reordering scenes

1. Change the script, any readable script copy and the `<section>` elements together. Keep the ids sequential.
2. Renumber every `w:N:` cue and every scene-specific reference in the page's code, for example `#s4` or `T.scenes[6]`.
3. Regenerate the voice for every scene whose number changed, in every voice, then rebuild the timelines (see `video-narration`). Clip files are named by scene number.
