---
name: wiki-lint
description: "Verify wiki structure, source citations and behavioural claims against the current repository, then repair documented drift."
---

# Verify the wiki

The project's wiki is a compounding, interlinked, current-state knowledge base that agents keep. The plugin's `kb/llm-wiki.md` holds the method. Read the wiki's `AGENTS.md` (its schema) and its index file first.

Honour the requested page, area or section. With no scope, choose dev pages that are likely to drift, from recent code changes and earlier lint logs. State the selection.

## Steps

1. **Structure.** Check the folder notes, parent and child links, reachability from the index file, relative links and each section's `.log/` folder.
2. **Citations.** Extract the code paths, tables, migrations, commands and configuration that pages claim. Check each against the real files, catalogues or command definitions. A cited file name alone does not prove behaviour. Read-only help and focused tests are useful. Never run a mutating command only because a page cites it.
3. **Behaviour.** Read the cited implementation to test each behavioural claim. For domain, visual and future pages, check links and structure. A claim about the world needs external evidence, not an inference from code.
4. **Classify** each finding:

   | Code | Meaning |
   |---|---|
   | `BROKEN-PATH` | A cited path does not exist |
   | `STALE-CLAIM` | The page says something the code no longer does |
   | `CONTRADICTION` | Two pages, or a page and the code, disagree |
   | `ORPHAN` | No folder note lists the page |
   | `MISSING-FOLDER-NOTE` | A folder has no folder note |
   | `UNVERIFIABLE` | No source can confirm or refute the claim |

5. **Fix proven drift.** If a page states an invariant that the code breaks, report a possible regression. Do not rewrite the invariant to match the code.
6. **Retired facts.** Use `forget` when a retired fact has other copies.
7. **Log.** Add one new dated file to each affected section's `.log/` folder with the scope, pages checked, findings and outcome. If an earlier lint called a page clean and this lint found a defect there, record the miss in the section's calibration log.
8. **Report** findings, fixes and unverified claims, with their scope. If the project has a human docs site that derives from the wiki, run its tests. Its parity checks cover links, not wiki truth.

Leave edits for the caller's branch and pull-request workflow. An audit does not commit.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
