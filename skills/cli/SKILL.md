---
name: cli
description: Run a named ndev CLI command from a chat message, or show the available commands and flags.
---

# Run ndev

Use `ndev` on PATH. If it is missing from PATH, use `"${CLAUDE_PLUGIN_ROOT}/bin/ndev"`.

Run the requested command in the current project worktree. Treat the words after the skill name as ndev arguments. Keep quoted flag values together and pass arguments as data. Do not evaluate shell operators in the message.

With no arguments, run `ndev --help`. For a plain-language request to run a group command, use its help to resolve the flags. Report the result and any approval or input the command needs.
