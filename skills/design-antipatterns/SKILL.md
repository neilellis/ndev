---
name: design-antipatterns
description: Spot and repair generic AI website design when building or reviewing pages, especially repeated SaaS styling, empty marketing copy, and invented proof. Use when a page needs a distinct design grounded in its content and audience.
---

# Design antipatterns

Use Slopstrap's satire as a diagnostic lens for choices made without a reason. A cluster of stock effects can bury a site's purpose. A gradient, card, rounded corner, dark theme, or Inter typeface alone is not a defect.

Respect the brief and the existing design system. If the user wants deliberate Slopstrap satire, preserve that intent. Keep invented proof clearly fictional in a parody or demo.

## Start with the page's job

Identify the audience, the decision or task, the primary action, and the facts that support it. Use the supplied brief and existing content. Ask only when a missing answer can change the design.

Look at the actual page or supplied screenshot when available. For code-only reviews, distinguish likely visual issues from observed ones. Do not claim to have checked rendering, contrast, motion, or mobile behavior without inspecting it.

## Diagnose before changing

Read [the pattern catalogue](references/patterns.md) for concrete signals and repairs. Use the entries that match the page. Do not turn the catalogue into a required redesign checklist.

For each finding, name the element and explain the harm in context. State when the choice is useful. Prefer findings such as “the three equal service tiles hide the emergency phone number” over “cards look like AI.”

Check these questions:

- Does the structure follow the content, or has content been split to fill a stock grid?
- Do color, type, borders, and emphasis carry meaning, or repeat decoration?
- Are status, metrics, testimonials, logos, and certifications supported by evidence?
- Does copy explain the offer and next action, or can another company reuse it unchanged?
- Do effects help people notice state or make a decision, or compete with the task?

Prioritize invented claims and broken tasks, then hierarchy and readability, then decorative repetition. Do not infer that a page was made by AI from its appearance.

## Repair the cause

Make the smallest coherent change that restores purpose. Use the product's real content, visual assets, and brand cues. Do not replace the same template with a fashionable alternate template.

For a new page, choose hierarchy, layout, and emphasis from the content before adding effects. For an existing page, keep components that serve a clear role. Plain lists, tables, grouped text, screenshots, or a short example often communicate more than another card grid.

Keep accessible names, focus states, semantic structure, contrast, and usable touch targets. Do not remove a meaningful status cue or alert treatment merely because Slopstrap parodies it. Pair color with text or another cue. Respect reduced motion when adding or changing animation.

## Check the result

Revisit the primary action and the content that supports it at narrow and wide widths. Check reading order, keyboard use, text over effects, and motion where the change affects them. Label checks that were not run.

For a review, return a short ordered list: location, observed signal, user impact, and proposed repair. Include useful choices to keep when this prevents an unnecessary redesign. For implementation, make the authorized changes and report what changed and what was verified.

For source history and the limits of this interpretation, see [provenance](references/source.md).
