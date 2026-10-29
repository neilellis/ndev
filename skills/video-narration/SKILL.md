---
name: video-narration
description: "Write or change a video's narration, voices, pronunciation, pacing or captions, then regenerate and check the voice. Use when the user asks to change what the narrator says, how a name is said, which voice reads it, or how long the video runs."
---

# Narration

The script is one line of narration per scene, in the file `"script"` names in `video.config.json` (by default `scripts/vo.json`). Entry N is spoken over `<section id="sN">` in the page. Each line becomes one voice clip per voice.

## Writing for the ear

- Follow the register of the video's type (see `video-types`). Use British English unless the project says otherwise.
- Write it the way it is spoken. Write numbers as words ("seventeen", not "17"). Write web addresses as said ("example dot com"). Captions show the written form when `video.config.json` lists it under `"captions"."written"`, for example `{ "example dot com": "example.com" }`.
- Fix how a name is said under `"pronounce"` in `video.config.json`, for example `"Kubectl": "cube cuttle"`. The voice model takes no delivery instructions, so the kit rewrites the text it reads. Matching ignores case.
- Lists of three, joined with "and". No acronym the listener has to decode, except AI.

## Changing a line

1. Edit the line in the script file, and in any readable copy of the script the project keeps, such as `script.md`.
2. Run the copy check (`npm run copy`). Fix what it finds in the new line before you make any voice.
3. Regenerate that scene for every voice in `video.config.json`: `npm run voice -- --voice <id> <scene>`.
   - This needs `OPENROUTER_API_KEY` (or `OPEN_ROUTER_API_KEY`) for the speech and `OPENAI_API_KEY` for the word timings. The keys are in the project's `.neil-dev.env` (see the README of the plugin). Run the command through `node ${CLAUDE_PLUGIN_ROOT}/scripts/env/neil-dev-env.mjs run --need OPENROUTER_API_KEY,OPENAI_API_KEY -- npm run voice -- …`, or give the file to a project helper that takes a credentials file. Never print, read or commit the keys, and never ask for them in chat. If a key is missing, tell the user which step cannot run and ask them to add it to `.neil-dev.env`.
4. Rebuild each voice's timeline: `npm run timeline -- --voice <id>`. It applies the podcast effect, prints the new length and the scene boundaries, and fails if the video is over its type's limit.
5. Fix the word cues. Search the page and its script files for `w:N:` for each changed scene, and point each cue at a word still in the line. A missing word fails the render.
6. Listen without ears (below), then show the user the change (see `video-render-review`) and listen for pace, names and clipped endings.

`npm run check` fails if a line changed but its voice was not regenerated, or if a clip was spoken by a different voice.

## Listening without ears

Read `audio/vo/sN.json` and, for each other voice, `audio/vo-<id>/sN.json`. Whisper's transcript must match the line, apart from expected spelling differences such as numerals or American spelling. Whisper often joins or misspells product names and drops "dot" in a spoken web address; that is expected. A missing or garbled word means the take is bad. Regenerate that scene alone.

## Length

`npm run timeline` prints the narrated length as `film`, and stores it as `filmEnd` in `timeline.json`. The end-card hold and the credits page follow; `total` includes both. Report the narrated length whenever it changes. If an edit pushes the narration near its type's limit (see `video-types`), say so and suggest a cut. To shorten a video, cut words first and change the tempo last.

## Voices

- `video.config.json` lists the voices under `"voices"`. The first voice is the main cut and keeps the plain file names (`audio/vo/`, `timeline.json`, `out/<name>.mp4`). Every other voice adds its id (`audio/vo-<id>/`, `timeline-<id>.json`, `out/<name>-<id>.mp4`).
- The speech model is HeyGen Voice 1 through OpenRouter (`"model"`). Word timings come from OpenAI Whisper.
- Before you change a voice or the model, make a short sample of a representative line and ask the user to listen. A sample request approves only a sample.
- Changing a voice means regenerating every scene for it.

## Timing

The video type sets the pacing: `tempo`, the silence before and after each scene, the end-card hold and the credits page. A project overrides them under `"timing"` in `video.config.json`. Tempo above about 1.18 sounds rushed. After a timing change, rebuild every voice's timeline.
