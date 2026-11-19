---
name: clean-reader
description: "Review supplied documentation or video narration as a first-time reader, in a fresh Codex process that cannot read the application source. Use for unclear next actions, distracting detail and unsupported documentation claims."
---

# Clean reader

A clean reader has no project or conversation context. It reads only the prose you give it and reports where a first-time reader gets stuck.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Requirements

- macOS with `/usr/bin/sandbox-exec`. On any other host the helper refuses to run. Do not run it without the sandbox and do not claim source isolation on Linux. Report the limit, keep the goal and the prose, and say that no review ran.
- The Codex CLI (`codex`) with a login in `~/.codex/auth.json`. Supply `--codex PATH` or `--auth-file PATH` when they are elsewhere.

## Run

The helper is `scripts/review.py` in this skill's folder.

```bash
python3 <skill>/scripts/review.py \
  --goal "Install the CLI and run the first check" \
  --output <scratchpad>/clean-reader-1 \
  [--deny PATH ...] [--stage-dir DIR] [--model NAME] [--timeout 600] \
  docs/install.md docs/first-run.md
```

- Supply exported prose only: `.md`, `.mdx`, `.txt` or `.vtt`. Basenames must be unique.
- `--output` must be a new directory. Keep it outside the checkout unless a review needs the artefacts.
- `--deny` sets the paths the reader cannot read. It is repeatable. The default is `/Users`, `/Volumes`, `/private/tmp` and `/private/var/folders`. The current directory is always denied. Each input and the parent of `--output` must be inside a denied path, or the confinement probe stops the run.
- `--stage-dir` is the parent of the temporary staging directory (default `/private/tmp`). It must be inside a denied path.

## What the helper does

1. It labels each document with its original line numbers. It removes `docs-map:` comments and `Sources:` blocks.
2. It copies only the Codex authentication into a temporary home. It removes that home after the run.
3. It writes a sandbox profile that blocks the denied paths and all writes, except the staging directory. System and CLI runtime files stay readable. File metadata stays available for path resolution.
4. Before it opens Codex, it proves that each input and an unrelated canary file cannot be read, and that the staged prose is readable but cannot be changed.
5. It runs `codex exec` with read-only sandbox, ephemeral session, user configuration and rules ignored, and web search, shell, plugins, memories, hooks and multi-agent features off.
6. It rejects any tool event, an invalid citation, a quote that is not on the cited line, and a claim that installation was done.

Each failure stops the run, names the failed item and gives a repair.

## Read the result

- `report.md` and `report.json`: the findings and the attempted step sequence.
- `evidence.json` and `isolation.sb`: document hashes, CLI version, denied paths and the confinement evidence.
- `prompt.txt`: exactly which prose the reader got.

## Judge the findings

- Check irrelevant negations, distracting detail, and unsupported or contradictory claims.
- Find unclear next actions and the specific question the reader must answer to continue.
- An unsupported claim is not proof of a false claim. Confirm it against the source separately, if the task permits.
- The reader does a document walkthrough. It does not install software, deploy services or prove runtime behaviour.
