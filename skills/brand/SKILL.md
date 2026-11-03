---
name: brand
description: "Make, check or re-apply a project's brand. /brand create makes a full brand guide and design system site (tokens, components, voice, banned words, accessibility, motion, film) from the project and plugin defaults, in apps/brand or as a standalone app. /brand check reports where the project breaks its brand. /brand apply does the check and fixes what it finds. Use when the user types /brand, or asks to create a brand site, check branding or apply the brand."
argument-hint: "create | check | apply [path or note]"
---

# Brand

The arguments are: $ARGUMENTS

Take the first word as the action. If it is not `create`, `check` or `apply`, ask which one, in one question, and stop.

## Where the brand is

`.neil-dev.json` in the project root holds the brand in `branding`:

```json
{ "branding": { "site": "https://brand.acme.example", "name": "Acme Widgets", "path": "apps/brand" } }
```

- `site`: the URL of the brand site. `guide`: a page of it for writers, if there is one.
- `path`: the brand site's source folder, relative to the project root. `check` and `apply` need it.
- If `branding.site` is set but `branding.path` is not, ask for the folder in one question. If the brand site is not on this computer, say that `check` needs a local copy, and give the `git clone` command for it.

## The actions

| Action | Read and follow | Result |
|---|---|---|
| `create` | [references/create.md](references/create.md) | A brand site that builds, with every default replaced or listed in its `BRAND-TODO.md`, and `branding` set in `.neil-dev.json` |
| `check` | [references/check.md](references/check.md), "Check" | A report of where the project breaks its brand. Nothing is changed |
| `apply` | [references/check.md](references/check.md), "Apply" | The project changed to match its brand, and the check run again |

## Scripts

`S=${CLAUDE_PLUGIN_ROOT}/skills/brand/scripts`. Both scripts need Node 24 or later.

```bash
node $S/scaffold.mjs --target <new folder> --config <brand.json>              # makes the site from templates/brand-site; a failure writes nothing
node $S/audit.mjs --brand <brand folder> [--register marketing] [--json] <project>   # exit 0 clean, 1 errors, 2 nothing checked or a crash
node $S/audit.mjs --brand <brand folder> --fix <project>                        # also replaces token colours in .css files
```

The template is `${CLAUDE_PLUGIN_ROOT}/templates/brand-site`. Its defaults come from a real brand guide. `create` replaces them with the project's own values.

## UI component foundation

For React projects, use shadcn/ui as the default source of owned UI primitives. Preserve its accessible interactions and basic component conventions, then map colour, typography, spacing and radii to the project brand. Apply the same foundation to public forms, admin and interview/workflow tools. Custom cinematic scenes and brand illustrations remain custom. Respect an existing Base UI or Radix choice and verify focus, keyboard operation, validation and saved state when replacing controls. For motion-rich patterns that shadcn/ui does not have, [Kokonut UI](https://kokonutui.com/) components install through the same registry. Map their colours to the brand tokens and follow `ux-principles` (`references/kokonut-ui.md`).
For React projects, use shadcn/ui as the default source of owned UI primitives. Preserve its accessible interactions and basic component conventions, then map colour, typography, spacing and radii to the project brand. Apply the same foundation to public forms, admin and interview/workflow tools. Custom cinematic scenes and brand illustrations remain custom. Respect an existing Base UI or Radix choice and verify focus, keyboard operation, validation and saved state when replacing controls. Read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md`, choose each component from it, and map it to the brand tokens with the uniformity rules on that page.

## The workflow

To find one call on a font, colour or similar, call `mcp__ndev__iNeedA('brand-style', description)`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
