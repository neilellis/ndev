---
name: deadcode
description: "Find unused Python and TypeScript names introduced by the current branch."
---

# Branch dead-code sweep

Run the sweep for each language that the branch changes. The scripts are in this skill's `scripts/` folder:

```bash
scripts/sweep.sh [--base REF] ROOT [ROOT...]   # Python, with the `deadcode` tool through uv
scripts/sweep-ts.sh [base-ref]                 # TypeScript, with knip and the root knip.json
```

Both scripts scan HEAD and the merge base in a temporary worktree, and report only the findings that the branch added. The default base is `origin/HEAD`, else `origin/main`.

| Exit | Meaning |
|---|---|
| 0 | The branch added no finding. The script prints both counts as evidence. |
| 1 | The branch added findings. Triage each line. |
| 2 | The scan did not measure. Never a pass. The script prints the tool's error, its status and the repair. |

## Choose the Python roots

Give every Python source root together: application `src` folders, scripts, packages and evaluation code. A consumer outside the roots can hide a live use, so read the imports before you narrow the list. The project's CLAUDE.md can name its roots.

## A count is evidence only with its command

To count raw findings, keep `--no-color`:

```bash
uv run --with deadcode deadcode --no-color <roots> | grep -cE ': DC[0-9]'
```

Without `--no-color`, the tool writes colour codes between the `:` and the `DC`. The grep then matches nothing and prints 0. A zero from a pattern that did not match reads the same as a clean repository. Put the command and the count in the pull-request body. The exit code of the sweep is not the evidence.

On a deletion branch, also run the raw tool at the base and at the head over all touched roots, and record both counts.

## Triage each finding

Read the imports, calls, attributes, strings, decorators, registries and configuration for each name. These are usual false positives:

- re-exports and side-effect imports
- registration by decorator or by string (CLI and web frameworks)
- dynamic dispatch, hooks and plugin entry points
- model, enum and protocol members

## Delete a true positive

1. Classify each test and guard that mentions it. Never delete a test only to silence the tool.
2. Remove the name and anything that only it used. Update callers and configuration.
3. Run the affected type checker and tests.
4. Run `forget` for documentation that still names it.

Suppress a finding only narrowly, and write down the dynamic mechanism that makes it live. Report the commands, counts, classifications, deletions and verification in the pull-request body.

## The workflow

The plugin runs the sweep when the review stage starts, and its result is in the answer of `mcp__ndev__finishedDevelopment`. Triage each finding, and give the triage to `mcp__ndev__finishedReview` as `deadcode`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
