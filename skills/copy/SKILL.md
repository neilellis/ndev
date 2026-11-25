---
name: copy
description: "Write or review user-visible copy: interface text, labels, errors, empty states, glossary definitions and accessible text."
---

# Interface copy

Write for the product's real reader, who has no project or insider background. Read the project's CLAUDE.md or wiki for the audience, house vocabulary and spelling. If they state nothing, use British English.

## The workflow

If a workflow runs for this issue (`mcp__ndev__status` tells you), commit with `mcp__ndev__checkpoint`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Rules

- Use sentence case, ordinary verbs and short sentences. Contractions are correct in interface text.
- Front-load the meaning. Use a specific label ("Delete 3 reports", "Billing"), not an umbrella word ("Manage", "Settings", "Submit").
- A headline says what this product does, and for whom, with the product's own nouns. If it still fits after you swap in a competitor's name, rewrite it. Use only facts that are already on the page.
- A page title names the context (the page, the period, the project), not a greeting such as "Welcome back, Sam! 👋".
- No exclamation marks in interface text. No hype words (`supercharge`, `seamless`, `unlock`, `magic`, `revolutionise`) and no "AI-powered" label on each feature: say what the feature does.
- Labels, buttons, headings and captions have no final full stop. Only text of two or more sentences keeps its full stops.
- A placeholder is a short hint or example ("Search", "DD/MM/YYYY"), not a sentence ("Search anything..."). It does not replace the visible label.
- A change names its comparison: "+12% vs last month", not "+12%".
- If a claim cannot be checked ("Loved by 10,000+ teams", "10x faster"), ask whether it is true. Make a true claim specific and give its source. Remove the claim otherwise, and list it in the report.
- An error or an empty state gives a useful next action.
- Keep database names, internal codes, raw errors and implementation jargon out of public copy. Operator tools can keep precise technical terms.
- Format numbers, money, dates and plurals with `Intl` (`NumberFormat`, `DateTimeFormat`, `RelativeTimeFormat`, `PluralRules`) in the user's locale. "1 members", `1284` and a literal `null`, `undefined` or `NaN` are defects.
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
