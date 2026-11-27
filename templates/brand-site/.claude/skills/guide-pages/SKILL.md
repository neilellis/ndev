---
name: guide-pages
description: Add, move or edit a page of the {{name}} brand guide.
---

# Guide pages

## Page anatomy

- A page is `app/<path>/page.mdx`. It starts with `export const metadata = { title: "…" };` and one `# Heading`. The title appears as "Title · {{name}} brand guide".
- Add every page to `NAV` in `lib/nav.ts`. The structure test fails if a sidebar link has no page.
- Use the shared components registered in `mdx-components.tsx`: `Demo`, `DoDont`, `Still`, `StillGrid`, `Rule`, `Tokens`, the specimens (`Swatch`, `SwatchGrid`, `GradientTile`, `TypeScale`, `SpacingScale`, `RadiusBox`, `ElevationCard`, `ContrastTable`) and `Wordmark`/`BrandLockup`. Register a new component there before using it.
- Wrap live examples in `<Demo>`. It applies `.ds`, so the example renders with the real design system and not the guide's own styles.
- Images live under `public/ds/assets/` and are referenced as `/ds/assets/…`. Every image needs alt text that says what it shows.

## Content

- Keep Core principles (`app/core-principles/page.mdx`) short. It is the page AI tools read first, so update it when a rule on any other page changes.
- State rules plainly, with the value: "Body text is 18px", not "use a comfortable size". Use tables for values and `DoDont` for judgement calls.
- Quote real copy from the website, essays or film. Label placeholder copy "Placeholder" in the demo. Mark guidance that is not taken from a source as a recommendation.
- Follow `copy` for wording. Guide pages are documentation, so they use simple English. Run the copy check on each page you change.

## Check it

Run `scripts/precheck.sh`. On the Vercel preview, open each changed page at desktop width and at 390px. Check that images load, nothing scrolls sideways, and the sidebar marks the current page.
