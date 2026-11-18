---
name: docs
description: "Locate and maintain project documentation, wiki knowledge and human-facing explainers. Also lint prose for readability and render a markdown file as a shareable PDF."
---

# Project documentation

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Use this check when the docs state project goals, rules, or public claims.

The project's knowledge lives in its wiki: a compounding, interlinked, current-state knowledge base that agents keep. The plugin's `kb/llm-wiki.md` holds the method. Start at the project's wiki index file. Read the wiki's `AGENTS.md` (its schema) before you change a wiki file.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Where a fact goes

| Home | Content |
|---|---|
| wiki `domain/` | Facts about the problem and the product. They stay true if the system is rewritten in a different language. |
| wiki `dev/` | Facts about this codebase: implementation, operations and behaviour. |
| wiki `visual/` | The design system, copy and UX rules (optional section). |
| wiki `future/` | Plans not yet built. A plan moves to `domain/` or `dev/` when it ships. |
| ADRs | Significant decisions and the rejected alternatives that are not obvious. |
| glossary (for example `CONTEXT.md`) | One definition for each domain term. |
| `CLAUDE.md` / `AGENTS.md` | Short contributor rules and pointers into the wiki. |
| human docs site | Curated explainers derived from verified wiki pages. |
| deprecated folder | Retired material. Never cite it as current state. |

The routing test: **would this fact still be true if the system were rewritten in a different language?** Yes: `domain/`. No: `dev/`. Do not make a new top-level section without the user's direction.

## Wiki rules

- Nest pages. Each folder has a folder note with the folder's own name (`dev/ci/ci.md`) that lists its pages.
- Each page has a breadcrumb to its parent and is reachable from the index file.
- Link a domain concept to its implementation. Do not copy one into the other.
- A domain page summarises and cites its raw sources.
- Wiki prose describes the present. ADRs keep the reasons for decisions. Git keeps the change history.

After a durable change, do an ingest:

1. Update the relevant pages and their folder notes.
2. Add one new file to the section's `.log/` folder: `.log/YYYY-MM-DD-<slug>.md`. Never append to a shared log file: one file for each ingest means two agents never conflict.
3. Use `forget` for a fact that the change removed or renamed.

## Human docs site

If the project has a human docs site, each page explains its topic to a reader with no project background. A page names the wiki pages it derives from, and links each first use of jargon to a real glossary entry. Check each code-backed claim against the code. Build the site and look at the output for rendering defects.

## Readability lint

`${CLAUDE_PLUGIN_ROOT}/scripts/docs/readability.sh` lints prose against the House vale style in `${CLAUDE_PLUGIN_ROOT}/scripts/docs/vale/`. Run it on a plan, a comment, a wiki page or a docs page before you post or commit it.

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/docs/readability.sh <file> [<file>...]
${CLAUDE_PLUGIN_ROOT}/scripts/docs/readability.sh -            # stdin, as markdown
```

Exit 0 is clean, 1 is errors to fix, and 2 means something was not linted (vale is not installed, a file is missing, or Vale skipped a file whose extension has no section in `.vale.ini`). Exit 2 is never a pass. The rules skip code, link targets and URLs.

The lint is only the mechanical half. A sentence can pass and still say nothing. For important prose, give the text alone to a fresh agent and ask what it could not decode.

`${CLAUDE_PLUGIN_ROOT}/scripts/docs/vale/test.sh` proves the style both ways: every rule must fire on `testdata/bad.md`, and no rule may fire on `testdata/good.md`. Run it after you change a rule.

## PDF

`${CLAUDE_PLUGIN_ROOT}/scripts/docs/md-to-pdf.sh <file.md> [out.pdf]` renders a markdown file to PDF with pandoc and headless Chrome. Set `CHROME` if the script cannot find Chrome or Chromium.

Use `copy` for product interface wording.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
