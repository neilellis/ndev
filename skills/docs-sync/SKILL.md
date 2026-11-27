---
name: docs-sync
description: "Bring user-facing docs pages back in line with code or wiki changes, using a docs map in page front matter. Use when a hook or check prints docs-map suggestions, or after changing code or the wiki that docs pages describe."
---

# docs-sync: keep the docs site true to the code

Before you write or review documentation, read the project's writing rules if `CLAUDE.md` or `AGENTS.md` names them.

## The workflow

This skill is part of the remember hook, which fires at `mcp__ndev__finishedDevelopment`. Commit with `mcp__ndev__checkpoint`, and give the result to `mcp__ndev__finishedReview` as `remembered`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## The docs map

Each docs page lists the repository files it documents in YAML front matter. By default the keys are `source` (code, configuration) and `wiki` (internal notes). A listed directory covers every file below it.

```yaml
---
title: Install
source:
  - src/cli/install.ts
  - deploy/
wiki:
  - docs/wiki/install.md
---
```

The page **follows the code**: when the page and the code disagree, the code is right.

If the project has its own docs-map tool, hook or test command (see `CLAUDE.md` or the docs package scripts), use it. If not, use `scripts/docs_map.py` in this skill's folder. It needs only Python 3.9 and git.

```bash
python3 <skill>/scripts/docs_map.py suggest --content <docs-content-dir> --range <base>..HEAD [--keys source,wiki] [--ignore 'tests/*']
python3 <skill>/scripts/docs_map.py check   --content <docs-content-dir>
```

## Inputs

- The docs content directory (for example `docs/`, `apps/docs/content/`). Find it in `CLAUDE.md` or ask.
- The base: `main` or the upstream branch of the current branch.
- The project's page contract (voice, naming rules), if it has one.

## Branding

If `<project root>/.ndev.json` has a `branding` key, read `branding.guide` (or `branding.site` when there is no guide) before any design change to the docs site, and match it. Find the root with `git rev-parse --show-toplevel`. Otherwise skip this section.

## Steps

1. **Get the list.** Use the hook's output if you have it. If not, run `suggest`.
   *Done when* you have three lists: pages to review, changed files that no page cites, and deleted files that pages cite.
2. **Review each listed page against its diff.** Run `git diff <base>..HEAD -- <changed file>`, read the page, and find every sentence, table row, name, default, route, flag or count that the diff makes wrong. Correct those, and only those. Read the page contract before you write.
   *Done when* each page on the list is edited or confirmed still true, and you can name the diff hunk behind each decision. A page with a wiki match changes only if the wiki change alters a fact that the page states.
3. **Repair the map.** If a cited file moved, change its path in the front matter of each page. If a cited file was deleted, remove its path. If the page content went with that file, move or remove that content too. For each changed file that no page cites, choose one:
   - It changes behaviour that a page describes. Add the file to the `source` list of that page.
   - It adds something that users or operators see and no page covers. Write a page by the contract, with its front matter, and add it to the site navigation.
   - It is internal, with no effect that a reader sees. Leave it out of the map.

   *Done when* every file on the no-page list fits one of these three cases.
4. **Rebuild and check.** Run the project's docs-map build and docs tests, if it has them. Then run `check`. *Done when* all pass. Zero pages found is a failure, not a pass.
5. **Review dependent media.** If videos, screenshots or diagrams show a changed page, check that they are still accurate. For screenshots, follow `${CLAUDE_PLUGIN_ROOT}/kb/docs-screenshots.md`: run the project's refresh and freshness commands. With `docs-screenshots.json`, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/docs/screenshots.mjs refresh docs-screenshots.json`, then the same command with `check`. Add missing source inputs or published copies to the manifest, and inspect the resulting images in the rendered page. Metadata-only edits need no new media when the explanation and visuals stay accurate.
6. **Record durable facts.** Record a doc and code disagreement that you found and could not resolve in the page in the place the project names (for example a "docs-site" wiki page). Commit the page and front-matter edits. Pages you confirmed still true appear in the list again on the next run. That is expected.

## Metadata merges

When two branches change the front matter, merge the `source` and `wiki` lists against the resolved files. Keep prose that is still true to the current code. Read the body hunks; a branch is not correct because it is newer. Rebuild any generated index from the final front matter, not from a stale copy.

A comparison of page bodies can show a metadata-only migration. Exclude only the front matter and identified map comments, and review the remaining differences. It does not replace reading changed claims or reviewing dependent media.

If someone runs gates on a frozen snapshot, finish your edits first. While the snapshot is being checked, pause writes. Results for an earlier snapshot do not validate later changes.
