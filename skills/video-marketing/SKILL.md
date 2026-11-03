---
name: video-marketing
description: "Write and review a marketing film of about 60 seconds that tells a prospective client why to talk to you. Use when the video type is marketing, or for a social cut, a loop for events or a teaser."
---

# Marketing films

A marketing film tells a prospective client, in about a minute, why to talk to you. It moves from a question, to the problem, to the offer, to evidence, to one action. This skill gives the rules the kit enforces. The shared rules are in `video-types`.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Shape

- About 60 seconds of narration, never more than 90. The kit fails the timeline above 90 s.
- One idea per scene: one headline and one supporting visual. Scenes usually last 3.5 to 11 seconds.
- Open with a question the viewer is already asking. Close with one action, the one the project's instructions name, for example "Book a conversation at example dot com".
- After the narration, the end card holds silently for 30 s, then a credits page shows for 8 s. The kit's marketing timing sets this.
- Alternate light and dark scenes. Never put two dark scenes next to each other.

## Words

- Use the marketing register: plain, confident and true. Contractions are allowed.
- One or two sentences per scene, about 8 to 30 words. Lead with the point, and put the strongest word last.
- The headline on screen repeats or sharpens the narration. It never says something different.
- Claims must match the website or the published essays. Never invent clients, numbers or results.
- Client logos appear only as organisations "our team has worked with", and only with permission the project records.

## Pictures

- Mix three backgrounds: photography under a gradient shade, white, and soft gradients.
- Use the page's tokens on `:root` and its fonts.
- Choose photography with the `video-images` skill. Avoid AI clichés such as glowing brains, robots and binary code, and avoid staged handshakes.
- Body text at least 26 px; headlines much larger. Keep the bottom 150 px clear for captions.

## Branding

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`). Use its voice for the words, and its colours and fonts for the page tokens (see `video-setup`). If the guide has a video style or a video review checklist, follow it and check it before you share the film. Otherwise skip this section.

## Variants

- A social cut of about 30 s, a square or vertical cut, or a loop for events, each needs its own script and review. Never crop the 16:9 film for a vertical cut. Lay each scene out again. The kit renders 1920×1080 only for now, so tell the user that a square or vertical cut needs a change to the kit first.

## Review

Before you share a marketing film, also check:
- Every photographer is named on the credits page and in the credits file.
- The film makes sense with the sound off.
- There is one action at the end, and it is the same in the narration, the caption and the end card.
