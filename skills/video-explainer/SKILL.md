---
name: video-explainer
description: "Write and review an explainer video of 2 to 5 minutes that shows how something works and why it matters, with diagrams first. Use when the video type is explainer, or when a request asks to explain an idea, a product or a method on video."
---

# Explainer videos

An explainer shows how something works and why it matters to the viewer's organisation. It teaches first. The sales angle is slight: the viewer should finish understanding the idea, and only then hear one soft invitation. The shared rules are in `video-types`.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Purpose and shape

Use this shape, one point per scene:

1. **The question.** A real business question the viewer has, in their words. One or two scenes.
2. **How it works.** The idea or the product, step by step, with diagrams. This is most of the film.
3. **What it means for you.** What changes for the viewer's organisation, with its limits.
4. **One soft action.** For example "Read the documentation at …". One action only.

Never open with the company, the product name or a claim. Open with the question.

## Sources

- Every claim must come from the documentation or the published essays. Cite the supporting pages for each scene, as a how-to does.
- Explain limits as clearly as strengths. Say what is measured, what is estimated and what is unknown. Unknown is not zero.
- Keep illustrative scenarios separate from forecasts. Label fictional and simulated examples on screen.
- Never invent clients, numbers or results. Client names appear only as organisations "our team has worked with".

## Words

- The body (stages 2 and 3) uses the documentation register: plain, exact and without contractions. Define each term on first use. Spell out a framework's terms before you use their short forms.
- The opening question and the closing action may use the marketing register: a natural rhythm and contractions, still plain and true.
- No superlatives and no banned words. The copy check (`npm run copy`) finds them.

## Pictures

- Diagrams first. Make them with the project's diagram tool, or with the `diagram-design` skill, and keep each icon's meaning the same in every scene.
- Use product screenshots as evidence, not decoration.
- Photography is optional and secondary.
- Show the headline or takeaway only when the narration says it. In a narrated scene, the caption carries the words. Do not also show a duplicate takeaway.
- Alternate light and dark scenes.

## Pace and length

- The kit's explainer timing: `tempo` 1.06, slightly longer holds than a marketing film, a 5 s end card and a 6 s credits page.
- 2 to 5 minutes of narration. If it runs longer, split it into two explainers, or move the procedure into a how-to.
- Give each diagram time: hold it at least two seconds after the narration that describes it ends.

## Review

Before you share an explainer, also check:
- Review the content twice, separately: first that it is true to the sources, then that the intended viewer can follow it.
- The film teaches the idea even if the viewer ignores the final action.
- Every diagram label is readable at laptop size.
