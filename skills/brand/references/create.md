# /brand create

Make the project's brand guide and design system site. The finished site has the same parts as the template: tokens, components, page sections, UI kit, colour, type, layout, depth and motion, logo, photography, diagrams, iconography, infographics, accessibility, UX, responsive, mobile, copy rules, voice, banned words, a Vale style and, if the project has one, film. Values come from the project. Where the project has no value, the template's default stays, and `BRAND-TODO.md` lists it.

## 1. Choose the folder

- If `branding.path` is already set and its folder has `public/ds/tokens/`, the site exists. Stop and offer `/brand check`.
- If the project has an `apps/` folder (a monorepo), use `apps/brand`.
- Otherwise make a standalone app in a new sibling folder, `../<project>-brand`, as its own git repository. Say where it is.
- If the user's note names a folder, use that folder.

The folder must be new or empty. `scaffold.mjs` refuses any other folder, and it never overwrites.

## 2. Take an inventory of the project's brand

Read before you write. Use one bounded search for each item, and keep each value with its source file and line.

| Item | Where to look |
|---|---|
| Name, product names, domain | `package.json`, `README.md`, the site header and footer, `<title>`, metadata, `CNAME`, deployment config |
| Colours | CSS custom properties, Tailwind `theme.colors` or `@theme`, SCSS variables, theme files, the most-used literals (`audit.mjs` output is a quick count) |
| Gradients and shadows | `linear-gradient`, `radial-gradient`, `box-shadow` in the stylesheets |
| Type | `font-family`, `@font-face`, `next/font` calls, font files, the heading and body sizes, weights, line heights, letter spacing |
| Space and layout | Spacing scale, container widths, gutters, grid columns, radii |
| Breakpoints | Media queries, Tailwind `screens` |
| Motion | `transition`, `animation`, easing curves, durations, `prefers-reduced-motion` |
| Logo and mark | The header logo component or SVG, `favicon`, `apple-touch-icon`, `public/` logo files |
| Components | The markup and class names of buttons, links, cards, forms, navigation, footer, section layouts |
| Voice | The home page, about page and calls to action: real sentences to quote |
| Images | Photographs, product screenshots and illustrations, with their credits |
| Film | A video project, script or rendered stills, if any |

A violet-to-blue gradient, a glow or a sparkle is not a brand value, even in the logo, unless the user says that it is. List it as a finding, not as a token.

If the project is new and has almost none of these, say so, and keep the defaults.

## 3. Make the site

Write the config to the scratchpad:

```json
{
  "name": "Acme Widgets", "product": "WidgetHub", "domain": "acme.example",
  "siteUrl": "https://brand.acme.example", "repo": "acme/acme-web (apps/brand)",
  "sourceRepo": "acme/acme-web", "source": "acme-web",
  "filmSource": "acme/acme-film"
}
```

`filmSource`, `nameSpoken`, `domainSpoken`, `slug` and `style` are optional. Then run `node $S/scaffold.mjs --target <folder> --config <file>`. It reports each missing key, unknown key or unfilled placeholder by name.

## 4. Put in the project's values

Work through the new site's `BRAND-TODO.md` from top to bottom. For each line:

- **Tokens.** Write the project's values into `public/ds/tokens/*.css`. Keep the token names. They are a public interface, and the pages and tests use them. Add a token when the project has a value that no token holds. Remove a default token only when no page uses it.
- **Derived data.** After you change a token, update the data that copies it: the `Swatch` hex values on the Colour page, and `SPACE_SCALE`, `SPACE_PX` and `TypeScale` in `app/components/Specimens.tsx`. Give each colour alias a dark value as well as a light one, in the three blocks of `colors.css`. The contrast table calculates its ratios from the tokens. Add a row to `PAIRS` in `lib/colors.ts` for each new text and background pair.
- **Logo.** Put the project's logo SVG into `app/components/Wordmark.tsx` and its mark into `public/ds/assets/mark.svg`. Keep the `brand-*` class names, and update the Logo page's colour table.
- **Components.** Change `public/ds/components.css` to match the project's markup and class names, so markup moves between the project and the guide unchanged.
- **Content.** Replace the default examples with quotes from the project's real copy. Label invented layout text "Placeholder". Mark guidance that the project does not show as a recommendation. Replace each `placeholder.svg` with a project image, or delete the demo.
- **Film.** If the project has no film, delete `app/video/` and its links in `lib/nav.ts`.
- **Provenance.** Name the source file of each value on the Governance page, and in each token file's first comment.

Delete each `BRAND-TODO.md` line when it is done. Leave a line only when the project has no value for it, and say so in the report.

## 5. Prove it

In the site folder: `npm install`, then `scripts/precheck.sh` (lint, types, tests and the static build) and `node scripts/harness-sync/check.mjs`. Both must exit 0. Then open the home page, Colour, Typography, Logo and Components pages in the browser, and compare them with the project.

## 6. Record it

Set `branding` in the project's `.ndev.json`: `site` (the planned URL), `name`, and `path` (the folder, relative to the project root). Keep the keys that are already there. The docs, diagram, copy and video skills then use the brand.

## 7. Report

In at most eight lines: the folder, the values taken from the project (as counts: colours, fonts, components), the `BRAND-TODO.md` lines that remain and why, the check results, and what you did not run. Then offer `/brand check`.
