---
name: infographic
description: "Create raster infographic images (PNG or JPEG from an image-generation tool) with bundled layout and visual-style references, such as bento grids, timelines, funnels, atlases and data ribbons. Use when the user asks for an infographic, a visual summary, an explainer poster or an illustrated one-page overview. For SVG or HTML diagrams and charts drawn as code (architecture, flowcharts, sequence diagrams), use diagram-design or archify instead."
license: MIT
---

# Infographics

This skill makes raster images with an image-generation tool. It does not draw SVG or HTML. For diagrams that are code (architecture, flows, sequences, data charts), use `diagram-design` or `archify`.

Choose a layout for the structure of the information and a style for its appearance. Use the combination, aspect, language and backend that the user asks for. Otherwise, choose from the content: `bento-grid` with `craft-handmade` suits an overview. Ask only when a missing choice changes the result a lot.

## Brand

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`). Take the colours and the type from the tokens of the brand guide, and write them into the prompt as named colours with hex values and as font descriptions. They replace the palette of the chosen style; keep the layout and the texture of the style. Follow the rules of the guide on logo use. Otherwise skip this section.

## Preferences

Read optional preferences from the first file that exists:

1. `.baoyu-skills/baoyu-infographic/EXTEND.md`
2. `${XDG_CONFIG_HOME:-$HOME/.config}/baoyu-skills/baoyu-infographic/EXTEND.md`
3. `$HOME/.baoyu-skills/baoyu-infographic/EXTEND.md`

These are the upstream locations, so existing preference files continue to work. The schema is in [references/config/preferences-schema.md](references/config/preferences-schema.md). No preference file is necessary. The current instructions of the user come first, then the brand guide, then the preferences.

## Create

1. Find the central message, the source facts and the audience. Keep numbers, units, qualifiers and attribution. Short labels can paraphrase but must not change the meaning. Do not include secrets.
2. Choose from `references/layouts/` and `references/styles/`. Read only the files you choose. Useful layouts: `linear-progression` for sequences, `comparison-matrix` for comparisons, `dense-modules` for detailed guides, `meander-data-ribbon` for cumulative values over time, and `choropleth-atlas` for coverage on a map.
3. Combine the chosen references with [references/base-prompt.md](references/base-prompt.md). Write the complete final prompt to `infographic/<topic>/prompts/infographic.md` before you generate. Include every label and the aspect ratio: landscape `16:9`, portrait `9:16`, square `1:1`, or the ratio that the user asks for.
4. Use the image-generation tool that is available, with its documented image and reference parameters. Do not assume a Skill invocation API. Do not start a different agent CLI to render. If the user chose an available backend, use it. For a reference image, give the image directly when the tool supports it. Otherwise, describe its style and palette if that is why the user gave it.
5. Examine the result for correct facts, spelling, legibility and composition. Correct generated text with image editing or a new generation, not with an overlay painted by code. Keep the earlier candidates when you revise.
6. Give the user the image and the prompt path. Name each defect that you could not correct.

For complex source material, use [references/analysis-framework.md](references/analysis-framework.md) and [references/structured-content-template.md](references/structured-content-template.md). Save the analysis and the structured content next to the prompt. Do not overwrite files that the user made.

## Source

Adapted from the `baoyu-infographic` skill in baoyu-skills by Jim Liu (`JimLiu/baoyu-skills` on GitHub), under the MIT licence in [LICENSE](LICENSE). The layout and style references come from it, with neutral worked examples.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
