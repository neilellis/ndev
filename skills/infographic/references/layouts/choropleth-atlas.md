# choropleth-atlas

An atlas plate for a **population of entities on real geography** — a map whose shapes are tinted by
a data variable, with the margin doing the work of a stat rail. Worked example: a national atlas of
school districts tinted by attendance band, individual schools inside them as pins, a magnified inset
for the dense capital region, and KPIs and legend in the margin.
Distinct from `isometric-map`: there space is illustrative scenery; here the shapes are real
boundaries and the tint IS the data.

## Structure

- One map plate dominates; a serif **cartouche** (title + micro-caps subtitle + rule) sits in
  genuinely empty water/margin — never over land
- Shapes tinted by a banded data scale; **every band worded in a legend** (colour never travels alone)
- Entities that don't own a shape at the base granularity become **pins** placed by projection from
  real coordinates — a pin claims a point, never the containing shape
- A dense unreadable region (capital-city cluster) gets a **magnified inset** in empty canvas, with a
  locator rectangle + leader line on the main map and an "ENLARGED ×N" caption
- The margin is a **stat rail**: headline counts (big number + micro-caps), the band legend,
  per-region summaries with their n, and an explicit "also tracked, not mapped" list
- Untracked/absent shapes render faint and inert — coverage is honest, never implied

## Best For

- Accountability/coverage stories over administrative geography (districts, counties, regions, states)
- Comparison surfaces where "where is this happening?" is the first question
- Any banded score over real boundaries where partial coverage must be honest

## Hard Rules

1. **Multi-tier honesty** — when entities nest (region / district / site), tint only the shape an
   entity truly owns; nested entities are pins. Never let one tint speak for two tiers.
2. **Computed placement** — pins from lat/lng through a fitted projection; inset geometry from union
   bounding boxes; pin labels deconflicted by a greedy slot search (cardinals then diagonals). Never
   eyeballed.
3. **Honest coverage** — faint ≠ zero: untracked shapes are visibly "not tracked yet"; entities with
   no shape go to a worded "not mapped" list; unknown entities degrade to that list, never vanish
   (a degrade-don't-drop fallback often surfaces entities the data tracks that the boundary file
   lacks). Key the shape lookup by a *stable* attribute (name), not a per-database id.
4. **Every mark is a door** (interactive builds) — shapes and pins deep-link and/or open the data
   drawer; the working list below stays fully functional as the deepest tier of one disclosure
   gradient (glance → scroll → detail). The map must make detail faster to reach, never slower. On a
   comparison surface the door is usually the entity's own page (a plain deep link + hover popover),
   not an intermediate drawer.
5. The banded scale reuses the product's existing score colours and thresholds — the map and the
   table it summarises can never disagree.
6. **Small-n honesty** — per-region aggregates always show their n, and a mean over a handful of
   entities is never presented as equal in weight to a mean over hundreds.

## Text Placement

- Cartouche in open water, top corner; legend and stats in the margin rail, not on the map
- Pin labels beside their dot with a canvas-coloured halo (`paint-order: stroke`); leader lines only
  when displaced
- Inset caption above its frame in micro-caps

## Recommended Pairings

- `aged-academia`: parchment sea, hairline coastlines — the classic atlas feel
- `craft-handmade`: softened boundaries, hand-set cartouche
- `technical-schematic`: survey-plate variant with graticule ticks
