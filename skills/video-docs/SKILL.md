---
name: video-docs
description: "Keep documentation videos true to the documentation they cite: trace each scene to its source pages, detect stale sources, choose the smallest rebuild, record source-only reviews, and review script and delivery evidence. Use when documentation pages change under a video, when creating a documentation video, or when merging a branch that rebuilt one."
---

# Documentation videos

A documentation video repeats claims from documentation pages. When a page changes, the video can become wrong. This skill keeps each video traceable to its sources and its evidence tied to the files it reviewed. Use the `video-*` skills for the method of making the video, and `video-how-to` or `video-explainer` for its words. Work from the repository root. This skill does not authorise publishing or deployment.

## Inputs

Each video has an authored content file, for example `<videos folder>/<id>/content.json`. Each scene names its supporting pages in `sources`, and can name a diagram in `visual.diagram`. Edit the content file, never a generated script copy. The project's instructions name the videos folder, the IDs, and the commands of its build.

## Provenance and freshness

`scripts/sources-manifest.mjs` in this skill keeps a manifest beside the content file:

- `write` snapshots the SHA-256 of the content file and of every cited page and diagram, maps each to its scenes, and records `sourceRevision` (git HEAD).
- `status` exits 1 and lists each changed, missing or remapped dependency with its scenes.
- `review` records a source-only review (below).

Run it as `node "${CLAUDE_PLUGIN_ROOT}/skills/video-docs/scripts/sources-manifest.mjs" <command> <content.json>`. If the project has its own manifest tool, use that one instead and follow the same rules.

`sourceRevision` is provenance, not the video's commit, and does not prove that the working tree was clean. The hashes capture the reviewed bytes, including uncommitted ones. Keep that difference in reports.

## Update from documentation

1. Run `status` for every video. A stale or missing manifest must fail. Search the other videos' content files for the same paths, so a shared concept is reviewed in every video.
2. Read each changed page in full. Review each affected scene's narration, on-screen text, commands, examples and citations. Edit the content file to match the current meaning. Add or remove citations when the supporting pages change.
3. Review two things separately: first integrity (true to the sources and the project's naming and boundary rules), then readability for the intended viewer. Keep illustrative scenarios separate from forecasts. Label fictional and simulated examples.
4. Choose the smallest path that produces current evidence:

| Change | Path |
|---|---|
| Cited pages changed, narration and visuals still true | Source-only review. Keep the build and media |
| Narration changes | Manifest, voice, timeline, stills, render, checks and delivery review |
| Slide, screenshot, diagram or timing changes | The same rebuild without voice, when narration and voice settings are unchanged |
| Provider or voice changes | A representative sample, then every scene and every downstream output |

Do not run `write` before the review. It snapshots the new bytes and can hide a stale explanation. When a change makes a documented claim false, the narration that repeats it is wrong, not merely stale. Rewrite those scenes and rebuild.

## Source-only review

Use it only when every affected scene is still true. Read each changed page and every scene that cites it, including commands and visuals. Then run:

```bash
node sources-manifest.mjs review <content.json> --page <path> [--page <path>...] \
  --integrity "<conclusion, with scene IDs and findings>" --readability "<conclusion>"
```

It updates only those page hashes and appends the review, without dropping the build record. Keep the existing media and its evidence. Never claim fresh playback, listening or rendering for evidence you carried forward.

## Script review

Review every narration in two passes: integrity, then clarity for the intended audience. Define unfamiliar terms on first use. Start with a concrete question or operator action. For operators, compare exact button labels and commands with the cited pages. Run `docs-legibility` on the narration if the project scores readability. Record the scene coverage, the corrections and the limits, tied to the content hash. Never write a passing record only to satisfy a check.

## Delivery review

- Inspect every still, the contact sheet and frames taken from the encoded MP4: the start, chapter boundaries, the end, and the densest scenes.
- Check captions against the actual audio.
- Test the final MP4 in a real browser, including playback and a seek. Use Orca's built-in browser when Orca runs (`orca status`): open the page with `orca tab create --url <url> --json`, then drive the `<video>` with `orca eval` and read `orca console`. Codec metadata alone does not prove decoding. Record the browser and environment you used.
- A browser setting that a test needs is not a reason to report this check as skipped. Run the check in Orca's browser instead. List a skipped test only with what it covers: it may cover a different video.
- Report voice qualities (softness, pronunciation, pace) as unassessed unless a person listened.
- Tie the delivery record to the MP4 hash. Report the measured duration, the reviewed coverage and the remaining limits.

## Merge the base branch over a rebuilt video

- Choose one coherent set of content, media and provenance for each video. Compare both branches; do not assume one side wins. Check the content, MP4 and build hashes before you choose.
- If only citations or metadata changed on the base, keep the reviewed build and do a source-only review where the meaning is unchanged.
- If both branches changed scenes, merge the content and rebuild only what those changes invalidate. Scenes can be renumbered, so match narration and purpose as well as IDs.
- Never hand-merge passing review fields, or replace a content hash without the review. Keep old review records tied to their own hashes.
- Search the merged JSON, HTML and Markdown for conflict markers. Read each check's exit status directly, never through a pipe to `tail`.

## Tests

`node --test tests/*.test.mjs` in `skills/video-docs/scripts/` checks the manifest tool offline.
