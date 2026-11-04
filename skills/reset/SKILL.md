---
name: reset
description: "Close the current feature work, save it as a PR, remove its worktree, and freshen the base checkout; use --discard only to abandon a dead end."
disable-model-invocation: true
---

# Reset a worktree

This skill changes the repository. Use it only when the user invokes it. The commands are in this skill's `scripts/reset.sh`; call it with an absolute path.

Settings: `RESET_BASE` (base branch; default origin/HEAD, else `main`), `COMMIT_TRAILERS` (trailer lines that the session requires), `PR_FOOTER` (appended to a new PR body), `GH_USE_KEYRING=1` (use the gh keyring login).

1. Run `reset.sh state`. If you are already in the base checkout, run `reset.sh freshen <main_root>` and stop.
2. In a worktree, run `reset.sh save [message]`, unless the user passed `--discard`. `save` commits dirty files with the trailers, pushes the feature branch, and reuses an open PR or opens one. It refuses the base branch.
3. Remove only this worktree. Use the host's worktree removal (the harness ExitWorktree tool, or Orca through the `orca-cli` skill). As a fallback, run `reset.sh remove <worktree> <main_root>`. It refuses the main checkout and any path that is not a registered worktree.
4. Run `reset.sh freshen <main_root>`. Remove only this job's scratch files in its own temporary folder.
5. Report in one line: branch, PR, worktree removal, base SHA, clean or not.

`--discard` is the authorisation to skip `save` and force-remove the current worktree. It never touches the base branch. Never remove another session's worktree. Never use a broad deletion target.

## The workflow

A workflow's state stays in `.neil-dev.worktree.json`. Call `mcp__ndev__started(issue)` to resume it, or use `/flow off` to stop it. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
