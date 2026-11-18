---
name: copy
description: "Write or review user-visible copy: interface text, labels, errors, empty states, glossary definitions and accessible text."
---

# Interface copy

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Use this check before writing copy that changes a product promise or a domain term.

Write for the product's real reader, who has no project or insider background. Read the project's CLAUDE.md or wiki for the audience, house vocabulary and spelling. If they state nothing, use British English.

## The workflow

If a workflow runs for this issue (`mcp__ndev__status` tells you), commit with `mcp__ndev__checkpoint`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Rules

- Use sentence case, ordinary verbs and short sentences. Contractions are correct in interface text.
- Front-load the meaning.
- An error or an empty state gives a useful next action.
- Keep database names, internal codes, raw errors and implementation jargon out of public copy. Operator tools can keep precise technical terms.
- Expand an unfamiliar acronym. Explain a domain term that must stay.
- When you simplify a claim, keep its thresholds, denominators, uncertainty and coverage. A simpler claim that says more than the data is an overclaim.
- If the project keeps a corrections ledger, check it when you change the explanation of a published metric.
- Desktop and mobile versions of a screen must say the same thing.
- Avoid all-caps paragraphs and low-contrast text that carries meaning.

## Branding

If `<project root>/.neil-dev.json` has a `branding` key, read `branding.guide` (or `branding.site` when there is no guide) before you write. Use its vocabulary, voice and product names; the rules above still apply. Find the root with `git rev-parse --show-toplevel`. Otherwise skip this section.

## Tested copy

When a test asserts the copy, update the exact assertion with the copy. Never weaken a selector or an assertion to make a rewrite pass.

## Glossary

If the project has a glossary component or registry, use a registered term:

- Tag the first relevant use in a block, only in its domain sense.
- Do not put a glossary trigger inside a heading, button, link or table column header.
- Keep the wrapped text verbatim.
- An entry has a canonical term, unique aliases, a plain one-sentence definition and a group. A definition must not depend on an unexplained acronym.
- A published name (a band, a verdict) is data vocabulary. Explain it. Do not rename it in the interface alone, because the API and stored snapshots also use it.

Use `forget` when you retire a term, to update copied definitions and uses. Use `ux-principles` for usability and the project's design system for type and contrast. Run the project's copy and glossary tests when the change affects them.
