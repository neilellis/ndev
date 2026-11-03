---
name: command-reuse
description: "Reuse tested commands for local checks, saved logs, PR waits, and session audits. Use when a task repeats tool calls, reconstructs a known procedure, or needs evidence without filling the main context."
---

# Reuse commands

Use a tested command for a known procedure. Keep the reasoning in the main agent and the repeated mechanics in scripts.
This is a command guide, not a development workflow. Do not load every linked skill or audit history for each fix.

## The workflow

A wait or a commit in a running workflow belongs to the `mcp__ndev__*` tools, so do not script those. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Find the command once

Use this table before you search the repository or write inline shell or Python. Run commands from the task worktree. If a script is missing, report its path. Do not invent a silent replacement.

| Need | Command | Result and limit |
|---|---|---|
| Task status, once | `${CLAUDE_PLUGIN_ROOT}/scripts/work/work-status.sh --repo <repo> --task <slug> --fetch --json` | Or `--issue`, `--pr`, `--branch`. Add `--owned-worktree <path>` only for ownership already confirmed. PR, branch, worktree, CI and base state together. |
| Claim a worktree | `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree_claim.sh <repo> <task> origin/<base> [<parent>]` | Checks ownership and makes the worktree. A refused claim stops setup. |
| Check and push | The repo's checked-push command named in its CLAUDE.md, else `git push` | Hooks run. Never `--no-verify`. |
| Run a check with saved evidence | `python3 <this skill>/scripts/run_logged.py --out-dir <new-dir> --timeout 900 -- <cmd> <args>` | Saves `output.log` and `result.json`. Returns the command's exit code. A timeout returns 124 and stops the process group. |
| Screenshot a page | `${CLAUDE_PLUGIN_ROOT}/scripts/browser/orca-shot.sh <url> <out.png> [--page <id>] [--viewport 390x844] [--wait 2]` | Uses Orca's built-in browser and its signed-in sessions. Without `--page` it opens a new tab and prints its id; close it with `orca tab close --page <id>`. Exit 3: Orca is not running (`orca open`). |
| Wait for a local process | `${CLAUDE_PLUGIN_ROOT}/scripts/work/wait_for_process_end.sh <pid>` | Waits for exit. It cannot recover the exit code: read the owner's result file. |
| Wait for CI failure or completion | `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh <pr> --skip-success --json --timeout 600` | Ignores intermediate successes. Exit 0 alone is not a CI pass: read the commit and conclusions. |
| Save PR context | `${CLAUDE_PLUGIN_ROOT}/scripts/github/dump.py pr <pr> --out <new-dir>` | One file for a focused read. Reuse it until the PR changes. |
| Find repeated session work | `python3 <this skill>/scripts/codex_session_audit.py --repo <repo> --limit 20 --output <new-file>.json --examples 3` | Calls, bounded message lines, exact repeats and activity hints. |

`run_logged.py` facts:

- It starts one command without a shell, in its own POSIX process group.
- It refuses an existing evidence directory. Use a new one for each run.
- On success it prints a short result. On failure it prints bounded log excerpts. The full output stays on disk.
- Exit 0 proves only that the command returned 0. Check test counts, skipped checks and the revision before you report success.
- Use it for commands you start. Use the process waiter for a process that already runs.
- Never use it to start an agent CLI that the session is not authorised to start.

## Wait and read once

Run the wait or logged command once, with the wait inside the script. Do independent work while it runs. Resume on completion or on a relevant event.
Never replace a script with repeated status calls, sleeps, log tails or reads of the same result file. Use a `work-light` helper when the wait would fill the main context.
Return the final status, evidence paths and any decision needed. Keep the full log out of the conversation.

## Audit only to improve the workflow

`codex_session_audit.py` reads local Codex JSONL rollouts and JSON record arrays (default folder `~/.codex/sessions`). It takes the 20 most recently changed main sessions.

- `--offset 20 --limit 40`: the 40 sessions before those. New activity can change the order; keep the file list when an exact comparison matters.
- `--include-subagents`: include child sessions. Or pass files explicitly.
- `--sessions-dir`: another history folder. `--repo` matches that folder and its descendants; pass the base checkout to include its worktrees.
- `--max-chars 0`: full text. The default excerpt limit is 1,200 characters.
- Malformed input stops the audit and names the file. Retry after the writer finishes.

The report holds call names, input excerpts, input hashes, source lines and output sizes, plus the first and last lines of each message. It excludes instructions, reasoning and tool output bodies. It can contain private text: keep it out of Git and publish only checked aggregate findings.
An exact repeat can show a repeated read or wait. It does not prove the call was unnecessary. Names inside `functions.exec` are lexical hints. Character counts are not tokens. Read a few source-linked examples before you change a workflow.

## Save the procedure, not the transcript

- When a procedure recurs, first look for a tested helper. If one exists, add its command and one useful limit to this guide or the owning skill.
- Else add a small script with explicit inputs, bounded output, a failure exit code and a test for the observed failure, in the owning skill's `scripts/` folder.
- Do not turn one temporary edit into a framework.
- Keep a short task note: command, working folder, revision, evidence paths, result. Reuse evidence only while the code, dependencies, configuration and environment are unchanged.
- Update stale recipes in place. Do not copy the same instructions into several skills.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
