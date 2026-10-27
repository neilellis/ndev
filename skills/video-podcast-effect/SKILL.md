---
name: video-podcast-effect
description: "Explain or change the podcast effect that makes the synthetic narration sound like a person on a podcast mic: pause and pace jitter, room tone, EQ, compression and loudness. Use when the user says the voice sounds robotic, too flat, too loud or too quiet, or asks to change the sound of the voices."
---

# The podcast effect

Every voice goes through the podcast effect, so the synthetic narration sounds like a person speaking into a podcast mic. It is part of the pipeline for every video type. `npm run timeline -- --voice <id>` applies it each time it builds a voice's timeline and narration track. The settings are in the kit's `engine/podcast.mjs`.

## What it does, in order

1. **Humanise each clip** (`humanise()`, before the timeline is set):
   - Every pause inside a line becomes randomly up to 20% longer or shorter (`PAUSE_JITTER`). That covers the gaps between words, at commas and between sentences. A pause is anything quieter than `SILENCE_DB` (−45 dB) for at least `MIN_PAUSE` (45 ms). The silence at a clip's very start and end is left alone.
   - Every run of words between two pauses is sped up or slowed down by up to 10% (`SPEECH_JITTER`) at the same pitch. Whole runs change, never single words, because single-word changes sound glitchy.
   - Each edited piece fades in and out over `FADE` (6 ms), so no cut clicks. All cuts fall in pauses, so the fades change no timing.
   - The word timings move with the audio, so captions and on-screen cues stay in sync.
2. **Room tone** (`ROOM_TONE`): a faint brown noise under the whole track, drifting in level on three slow waves. The pauses are never digitally silent. It sits about 44 dB below the speech: inaudible under the voice, present only in the gaps.
3. **Podcast sound, applied last to the voice and room tone together** (`PODCAST`): a high-pass filter against rumble, warmth at 150 Hz, less boxiness at 380 Hz, presence at 3 kHz, a softer top above 8.5 kHz, a de-esser and heavy compression.
4. **Level**: one fixed gain sets the track to `TARGET_LUFS` (−16 LUFS), measured over the whole track first. A limiter holds the peaks at −1.5 dB. A fixed gain stops the room tone being pumped up during a long silent end card.

The randomness is seeded from the voice, the scene number and the line's text. Every build of the same clip is identical. Regenerating a line's voice gives it a new pattern.

## Changing the sound

The effect is shared by every video that uses the kit, so change it in this plugin (`skills/video-setup/scripts/engine/podcast.mjs`), never in a project's copy. The project check fails on a local edit.

1. Edit the constants in the plugin's `engine/podcast.mjs`. Stronger compression raises the room tone in the pauses. Lower its `amplitude` in `ROOM_TONE` to match.
2. Audition before you build it into any video. Make a short sample of each voice, for example the first 22 seconds, with the same settings, and send it to the user. The kit has no sample command: run the timeline, then cut the first 22 seconds of each `audio/narration*.wav` with ffmpeg into your scratch folder. Keep sample scripts out of the repositories.
3. When the user approves, run the kit's tests: `node --test tests/*.test.mjs` in `skills/video-setup/scripts/`. `tests/podcast.test.mjs` guards the ranges, the seeding and the word-timing map. It needs `ffmpeg-static`; if it skips, link a project's `node_modules` at `skills/video-setup/scripts/node_modules` and run it again.
4. Raise `version` in `skills/video-setup/scripts/kit.json`, then sync the kit into each video project (see `video-setup`) and rebuild every voice's timeline there.
5. Check the levels of each narration track:
   - about −16 LUFS integrated, with peaks at −1.5 dB;
   - the room tone about −58 dB, both in the pauses and in any silent end.

   If the build stops with a loudness error, it prints ffmpeg's own output. Read it, fix the cause, and never drop the check.
6. Changing a pause or pace setting moves the word timings, the captions and every scene's length. Report the new lengths, then follow `video-render-review`.

Never switch the effect off for one voice or one video only. Every cut must sound like the same recording set-up.
