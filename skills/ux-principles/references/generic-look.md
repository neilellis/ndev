# Generic look

A generated or template screen fails in the same ways: glows on every surface, emoji as labels, spacing with no rhythm, and copy with hype and exclamation marks. Use this page to find and remove those signs. Keep the features, the content and the order of sections. The project's brand guide wins where it differs from this page.

## The principle

Keep the chrome quiet: navigation, buttons, borders and labels use the neutrals and one accent. Put the colour and the detail into one or two content moments, for example the main chart, a product preview or a real object that the product deals with. A screen where everything is highlighted has no place for the eye to go.

## Decide how much to change

1. List each sign below that you find, with the file and line.
2. If you find many signs across colour, type, icons and copy, fix every area, one area at a time across the whole screen. Do spacing first, and copy before type, because the length of a headline sets its size.
3. If the screen is mostly designed and has a few signs, fix only those. Keep the palette, type and layout. Put bigger ideas in the report as suggestions.
4. If you find no signs, say so, and give at most three refinements with exact values. Do not change a good screen only to make it different.

## Signs and fixes

| Area | Sign | Fix |
|---|---|---|
| Surfaces | Hue-to-hue gradients (violet to blue) on backgrounds, cards or buttons; colour washes or blurred blobs behind content | One neutral surface. A gradient is only a small tone shift in one neutral |
| Surfaces | Coloured glows, coloured shadows, neon borders, glass cards | Depth from surface steps and hairlines in the border token. On dark themes, no shadow except on an element that floats |
| Colour | Five near-identical tints for text; the accent on every element | Three text roles from the project tokens: foreground, muted and one step between them. The accent marks the primary action, the selection or the one figure that matters |
| Type | Gradient text; headings at weight 700–900 | Solid text. Hierarchy from size and colour, with weights 400 and 500 (600 for rare emphasis) |
| Type | Uppercase labels with wide tracking (`PAID THIS MONTH`) | Sentence case. No negative tracking on text under 16 px |
| Icons | Emoji as icons or label decoration; a sparkle for anything AI | One icon set ([ui-components](../../../kb/ui-components.md#uniformity-rules)), or no icon |
| Spacing | Rows of one list with different heights; a group closer to its neighbour than to its own items | One height and one gap for equal items. The gap inside a group is smaller than the gap between groups. A section label sits nearer its own items than the section above |
| Components | Glowing pills for counts, plans and shortcuts; `PRO`, `New`, `Beta` badges everywhere; every element a pill | Counts and meta as muted text, and a badge only where the product needs it. Radius by size, with nested radii ([ui-components](../../../kb/ui-components.md#uniformity-rules)) |
| Charts | Rainbow bars in one series; the same chart repeated in equal cards; sparklines in every stat card | One accent per chart on the value that matters, and neutral steps for the rest. One main chart; other data is smaller and of another kind (a ranked list, a short table) |
| Charts | A chart type that does not fit the data | A trend is a line, a comparison is bars, one goal is a progress bar. A share is one stacked bar, a list with bars, or a pie with two or three parts |
| Layout | Equal cards side by side, each with the same content | Vary the widths, for example three compact stats above one wide chart |
| Hero | A pill badge above the headline; everything centred and stacked; three or more buttons | One primary action and at most one secondary. "Log in" is a text link. Left-align a headline of more than two lines. Use a split or a large product view below the text |
| Visuals | Glossy blobs, orbs, robots, glowing brains; text or fake buttons in an image; a visual on every section | A preview of the product, built in code with plausible data, that shows what the headline promises. One visual where it helps. The image background is the page colour, or its edges fade into the page with a mask |
| Motion | A pulse, ping or shimmer on something that is not live or loading; `hover:scale` on cards; floating elements or parallax | Static, except the one Shimmer CTA that [ui-components](../../../kb/ui-components.md) allows in a marketing hero. A hover is a colour or surface change ([motion](../../motion/SKILL.md)) |
| Copy | Greeting headlines, exclamation marks, hype words, unsourced claims | The [copy](../../copy/SKILL.md) rules |

## The template test

Swap the product name for a competitor's. If the screen still fits, it is a template. Make the headline use this product's own nouns. Give the main visual a subject from the product's world, and use one small detail that only this product has, for example a live status dot in a monitoring tool.

If the project has no brand, write five lines before you change the palette, and confirm them with the user:

1. **Product**: what it does and for whom, in one sentence.
2. **Character**: two or three concrete words. Do not use clean, modern, sleek, minimal or premium, because they fit every template.
3. **World**: the place or material where the product belongs. It sets the tint of the neutrals and the accent.
4. **Moments**: the one or two places that get rich colour and detail.
5. **Signature**: the one detail that only this product has.

Adapted from [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: condensed into a reference table and five-line brief aligned with `ndev` copy and design rules.
