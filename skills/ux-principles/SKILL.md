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
| Touch and input | Touch targets are at least 44 by 44 CSS pixels. Every action works from the keyboard. Forms say what is wrong and how to fix it. |
| Accessibility | Meet WCAG 2.2 AA: contrast, labels, focus order, and no meaning carried by colour alone. |
| Feedback and performance | Show that work has started. Show progress for slow work. An error names the next action. |

- Use the project's design system for the actual tokens and components.
- Check desktop reflow and the mobile layout. Use `mobile-testing` for mobile screenshots.
- Use `copy` for the words.

Record a durable UX decision in the project's wiki, with the LLM-wiki ingest steps (the plugin's `kb/llm-wiki.md`). Do not copy project guidance into this skill.
