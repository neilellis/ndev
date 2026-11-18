# Checks and fixes

The probe (`scripts/probes.mjs`) measures the page. `responsive-lib.mjs` judges the numbers. Each finding has a check name, a severity, a selector and a detail.

| Check | Severity | Where | Rule |
|---|---|---|---|
| `overflow` | error | every viewport | The page is wider than the viewport: a sideways scroll. WCAG 1.4.10. The selector is the deepest element that ends past the viewport and inside the page width. An element that a parent clips is not named. When no element is named, look for a pseudo-element, a transform or a negative margin. |
| `viewport-meta` | error | phones and tablets | No `<meta name="viewport" content="width=device-width, initial-scale=1">`, or the meta stops zoom (`maximum-scale=1`, `user-scalable=no`). WCAG 1.4.4. |
| `target-size` | error under 24 px; warning under 44 px on touch rows | every viewport | A tap target is too small. WCAG 2.5.8 sets 24 × 24 CSS px. 44 × 44 is the Apple and WCAG 2.5.5 (AAA) size. A link inside a sentence is not checked. A target wholly off the page (a skip link at `left: -9999px`) is not checked. A small target with room around it passes 2.5.8 by its spacing exception: a 24 px circle on its centre touches no other target and no other small target's circle. It is then a warning on touch rows only. |
| `input-zoom` | warning | phones and tablets | An input font under 16 px. iOS Safari zooms the page when the input gets focus. |
| `vh-units` | warning | phones and tablets | A height in `vh`. On mobile, `100vh` is taller than the visible area when the browser bars show. |
| `text-size` | warning | phones and tablets | Text under 12 px. |
| `contrast` | error | every viewport, each scheme | Text contrast under 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold). WCAG 1.4.3. A background image makes the contrast unknown, so it is not checked: look at the screenshot. |

The popular responsive design skills say "44 px minimum". That is the AAA and Apple size, not the WCAG AA rule. This skill uses 24 px as the error and 44 px as the warning on touch rows.

## Fixes

### Overflow

- Find the deepest element in the finding. The usual causes: a fixed `width` in px, a long word or URL, a `min-width` on a flex child, a wide image, a table, a code block, or `100vw` (it includes the scroll bar).
- Use `max-width: 100%` on media. Use `min-width: 0` on flex and grid children so that they can shrink (`minmax(0, 1fr)` in a grid track), and `flex-shrink: 0` on avatars, icons and trailing actions so that they keep their size. Use `overflow-wrap: anywhere` for long strings, not `word-break: break-all`.
- A wide table or a code block gets its own scroll container: `overflow-x: auto`. The page does not scroll sideways.
- Do not hide the overflow on `body`. That clips content and hides the defect.

### Viewport meta

Use `<meta name="viewport" content="width=device-width, initial-scale=1">`. Do not block zoom. Add `viewport-fit=cover` only when the page also uses safe-area insets. On a page with an input pinned to the bottom (a chat composer), add `interactive-widget=resizes-content`, so that the Android keyboard shrinks the layout and `dvh` follows it. iOS Safari ignores it: check that page on a phone with the keyboard open.

### Touch targets

- Give the control padding, not a larger icon: `min-height: 44px; min-inline-size: 44px` on touch layouts.
- When the visual size must stay small, extend the hit area with a pseudo-element (`::after { inset: -10px }`).
- Keep 8 px between near targets.
- Put the size in a token (for example `--target-min`) and record it on the brand site.

### Input zoom

Set `font-size: 16px` (or `1rem`) on inputs, selects and text areas at phone widths. Do not block zoom to stop it.

### Viewport height

- Use `min-height: 100svh` for a hero that must fit the visible area. Use `100dvh` when the height must follow the browser bars (it causes a re-layout as they move). `100lvh` is the largest size.
- Keep `100vh` before it as a fallback for old browsers only: `min-height: 100vh; min-height: 100svh`.

### Safe areas

On a page with `viewport-fit=cover`, pad fixed bars with `env(safe-area-inset-bottom)` and the other insets, so that the notch and the home indicator do not cover controls.

### Hover on touch

A tap leaves `:hover` applied until the next tap, so a hover style sticks. Put each `:hover` style under `@media (hover: hover) and (pointer: fine)`, and give touch an `:active` style. The Tailwind v4 `hover:` variant already has a hover media query: check hand-written CSS. A menu that opens on `:hover` only does not open on touch: open it on click too.

### Touch feel

- Remove the tap highlight (`-webkit-tap-highlight-color: transparent`) only when each control has its own `:active` style.
- Set `touch-action: manipulation` on buttons and links, so that quick repeat taps (a stepper) do not zoom the page.
- In an app shell with its own scroll areas, set `overscroll-behavior: contain` on each one (a list, a sheet, a sidebar), so the scroll does not move the page behind. Do not block scroll with a `touchmove` listener that calls `preventDefault()`.

### Type and spacing

- Use fluid type: `font-size: clamp(2rem, 1.2rem + 4vw, 4rem)`. Always put a `rem` term in the middle value, so that zoom still works.
- Keep the line length near 45–75 characters: `max-inline-size: 70ch` on text blocks. Check the Desktop row for this.

### Layout

- Mobile first: write the base styles for the phone, and add `min-width` media queries.
- Set breakpoints where the content breaks, not at device widths.
- Use container queries (`container-type: inline-size`, `@container (min-width: 30rem)`) for a component that appears in columns of different widths.
- Use grid `repeat(auto-fit, minmax(min(16rem, 100%), 1fr))` for card lists: it needs no breakpoints and never overflows.
- Use logical properties (`margin-inline`, `padding-block`) so that a right-to-left language works.
- Use `srcset` and `sizes` (or the framework's image component) so that a phone does not load the desktop image. Set `aspect-ratio` to stop layout shift.

### Contrast in dark mode

- Dark mode is a design of its own, not inverted colours. Each text and border token gets a dark value that passes 4.5:1 on the dark surface.
- Set `color-scheme: light dark` on `:root`, so that form controls and scroll bars follow the scheme.
- Give the browser bar a colour for each scheme: two `<meta name="theme-color">` tags with `media="(prefers-color-scheme: light)"` and `dark`, in the colour of the top of the page. In Next.js, use `themeColor` in the `viewport` export. When the site stores its own theme, update the tag when the user changes it.
- Check images and logos on the dark surface: a dark logo on a dark background disappears. Give them a dark variant or a light outline.
