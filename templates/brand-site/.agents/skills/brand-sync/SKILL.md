---
name: brand-sync
description: Bring the brand guide back in line with the {{name}} website or film after either one changes.
---

# Keep the guide in step with its sources

The website (`{{sourceRepo}}`) and the film (`{{filmSource}}`) are the sources of truth. Read them; never write to them. When the guide and a source disagree, change the guide.

## Find what changed

Compare the source's `main` against the values in this repository. Clone a source or read it with an authorised GitHub tool. Look at the source's recent commits first: they usually name the change.

| Source file | Guide files that depend on it |
| --- | --- |
| The website's stylesheets, Tailwind theme or token files | `public/ds/tokens/*.css`, `public/ds/components.css`, Colour, Typography, Layout, Depth & motion, Components, Page sections |
| The website's logo component or SVG | `app/components/Wordmark.tsx`, `public/ds/assets/mark.svg`, Logo |
| The website's content files and page copy | Voice examples, Components and Page sections demos |
| The website's `public/` images and client logos | `public/ds/assets/` |
| The film's page or scene markup, if the project has a film | `gradients.css`, film tokens in `colors.css` and `elevation.css`, Video: Scenes, Captions, Motion |
| The film's script, timeline and rendered stills | Video: Structure, Narration, Motion, `public/ds/assets/video/` |
| The film's photos and their credits | `public/ds/assets/photos/`, Photography, Footage, `THIRD_PARTY_NOTICES.md` |

The Governance page lists the exact source files. Keep this table and that page in step.

Keep this table and the source table on the Governance page (`app/governance/page.mdx`) in step.

## Update the guide

1. Change tokens first, then components, then the pages that describe them. Follow `design-tokens` and `guide-pages`.
2. Copy values exactly. Keep a source's names where it has them, and note the source file in a CSS comment when a value is not obvious.
3. Resize film stills to 1280px wide JPEGs before adding them. Follow `brand-assets` for photos and credits.
4. Search the pages for the old value and the old wording (`grep -rn`) so no page keeps a stale number, colour or quote.
5. Run the checks, then compare the changed pages in the browser with the source: the website at https://{{domain}}, or the film's stills.

In the pull request, list each source change and the guide change that answers it. Say plainly if a source change was left out and why.
