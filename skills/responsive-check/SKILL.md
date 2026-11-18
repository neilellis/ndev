---
name: responsive-check
description: "Check a website's layout on phones, tablets and desktops, in light and dark mode, and report each defect with its element. Use when the user asks to check a site on mobile, iPad, other widths or dark mode, for a responsive or reflow review, before a public page ships, or after a layout or theme change. Also maintains the breakpoint and layout rules on the project's brand site."
---

# Responsive check

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Use this check if the project sets rules for the layout or behaviour you review.

The check runs a matrix: **routes × viewports × colour schemes**. Each cell loads one route at one viewport in one scheme, in the engine of the real device (WebKit for Apple devices, Chromium for the rest). The probe measures the page and the script reports each defect with a CSS selector.

The ndev pane **Responsive matrix** follows the run live. It opens when the runner starts. `/responsive-matrix` opens it again and shows the newest run.

## 1. Run the matrix

Start the site first (for example `pnpm dev`). Then run the script in this skill's folder:

```bash
WEB_DIR=<web app dir> node <this skill>/scripts/responsive-check.mjs --base http://localhost:3000 / /about /pricing
```

`WEB_DIR` is a folder that installs `playwright` or `@playwright/test`. Each engine that the matrix uses must be downloaded (`npx playwright install chromium webkit`). If it is not, the script exits 2 and names the command.

| Option | Meaning |
|---|---|
| `--base URL` | The site root. Required. |
| `--out DIR` | The output folder. Default `.responsive-check`. Add it to `.gitignore`. |
| `--only "iPhone SE,iPad Mini"` | Run only the viewports with these names. |
| `--widths 360,768,1440` | Add Chromium rows at these widths, named `360px` and so on. With `--only`, name them there too. |
| `--schemes light` | Run one scheme. Default `light,dark`. |
| `--engine chromium` | Run every row in Chromium (when WebKit is not available). Say so in the result. |
| `--target 24` / `--target-warn 44` | The touch target error and warning sizes in px. |
| `--full-page` / `--no-shots` | Full-page screenshots, or none. |

The default viewports are iPhone SE (320), iPhone 15 Pro (393), Pixel 7 (412), iPad Mini (768), iPad Pro 11 landscape (1194), Laptop (1280) and Desktop (1920). The reasons and the extra widths to add are in [references/matrix.md](references/matrix.md).

| Exit | Meaning |
|---|---|
| 0 | No errors. Warnings can be present. |
| 1 | At least one error or one cell that did not load. The output names each cell. |
| 2 | The check could not run. The message names the fix. |

## 2. Read the result

- Read `report.json` in `--out`. Each cell has `measured.width` (the CSS viewport), its findings and its screenshot path.
- **Look at the screenshots** of each cell that has a problem, and of the narrowest phone and one tablet in both schemes. The probe does not see visual defects: a clipped headline, a lost image focus, overlapped text or a broken visual rhythm.
- A note `no dark scheme` means the page has no dark design. The dark cells then show the light design. Report this; it is not a pass for dark mode.
- Each check, its rule and the usual fix are in [references/checks.md](references/checks.md).

## 3. Fix

- Fix the cause in the shared CSS or component, not with a media query for one device.
- If a fix needs a new or replaced component, read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` and choose it from there.
- Use the patterns in [references/checks.md](references/checks.md): `min-width: 0` on flex and grid children, `svh`/`dvh`, `clamp()` type, container queries, safe-area insets, `overflow-x: auto` on a wide table.
- For a redesign of a section, or when a fix needs a layout decision, use OpenDesign. See [references/open-design.md](references/open-design.md).
- Run the matrix again. A fix is done only when the cell is green and its screenshot looks right.

## 4. Keep the brand site up to date

When the project has a brand site (`.neil-dev.json` `branding`), the breakpoints, layout rules, touch target sizes and dark tokens are recorded there. A change to them goes to the brand site in the same PR. Run the matrix on the brand site too. The procedure is in [references/brand-site.md](references/brand-site.md).

## Tools and limits

- This script is the main tool: it sets the real CSS viewport, device pixel ratio, touch and engine.
- The Orca embedded browser is good for a quick look, and it keeps the user's sign-in. `${CLAUDE_PLUGIN_ROOT}/scripts/browser/orca-shot.sh <url> <out.png> --viewport 390x844` sets the CSS viewport, checks it and saves a screenshot. `orca set device` does not change the CSS viewport.
- A browser extension (Claude in Chrome) cannot set the CSS viewport, so it cannot emulate a phone.
- The iOS Simulator (Orca emulator) gives real Safari, but it needs Xcode. Use it for a final Safari check when Xcode is installed.
- Details and traps: [references/tools.md](references/tools.md).

## Report

Give the matrix size, the counts (pass, warn, fail), each error with its cell and selector, and the screenshots that you looked at. Say what did not run (for example: no WebKit, no Simulator, one scheme only).

## The workflow

A check that is part of the smoke stage goes to `mcp__ndev__finishedSmoke(report)`, and the report names the HEAD commit. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
