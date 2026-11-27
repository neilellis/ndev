---
name: design-tokens
description: Add, rename or change a design token or component class in the {{name}} design system.
---

# Tokens and components

The design system in `public/ds/` is used by other projects through `/ds/styles.css`. Treat every token and class name as a public interface.

## Tokens

- Tokens are CSS custom properties on `:root` in `public/ds/tokens/`: `colors.css`, `gradients.css`, `typography.css`, `spacing.css`, `elevation.css` and `fonts.css`.
- Put a raw value in a scale (`--navy-800`, `--space-5`), then give it a semantic alias for use (`--text-heading`, `--surface-inverse`). Components use the semantic alias.
- Each colour alias has a light and a dark value. Set it in all three blocks of `colors.css`: the light value in `:root`, the dark value under `@media (prefers-color-scheme: dark)`, and `light-dark(light, dark)` under `@supports`. The tests fail when the blocks disagree.
- Font sizes are in `rem`, not `px`. A fluid size is a `clamp()` with `rem` bounds and a `rem` term in its middle value, and a maximum no more than 2.5 times its minimum.
- `lib/tokens.ts` reads these files to build the Tokens page. A token's kind comes from its file, with exceptions in `kindOf` for radius, motion and `--caption-plate`. Add a `kindOf` rule and a test in `lib/tokens.test.ts` when a new token lands in the wrong group.
- Renaming or removing a token breaks projects that use it. Keep the old name as an alias, mark it deprecated in a comment and in the pull request, and remove it only when the user agrees.

## Components

- Component classes live in `public/ds/components.css`. Keep class names and markup the same as `{{sourceRepo}}`, so markup moves between the website and the guide unchanged.
- Use tokens, not raw values, unless the source uses a one-off value. The structure test fails on any `var(--…)` that is not defined.
- Element resets inside `.ds` use `:where()` so they never outrank a component class. Keep it that way.
- Give every component a navy variant under `.on-inverse` when it can appear on a dark band.

## Show and check it

1. Add or update the live demo on Components or Page sections with `<Demo>`, and the specimen on the matching Foundations page.
2. For any new text and background colour pair, add a row to `PAIRS` in `lib/colors.ts`, with token names. The Accessibility page rates it in both schemes, and `npm test` fails when body text is below AA (4.5:1) in either.
3. Run `scripts/precheck.sh`. Check the demo in the browser on light and navy backgrounds, in light and dark mode, and at 390px wide.
