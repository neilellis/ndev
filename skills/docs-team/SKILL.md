---
name: docs-team
description: "Coordinate a hierarchy of agents (coordinator, unit leads, module writers, a diagram pass and fresh evaluators) that writes and audits a user-facing documentation site from the codebase and its internal docs. Use when generating, extending or auditing a whole documentation site, or a large section of one."
---

# docs-team: a team workflow for a documentation site

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Give each lead the applicable section names when the site explains project goals or rules.

A repeatable workflow that writes a documentation site from the code and the project's internal docs, then audits it with agents that did not write it. Use `docs` for one page; use this skill when the work spans many units.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Files

This skill holds the method:

- `contract.md`: the writer contract (truth, naming, boundary, voice, page shape, diagrams, ledger). **Every agent reads it in full before writing.** The coordinator fills its project section first.
- `briefs/lead.md`, `briefs/writer.md`, `briefs/diagrams.md`, `briefs/eval.md`: the prompts for each role. Fill each `{{…}}` value before you dispatch.

The project holds the state, in a work folder the coordinator chooses (by default `.docs-team/` at the project root, `git rev-parse --show-toplevel`):

- `units.json`: the hierarchy. Each **deployed unit** splits into **architectural units**, and each of those into **modules** (files or folders). Docs-derived **sections** sit beside them. Each entry has `id`, `title`, `content_dir`, `sources` and `brief`, and units have `architectural_units[]` with `id`, `title` and `modules[]`.
- `contract.md`: a copy of this skill's contract, with the project section filled in.
- `ledger/<id>.md`: one for each lead. It records pages, diagram requests, gaps and doc-to-code disagreements.

Ask the user whether to commit the work folder or keep it out of git. Delete it when the user says the site is done.

## Roles and models

| Tier | Model | Owns |
|---|---|---|
| Coordinator | the main session | the site shell, the top navigation and indexes, `units.json`, dispatch, merge, build, final sign-off |
| Unit or section lead | a mid-size model (for example Sonnet) | one entry of `units.json`: a plan, the unit overview page, dispatching writers, reviewing their pages against the code, the ledger |
| Module writer | a small model (for example Haiku) | one architectural unit, or one page set, inside the lead's `content_dir` |
| Diagram pass | a mid-size model | turns the ledgers' diagram requests into figures with `diagram-design` or `archify`, then embeds them |
| Evaluators (fresh) | mid-size and small models | gap audit, code-match audit, integrity pass, readability pass. Separate passes, never collapsed |

## Phases

1. **Shell** (coordinator): the site builds, the theme is set, the `content/` sections exist and the tests run. Write `units.json` from a walk of the codebase and the internal docs. Fill the contract's project section from the project's instructions.
2. **Write** (in parallel):
   - Dispatch one lead for each `units.json` entry, with `briefs/lead.md`.
   - The lead reads the contract and its sources, writes the unit overview page and the section's navigation file.
   - The lead then dispatches one writer for each architectural unit, with `briefs/writer.md`.
   - If the lead cannot spawn agents, it writes the pages itself and says so in the ledger.
   - The lead reviews every writer page against the code and fixes it, runs the site's tests, and finishes the ledger.
3. **Diagrams:** one pass over all the ledgers' *Diagram requests*, with `briefs/diagrams.md`. Keep diagram sources in the docs project (for example `diagrams/<slug>.html` or `diagrams/<slug>.<type>.json`) and embed them with the project's own embed scripts.
4. **Evaluate** with *fresh* agents that did not write, with `briefs/eval.md`, one pass each:
   - **gaps:** every module in `units.json` and every guide or manual topic has a home;
   - **code-match:** sample each page's concrete claims and check them against the code;
   - **integrity:** the project's invariants (its naming, boundary and status rules in the contract);
   - **readability:** jargon, first-use expansions and voice, for the readers the contract names.

   Each writes `ledger/eval-<pass>.md` with findings as `page · claim · evidence · fix`. The coordinator applies the fixes, or dispatches them.
5. **Verify** (coordinator):
   - The site's build and tests, and headless-browser screenshots of representative pages in light and dark.
   - `docs-legibility` over the changed pages, and `doc-coverage` if the project uses it.
   - Record the site's structure in the project's developer docs or wiki, if it keeps one.

## Branding

If `.neil-dev.json` at the project root has `branding`, read `branding.guide` (or else `branding.site`) before any design change to the site (colour, type, spacing, layout, components, theme or figure styling). Its tokens are the source of truth: where the guide and the site's code differ, follow the guide and update the tokens. Give the same instruction to the diagram pass. Otherwise skip this section.

## Rules

- The code is canon. A page claim that no agent checked against a file is not done.
- Each agent touches only its own `content_dir` and its own ledger file.
- Evaluators never rewrite pages. They report, and the coordinator fixes.
- Report each phase's result as passed, failed or not run, with the reason.
