# Hooks

[kb](../README.md) › hooks

**These scripts are reusable copies of the hooks and push scripts that the method needs. Copy each into a repository, set its few settings, and wire it in.** Each script's header says what it guards and how to wire it.

While a [workflow](../workflow.md) runs in a worktree, the plugin's edited-file guards and precheck reminder stand aside, because the workflow tools run the checks.

## The scripts

| Script | Kind | Copy to | What it guards |
|---|---|---|---|
| [pre-push](pre-push) | Git hook | `.githooks/pre-push` | Runs the CI guards job's checks on the clean, committed tree, on top of the current base branch. |
| [pre-push-dispatch.sh](pre-push-dispatch.sh) | Git hook dispatcher | `scripts/pre-push-dispatch.sh` | Runs each worktree's own `.githooks/pre-push`. Refuses a worktree that has none. |
| [install-guard-hooks.sh](install-guard-hooks.sh) | Installer | `scripts/install-guard-hooks.sh` | Installs the dispatcher in the shared Git common folder and sets `core.hooksPath`. Never replaces a hook it does not know. |
| [push-checked.sh](push-checked.sh) | Push wrapper | `scripts/push-checked.sh` | Refuses `--no-verify`, needs a clean tree, pulls the base branch, then pushes. |
| [wait-for-process-end.sh](wait-for-process-end.sh) | Wait helper | `scripts/wait-for-process-end.sh` | Blocks until a process ends, so that nobody polls by hand. |
| [edited-file-guards.sh](edited-file-guards.sh) | Claude Code `PostToolUse` (`Edit\|Write`) | `.claude/hooks/` | Runs the single-file CI rules on each written file. Exit 2 returns the findings to the model. |
| [precheck-reminder.sh](precheck-reminder.sh) | Claude Code `PostToolUse` (`Bash`) | `.claude/hooks/` | After a real `git commit`, reminds the agent to run the precheck. Never blocks. |
| [warn-subscription-cli.sh](warn-subscription-cli.sh) | Claude Code `PreToolUse` (`Bash`) | `.claude/hooks/` | Warns before a command that runs `claude -p` or touches the subscription gate variable. Never blocks. |
| [init-worktree-submodules.sh](init-worktree-submodules.sh) | Claude Code `PostToolUse` (`Bash`, async) | `.claude/hooks/` | Initialises empty submodule folders in a worktree made with `git worktree add`. |

## Install the push gate

1. Copy `pre-push` to `.githooks/pre-push`. Copy the other three push scripts to `scripts/`. Make all four executable.
2. Write `scripts/whole-tree-checks.sh`. It takes `--base <commit>`, runs every check of the CI guards job with no early stop, and exits 0 pass, 1 defect, 2 could not run.
3. Set the base branch if it is not `main`: `git config guard.baseBranch <branch>`.
4. Run `bash scripts/install-guard-hooks.sh` once per clone. Every worktree of the clone then uses the gate.
5. Push only with `bash scripts/push-checked.sh <git push arguments>`.

The design is in [precheck-and-push.md](../precheck-and-push.md).

## Wire the Claude Code hooks

All four Claude Code hooks in one `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [ { "type": "command",
                     "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/warn-subscription-cli.sh\"",
                     "statusMessage": "Checking for subscription use" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Bash",
        "hooks": [
          { "type": "command", "async": true,
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/init-worktree-submodules.sh\"",
            "statusMessage": "Initialising worktree submodules" },
          { "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/precheck-reminder.sh\"",
            "statusMessage": "Checking for a commit" } ] },
      { "matcher": "Edit|Write",
        "hooks": [ { "type": "command",
                     "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/edited-file-guards.sh\"",
                     "statusMessage": "Running edited-file guards" } ] }
    ]
  }
}
```

## Use them through the plugin

The `ndev` plugin can run the four Claude Code hooks for you, with no copy and no `.claude/settings.json` entry. It runs each script from the plugin's own `kb/hooks/`, gives it the same JSON payload on stdin that Claude Code gives, and sets its settings as environment variables.

Each hook is opt-in per project. Add a `quality` key to `.ndev.json` at the project root (the git top level) and commit it. A hook that is not listed does not run. `{}` runs a hook with its defaults. A full example is in [templates/neil-dev.json](../../templates/neil-dev.json).

```json
{
  "quality": {
    "editedFileGuards":    { "venv": ".venv" },
    "precheckReminder":    { "command": "./scripts/precheck.sh" },
    "subscriptionWarning": { "gateVar": "ALLOW_CLAUDE_CLI" },
    "worktreeSubmodules":  { "paths": [".claude/agents"] }
  }
}
```

| Key | Script | Runs | Setting → variable | What the model gets |
|---|---|---|---|---|
| `editedFileGuards` | `edited-file-guards.sh` | after `Edit` or `Write` | `venv` → `EDITED_FILE_GUARDS_VENV` | Exit 2: the findings, after the tool result. The edit has already happened, so the model must fix the file. Exit 0 with output: the advice. |
| `precheckReminder` | `precheck-reminder.sh` | after a `Bash` command that names `git` and `commit` (the script decides if it was a real commit) | `command` → `PRECHECK_COMMAND` | The reminder. Never blocks. |
| `subscriptionWarning` | `warn-subscription-cli.sh` | before a `Bash` command that names `claude` or the gate variable | `gateVar` → `SUBSCRIPTION_GATE_VAR` | The warning. Never blocks. |
| `worktreeSubmodules` | `init-worktree-submodules.sh` | after a `Bash` command with `git worktree add`, in the background | `paths` (array) → `WORKTREE_SUBMODULES` (space-separated) | Nothing; a failure shows as a toast with the command to run by hand. |

Every script also gets `CLAUDE_PROJECT_DIR` set to the project root, and runs in that folder.

Failures are shown, never hidden:

- Invalid JSON, an unknown key or a wrong value type in the file: one toast names the file and the problem. No quality hook runs until you fix it.
- A script that cannot run (an exit code other than 0 or 2, or a time-out): a toast and a note to the model name the script, the exit code and the start of its stderr.

The plugin reads the file once, when the session starts. After you change it, restart Claude Code.

## Rules for every hook

- A Claude Code hook is an extra, earlier check. The rule it checks must also live in Git hooks or CI, because Codex and people do not run Claude Code hooks.
- A hook that could not run says so on stderr. Silence means "judged, and nothing found".
- A hook that CI does not mirror must only advise. It must never refuse what CI accepts.
- Read the payload with `jq`. Check for `jq` first.
- Prove each hook in both directions with a test that feeds it a payload ([testing.md](../testing.md)).
- Check each script with `bash -n` and `shellcheck` after an edit.
