---
name: requirements-deprecate
description: "Deprecate a requirement record that is obsolete or that a newer record replaces, and point its traces at the new record. Use when the user says deprecate, retire or supersede a requirement, REQ-NNNN is obsolete, or a requirement must change its title, author or origin."
---

# Deprecate a record

The records, their format and their rules are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md` (read "Deprecation"). Read it first.

A human decides each deprecation. An agent never deprecates a record on its own decision.

| Command | What it does |
|---|---|
| `ndev requirements deprecate <REQ-NNNN> --reason "<why>" --decided-by "<name>" [--by <REQ-NNNN>]` | Moves the record to `docs/formal/deprecated/` with `git mv`. Sets `status: Retired`, or `Superseded by NNNN` with `--by`. Writes the name in `decided_by`, adds a Log entry with the reason, and writes `superseded_by` and `supersedes`. |

## Procedure

1. Show the human the record: its ID, its title, its Statement and its Trace. Ask whether to deprecate it, and why. Stop if the human does not agree.
2. When a newer requirement replaces it, search for that record with `ndev requirements search <words>`. If none exists, create it as `Proposed` with `ndev requirements new "<title>" --author "<name>" --type <type>`. Its Statement and its Source text are a first creation, so you can write them.
3. Run the command with the human's name and reason. Give `--by <REQ-NNNN>` only for a replacement.
4. In each issue and pull request whose body cites the old record, cite the new record. `ndev requirements for <REQ link or path>` lists them. Move the `- File:` lines that still apply to the new record with `ndev requirements file`.
5. Run `ndev requirements check`, `ndev requirements guard --base <the target branch>` and `ndev requirements links --base <the target branch>`. Correct each failure.
6. Commit the move and the changed records together.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
