---
name: brand-assets
description: Add, replace or credit images, logos, fonts and film stills in the {{name}} design system.
---

# Brand assets

All assets live in `public/ds/assets/` and are served at `/ds/assets/`. The structure test fails if a page or stylesheet references a missing file.

| Folder | Contents | Source |
| --- | --- | --- |
| `fonts/` | Source Sans 3 and Source Serif 4, with their OFL licences | Adobe |
| `clients/` | Client logos | the website's `public/` |
| `imagery/` | Product screenshots, diagrams, author photos | the website's `public/` |
| `video/` | Film stills `scene-0.jpg` to `scene-8.jpg` | the film's rendered stills |
| `photos/` | Photography, named `u-<Unsplash id>.jpg` | the film's photos |
| `mark.svg` | The mark | the website's `public/` |

## Rules

- Take assets from the sources. Do not add new photography that the website or film does not use unless the user asks. Then choose it by the Photography page: real UK places and modern workplaces in calm light, no robots, glowing brains or staged handshakes.
- Keep files small. Resize stills and photos to at most 1280px wide JPEGs. Keep logos as SVG where the source has SVG.
- Do not add images that show private client material, real people who have not agreed, or anything not already public.

## Credits

Every photo needs a recorded photographer. When you add or remove one, update all three places:

1. The image caption on the Photography page and the credits table on the Footage page.
2. The photography line in `THIRD_PARTY_NOTICES.md`, with the photographer's name and the Unsplash id.
3. The file itself in `public/ds/assets/photos/`.

Search for the file name before deleting an asset, so no page is left pointing at it.
