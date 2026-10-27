# Brand worklist

`/brand create` made this site from the neil-development brand template. The template's defaults came from a real brand guide. Work through this list and replace each default with the project's own values. Delete each line when it is done, and delete this file when the list is empty. `/brand check` reports this file while it exists.

## Values, from the project's source

- [ ] Colours: `public/ds/tokens/colors.css`, then the `Swatch` hex values in `app/foundations/colour/page.mdx` and the `PAIRS` contrast table in `app/components/Specimens.tsx`.
- [ ] Gradients: `public/ds/tokens/gradients.css`.
- [ ] Type: `public/ds/tokens/typography.css` and `fonts.css`, the font files in `public/ds/assets/fonts/`, and `TypeScale` in `app/components/Specimens.tsx`.
- [ ] Space and layout: `public/ds/tokens/spacing.css`, and `SPACE_SCALE` and `SPACE_PX` in `app/components/Specimens.tsx`.
- [ ] Depth and motion: `public/ds/tokens/elevation.css`.
- [ ] Breakpoints: `app/responsive/breakpoints/page.mdx`.
- [ ] Logo: `app/components/Wordmark.tsx` and `public/ds/assets/mark.svg`, then the Logo page.
- [ ] Component classes: `public/ds/components.css`. Keep the class names the same as the project's markup.

## Content, from the project's copy

- [ ] Voice examples: `app/voice/page.mdx` and `app/copy/page.mdx`. Quote the project's real copy.
- [ ] Demos: `app/components/page.mdx`, `app/sections/page.mdx` and `app/ui-kit/page.mdx`.
- [ ] Diagrams, iconography and infographics: replace the default examples with the project's own, or mark them as recommendations.
- [ ] Images: replace every `placeholder.svg` with the project's own image, or delete the demo. Credit each photograph in `THIRD_PARTY_NOTICES.md`.
- [ ] Film: if the project has no film, delete `app/video/` and its links in `lib/nav.ts`. If it has one, take the scenes, timings and narration from it.
- [ ] Banned words: keep the default list, and add the project's own tells to `public/ds/copy/banned.json`. Then run `node scripts/copy/vale.mjs --write`.
- [ ] Governance: list the project's source files on `app/governance/page.mdx`.

## Done when

- `scripts/precheck.sh` passes.
- `grep -rn "placeholder.svg\|Placeholder" app` lists only demos that are labelled as placeholders on purpose.
