# Repository instructions

Keep `AGENTS.md` and `CLAUDE.md` identical.

## Work on main

Do development of this plugin on `main`, in this checkout. Do not make a feature branch, a worktree or a pull request for a change here. Keep this checkout on `main`.

This rule applies to this repository only. It replaces the plugin's general rule of one branch and one pull request for each change.

Reason: Claude and Codex load the plugin from this checkout. A change on another branch or in a worktree is not loaded, so a new command or skill does not appear until the change is on `main`.
