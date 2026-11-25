# Wiki schema

[wiki](wiki.md) › AGENTS

**This file tells an agent how to route, write, ingest, query and lint this wiki.** The method is the plugin's `kb/llm-wiki.md`.

## Layers

1. **Raw sources:** code, issues, PRs, documents. Link to them. Do not copy them.
2. **The wiki:** the pages under this folder. Current state only.
3. **The schema:** this file.

## Sections

The top-level sections are fixed: `domain/`, `dev/`, `future/` (and `visual/` if the project has a design system). A new top-level section needs the user's direction.

**Routing test:** would this fact still be true if we rewrote the system in a different language? Yes: `domain/`. No: `dev/`. A plan that is not built yet: `future/`.

## Page rules

- Path: `<section>/<area>/<sub-area>/<feature>.md`. Kebab-case names.
- Every folder has a folder note with the folder's name (`dev/ci/ci.md`) that lists its pages.
- Each page starts with a breadcrumb: `[wiki](../wiki.md) › [dev](dev.md) › <page>`.
- The first sentence states the main fact, in bold.
- Link densely, with relative links.
- Current state only. No "previously", no change history. Git holds the past.
- Write in ASD-STE100 Simple English, with British spelling.

## Ingest

1. Route each new fact with the routing test.
2. Update the existing page, or make a new page where none fits.
3. Replace facts that are no longer true.
4. Flag a contradiction between sources on the page, as a question for the user. Do not guess.
5. Update the folder notes for any page added, moved or removed.
6. Add one file to the section's `.log/` folder: `.log/YYYY-MM-DD-<slug>.md`, holding `## [YYYY-MM-DD] ingest | <topic>` and one line that says what changed.

Skip the ingest only for a cosmetic change.

## Query

Read [wiki.md](wiki.md), then drill down through the folder notes. Go to the raw sources only when the wiki does not answer.

## Lint

Find and fix: contradictions, broken or stale links, one fact in two places, pages that no folder note lists, and history.

## What does not go here

- A changelog (Git holds it).
- Decisions and rejected options (design decisions go in ADRs under `<docs/adr/>`, requirement amendments in PDRs under `<docs/pdr/>`).
- Plans, except under `future/`.
- An agent's private memory.
