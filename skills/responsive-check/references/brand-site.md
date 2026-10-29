# Keep the brand site up to date

The brand site is the source of truth for the responsive rules. `.neil-dev.json` names it under `branding` (its URL, and its local folder when the brand site is in the repository). The session prompt gives these values. When the project has no `branding`, skip this page.

## What the brand site records

| Rule | Where it usually goes |
|---|---|
| The breakpoints, with a name and a width each | foundations: layout |
| The maximum content width and the line length | foundations: layout, typography |
| The fluid type scale (the `clamp()` values) | foundations: typography |
| The spacing scale and the page gutter at each breakpoint | foundations: layout |
| The touch target size (24 px minimum, 44 px on touch) and the gap between targets | components, accessibility |
| The dark scheme tokens, and the contrast of each text token on each surface | foundations: colour |
| The safe-area and viewport-height rules (`svh`, insets) | foundations: layout |
| How each component changes at each breakpoint (navigation, tables, cards, forms) | components |

Read the brand site's own `CLAUDE.md` or `AGENTS.md` first. Follow its page structure and its voice.

## When you change a rule

1. Change the token or rule in the website's CSS.
2. Change the same value on the brand site page, and its design-system mirror (for example `public/ds/tokens/`), in the same PR. Many brand sites have a parity check (`brand:check` or similar): run it.
3. Give the reason in one sentence on the page, for example "44 px on touch layouts, the iOS and WCAG AAA size".
4. Show the component at the narrowest and the widest breakpoint in the page's specimen, in both schemes.

## Check the brand site itself

The brand site is also a website. Run the matrix on it:

```bash
WEB_DIR=<brand app dir> node <this skill>/scripts/responsive-check.mjs --base http://localhost:<brand port> / /foundations/colour /components
```

Its specimens and code samples are wide. A code sample gets `overflow-x: auto`; a colour table gets a scroll container or a stacked layout on phones. The brand site must pass its own rules.

## When the brand site and the website disagree

Do not choose one silently. Record the two values, say which the website uses now, and ask the owner which is correct. Then change the other one.
