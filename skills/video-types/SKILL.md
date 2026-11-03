---
name: video-types
description: "Choose the type of a narrated video (how-to, explainer or marketing) and apply the rules every type shares. Use before writing a new video script, when a request could be more than one video, or when a video seems to drift between types."
---

# Video types

Every video is one of three types. Each type has its own purpose, register, length, look and review. Choose the type before you write a word, and record it as `"type"` in `video.config.json`. Never mix two types in one video. If a request seems to need two, make two videos.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

| | How-to | Explainer | Marketing |
|---|---|---|---|
| Skill | `video-how-to` | `video-explainer` | `video-marketing` |
| Question it answers | "How do I do this task?" | "How does this work, and why does it matter to us?" | "Why should we talk to you?" |
| Viewer | A user or operator, doing the task | A decision-maker or a new user, learning | A prospective client, deciding |
| Register | Documentation; technical documentation for operators | Documentation for the body; marketing for the opening and the close only | Marketing |
| Length of narration | One task. Quick start up to 4 minutes; full guides up to 30 minutes, with chapters (not yet supported by the kit) | 2 to 5 minutes | About 60 seconds; at most 90 |
| Pace (`tempo`) | 1.0 | 1.06 | 1.12 |
| Pictures | The real product: screenshots and terminal (screen recordings as stills for now) | Diagrams first; product screenshots as evidence | Photography, gradients, graphics |
| Claims come from | The documentation pages each scene cites | The documentation and the published essays | The website and the published essays |
| Close | The next task, and where the documentation is | One soft action, such as "see the documentation" | One clear action, the one the project's instructions name |
| End card and credits | None | A short end card and credits | End card holds 30 s, then 8 s of credits |

The kit applies each type's timing defaults. A project can change them in `video.config.json` under `"timing"`, but only for a reason it records in its instructions.

## Rules for every type

- Use the project's copy rules in the register the table gives. If the project has none, use the `copy` skill. Use British English unless the project says otherwise.
- Never invent clients, numbers, results or features. Every claim needs a source the type allows.
- Label fictional and demonstration data as such, on screen or in the credits.
- Captions are burned in, and the video must make sense with the sound off.
- Every frame is 1920×1080 at 30 fps, and is a pure function of time (see `video-scenes`).
- Every voice goes through the podcast effect (see `video-podcast-effect`).
- Do not credit the AI voice model in the credits unless the project asks for it.
- Show the user each round of changes as you go, and inspect every render before you share it (see `video-render-review`).

## Branding

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`) before you write. Use its copy rules for the register, its voice and its product names, and its video pages if it has them. Otherwise skip this section.

## Signs you chose the wrong type

- A how-to that says "powerful", "seamless" or "transform" has drifted into marketing. Remove the claim, or move it to an explainer.
- An explainer that asks for a meeting before it has explained anything is a marketing film. Explain first, and keep one soft action for the end.
- A marketing film that teaches a procedure is too long and loses its viewer. Link to the how-to instead.
