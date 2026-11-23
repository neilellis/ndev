# LLM wiki

[kb](README.md) › llm-wiki

**A project wiki is compiled knowledge: an agent reads the sources once, at ingest, and writes the result into a fixed tree of pages that hold the current state only.** Agents then read the wiki, not the raw sources. The method follows Karpathy's "LLM wiki" pattern. A starter is in [templates/wiki/](../templates/wiki/wiki.md).

## Three layers

| Layer | What it is | Rule |
|---|---|---|
| Raw sources | Code, issues, PRs, documents, transcripts | Link to them. Do not copy them. |
| The wiki | Markdown pages in a nested tree | Current state only. Dense cross-links. |
| The schema | `AGENTS.md` at the wiki root | How to route, write, ingest, query and lint. |

## Sections

The top-level sections are fixed. A new top-level section needs the user's direction.

| Section | What goes there |
|---|---|
| `domain/` | Facts about the problem and the product. |
| `dev/` | Facts about this codebase and how to work on it. |
| `visual/` | The design system and visual rules (optional). |
| `future/` | Plans. A plan graduates out of `future/` into `domain/` or `dev/` when it is built. |

### The routing test

Ask: **would this fact still be true if we rewrote the system in a different language?** Yes: it goes in `domain/`. No: it goes in `dev/`.

## The tree

- Nest pages: `<section>/<area>/<sub-area>/<feature>.md`.
- Every folder has a folder note with the folder's own name (`dev/ci/ci.md`). It lists the pages in that folder.
- Each page starts with a breadcrumb back up the tree.
- Use kebab-case file names.
- Link densely between pages, with relative links.

## The `.log/` folder

- Each section has a `.log/` folder. The dot prefix makes Obsidian ignore it.
- Each ingest writes one new file: `.log/YYYY-MM-DD-<slug>.md`. One file per ingest means two agents never conflict on one log file.
- The file holds one heading and one line:

  ```markdown
  ## [2026-01-15] ingest | retry policy for the export job

  Updated dev/jobs/export.md: retries are now 3 with backoff; removed the old 5-retry note.
  ```

## Operations

### Ingest

1. Route each new fact with the routing test.
2. Update the existing page, or make a new page where none fits.
3. Replace facts that are no longer true. Do not add history ([core belief 11](core-beliefs.md#11-forget-history)).
4. Flag a contradiction between sources. Do not resolve it by guess.
5. Update the folder notes for any page that you added, moved or removed.
6. Add the `.log/` file.

Skip an ingest only for a cosmetic change (a typo, a formatting fix).

### Query

Read the root page, then drill down through the folder notes. Do not search the raw sources first.

### Lint

Find and fix contradictions, broken or stale links, duplicate facts in two places, pages that no folder note lists, and history that crept in.

## What the wiki is not

- Not a changelog. Git holds the history.
- Not a decision record. Design decisions and their rejected options go in [ADRs](adr.md). Amendments to scope and requirements go in [PDRs](pdr.md).
- Not a plan store, except `future/`.
- Not private memory. An agent's personal memory stays outside the repository.
