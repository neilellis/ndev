---
name: doc-coverage
description: "Audit gaps in project documentation by concept and audience, and refresh the project's documentation coverage report."
---

# Documentation coverage

Take the report path from the arguments, else from the project's CLAUDE.md. A usual place is `docs/analysis/doc-coverage.md`. If no report exists, make one with the sections below.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Build the inventory

1. Read the existing report. Find the concepts that changed since its last run, from code and docs history.
2. Carry each unchanged verdict forward, with an explicit note that you did not check it again.
3. Derive the inventory from the current system: CLI commands, pipeline stages, jobs, web features and published metrics. Do not assume an old inventory is still complete.

## Judge each cell

For each concept, judge WHAT (reference), WHY (explanation) and HOW (procedure), for each audience: developers, operators and domain readers.

A title or a passing mention is not coverage. Open the page and check that the reader can understand it and take the next step. Trace each documented command or setting to code, or run a safe check. A procedure that does nothing in silence is Thin.

| Verdict | Evidence |
|---|---|
| Clear | A correct model and a usable next step, with the page and section |
| Thin | A partial explanation, the wrong audience, a missing link or a broken procedure |
| Missing | No relevant page |
| N/A | A stated reason why this audience does not need it |

The `docs` skill gives the home for each kind of fact.

## Refresh the report

Update the matrix, the ranked gaps, the dated changes and the calibration section.

- Put the weakest areas first, especially published metrics with no domain explanation.
- Rank a missing explanation above misplaced content, and both above discoverability polish.
- Record each time that an earlier Clear verdict proved wrong. That calibration shows how far to trust this audit.

Fix verified documentation gaps inside the requested scope. Report missing code as missing code. Use `wiki-lint` for suspect claims and `forget` for retired concepts. If the project keeps a corrections ledger, check it when a published claim was wrong. Follow the wiki's ingest rules for wiki edits.
