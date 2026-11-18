---
name: react-grab
description: "Continuously receive React Grab selections and act on their attached user instructions when a watch loop is requested."
---

# Watch React Grab

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Use this check if a requested edit changes behaviour governed by the project.

Run on the same machine as the browser: the watcher reads that machine's clipboard. Use this skill for a watch loop that the user asked for, not for one pasted selection.

```bash
npx react-grab@latest pull --max-age 0
```

Each output line is one grab as JSON.

- `content` holds component and source references.
- `prompt`, when present, holds the user's task.
- Without a prompt, apply the standing instruction, or report the source location and wait for direction.
- `--max-age 0` keeps grabs that queued while you worked.
- If a grab asks for a new or replaced UI component, read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` and choose it from there.

Between work steps, check for queued input without blocking:

```bash
npx react-grab@latest pull --max-age 0 --wait 0
```

A new instruction steers the active task, unless it says that it replaces it. Process every queued line. Keep long work interruptible. If a pull times out, start it again: the background watcher continues to collect.

When the user stops the loop:

```bash
npx react-grab@latest stop
```

If the installed CLI's flags differ, read its help. Never discard a selection in silence.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
