# meander-data-ribbon

A winding ribbon (river/stream/road) whose **geometry itself encodes a data variable** — the path's
width, not just its milestones, carries the story. Worked example: a charity's fundraising poster,
where stream width = cumulative funds raised, source = first donation, terminus pool = today's
total. Distinct from `winding-roadmap`: there the path is scenery; here removing the data would change
the shape.

## Structure

- One continuous ribbon from a **source** (origin event) to a **terminus** (today), flowing down the page
- Ribbon width at any point = the running value of one variable at that date
- Time flows along the path; dated events sit on the banks at their position
- Clusters (secondary charts, crowds, callouts) hang off the bends asymmetrically — never a card stack
- The terminus is the ribbon itself swelling into a pool/plaza that holds the headline number

## Best For

- Entity profiles with a headline verdict and a time arc (an organisation's track record)
- Cumulative metrics: score history, funds raised, emissions saved, users grown
- Accountability/progress narratives where "how wide is the river today" is the takeaway

## Visual Elements

- Variable-width ribbon with layered texture (inner deep band, braided threads, one animated current)
- Source spring + labelled start ("SINCE 2023 · …"); terminus pool with the headline figure
- Event pictograms (leaves/flags) stemmed to the bank at their date
- Year/milestone markers on alternating banks carrying the running value
- Floating annotation "berries" for notable deltas, leader-lined to the nearest bank
- Scene garnish that never carries data alone: grass tufts, reeds, ripples

## Text Placement

- Title + headline gauge at top, clear of the ribbon's first bend
- Milestone labels on the banks, alternating sides; annotations pushed diagonally off marker label boxes
- Captions stacked in short lines inside known-clear columns (deconflict by construction, not eyeballing)
- Any text that can cross artwork gets a canvas-coloured halo (cartographic `paint-order: stroke`)

## Hard Rules

1. **Honest geometry** — the width curve derives from real dated values; never fake a history to make
   the shape pretty. Pre-window events roll into the source width rather than being dropped.
2. **Every mark is a door** — in interactive builds each element opens its underlying rows; in static
   raster builds each cluster carries its real figure.
3. Colour never travels without a word; the terminus repeats the headline number.
4. **The poster owns the page** — in a product context nothing below the poster repeats its identity
   or headline numbers; a slim seam strip hands over to the working detail.
5. **Disclosure carries the honest charts** — the ribbon is the *felt* version of the data; every
   drill-in (drawer/panel) opens with the *plotted* version: a trend line to a zero baseline for the
   cumulative variable (full unclipped history, endpoint direct-labelled) and stacked category
   columns per period, with worded legends. Never a dual-axis chart.
6. **Timeline clipping carries into the source** — events before a configured start date roll into
   the source's starting width (labelled, and disclosed on click), never silently dropped.
7. **Annotations get halos** — text crossing artwork takes a canvas-coloured knockout
   (`paint-order: stroke`), the cartographic convention.

## Recommended Pairings

- `craft-handmade`: organic banks, hand-drawn garnish
- `storybook-watercolor`: soft washes for the water
- `subway-map`: a schematic variant where width becomes line weight
