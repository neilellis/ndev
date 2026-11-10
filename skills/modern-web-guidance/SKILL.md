---
name: modern-web-guidance
description: "Find and apply the modern web platform guide for an HTML, CSS or client-side JavaScript task: dialogs, popovers, menus, forms, select, tables, dark mode, colour, typography, layout, container queries, view transitions, scroll-driven and entry animation, accessibility, Core Web Vitals, images, security, passkeys, web components, built-in AI and Chrome extensions. 233 guides from GoogleChrome/modern-web-guidance, with ndev notes that keep the styled third-party components of the component map. Use before you write or change web UI code."
---

# Modern web guidance

This skill holds a local copy of every guide in [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) (Apache-2.0, maintained by the Chrome, Edge, Firefox and MDN teams). The guides give the current platform feature for a job, its browser support and its fallback. They stop an agent from writing a legacy pattern from old training data.

## What comes first

The guides are written for plain HTML, CSS and JavaScript, and many of them build a control by hand from a native element. Our rules come first:

1. The project's own design system and components.
2. The component map. Read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` before you write or replace a component. In a React app, a control that the map names comes from the map (shadcn/ui first, then the approved registries), styled with the project's tokens.
3. The plugin's design skills: `brand`, `ux-principles`, `motion`, `responsive-check` and `copy`.
4. The guide.

In a React app, take from a guide what can sit on top of the component: CSS, tokens, accessibility checks, keyboard tests, performance rules and fallbacks. Do not replace the component with the guide's hand-written native markup. Use the native markup as written only on a page with no React: a static page, an artifact, generated HTML or a diagram.

A guide that changes how it applies here starts with an **ndev** note under its title. The note wins over the guide's text. The index marks these guides.

## Find the guide

1. Open [index.md](index.md). It lists each guide by area, with its title and first sentence. Search it for the user-visible job, for example `grep -i "dialog\|modal" ${CLAUDE_PLUGIN_ROOT}/skills/modern-web-guidance/index.md`.
2. Read the specific guide in full, and the broad guide for its area when one applies (`accessibility`, `forms`, `css`, `css-layout`, `color`, `typography`, `dark-mode`, `performance`, `security`, `html`).
3. Follow the links in a guide to the guides it names. They are local files.

Do not run the upstream `npx modern-web-guidance` command. This copy replaces it.

## Browser support

The guides assume that a **Baseline Widely available** feature is safe with no fallback. For a feature that is only **Newly available**, or not Baseline, follow the guide's fallback section.

A project can set its own policy in its `CLAUDE.md` or `AGENTS.md`. For example: `**Browser support:** Newly available Baseline features are allowed with feature detection and graceful degradation. A fallback adds at most 20 lines and no new dependency.` Follow that policy when it exists. A polyfill is a new dependency: it needs a row in `${CLAUDE_PLUGIN_ROOT}/kb/libraries.md` first.

## Check the result

Before you report the work, check the code against the guide you used: its MANDATORY and DO NOT rules, its fallback, and any ndev note. In the pull request or the reply, name each guide that shaped the code, by its id.

## Update the copy

The guides are generated. Do not edit a file in `guides/` or `index.md` by hand. To change how a guide applies here, edit or add `overlays/<id>.md` (one short paragraph). Then run the sync again:

```bash
git clone --depth 1 https://github.com/GoogleChrome/modern-web-guidance <checkout>
node ${CLAUDE_PLUGIN_ROOT}/skills/modern-web-guidance/scripts/sync.mjs <checkout>
node --test ${CLAUDE_PLUGIN_ROOT}/skills/modern-web-guidance/scripts/tests/sync.test.mjs
```

The script fails, and writes nothing, when an overlay names a guide that no longer exists or a cross-reference names an unknown guide. A Chrome extension reference uses the overlay name `chrome-extensions--<id>`.

## The workflow

To choose a component before you apply a guide, call `mcp__ndev__iNeedA('react-component', description)`. For an animation, call `mcp__ndev__iNeedA('animation', description)`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
