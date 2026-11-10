---
name: ux-principles
description: "Apply the project's UX guidance to navigation, disclosure, touch, accessibility and feedback decisions."
---

# UX guidance

Find the project's UX pages from its wiki index file (usually under a `visual/` section). Read only the pages that apply to the decision. If the project has no UX pages, use the principles below and record the decision in the wiki.

| Decision | Principle |
|---|---|
| Usability and priority | Apply standard usability heuristics. Make the most important item the most visible. |
| What to show | Use progressive disclosure: show the summary first, and the detail on request. |
| Navigation | A reader always knows where they are and how to go back. |
| Touch and input | Touch targets are at least 24 by 24 CSS pixels (WCAG 2.5.8), and 44 by 44 on touch layouts. Every action works from the keyboard. Forms say what is wrong and how to fix it. |
| Accessibility | Meet WCAG 2.2 AA: contrast, labels, focus order, and no meaning carried by colour alone. |
| Feedback and performance | Place feedback where the user’s visual attention already is: change the state or label of the control they just used, and put progress, results and errors beside that action or the affected content. Do not rely on a distant toast or banner as the only feedback. Keep focus stable and announce changes accessibly. Show that work has started. Show progress for slow work. An error names the next action. |

- Use the project's design system for the actual tokens and components. For React UI work, prefer repository-owned shadcn/ui primitives for controls, forms, dialogs, menus and selection; theme their standard behaviour and basic styling to the project brand. Keep bespoke illustrations and cinematic scenes custom. Follow the project's existing primitive family (Base UI or Radix), preserve keyboard/focus semantics, and test validation and application state when migrating. Do not replace working interactions with CSS lookalikes or run an initializer that overwrites established global styles.
- For a motion-rich interaction that shadcn/ui lacks (hold to confirm, progress rings, live counters), look at [Kokonut UI](https://kokonutui.com/). It installs through the shadcn registry. Judge each control, adopt only what improves a real interaction, and follow [references/kokonut-ui.md](references/kokonut-ui.md) for install, licence, theming, accessibility and tests.
- Read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` before you write or replace a component, and choose each component from it. It names the source, the registry item and the styling rules for each component type.
- For the platform detail of a control (CSS, accessibility checks, keyboard tests, fallbacks), use `modern-web-guidance`. Its guides add to the component the map names; they do not replace it.
- Check desktop reflow and the mobile layout. Use `responsive-check` for the matrix of viewports and colour schemes, and `mobile-testing` for quick mobile screenshots.
- Use `copy` for the words.

Record a durable UX decision in the project's wiki, with the LLM-wiki ingest steps (the plugin's `kb/llm-wiki.md`). Do not copy project guidance into this skill.

## The workflow

To choose a component, call `mcp__ndev__iNeedA('react-component', description)`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
