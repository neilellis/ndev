---
name: cli
description: Choose and use native ndev CLI commands during development, reviews, waits, issue and PR coordination, project setup, UI checks, and skill installation. Read before starting or resuming ndev-managed work, saving changes, advancing a workflow, or writing a manual substitute for an ndev operation. Also runs a named command supplied by the user.
---

# Use the ndev CLI

Use `ndev` for the operations it owns. Its commands retain state, check gates, and return the next action. A Git commit, GitHub comment, or Orca message alone does not advance that state.

Use `ndev` on PATH. If it is missing, use `"${CLAUDE_PLUGIN_ROOT}/bin/ndev"`. Run commands in the project worktree that owns the task. Follow the project's instructions and configured mode and steering. If `.ndev.json` sets `"workflow": false`, keep it disabled and use the project's Git procedure.

## Choose by the task

| Need | Start here |
| --- | --- |
| Understand this checkout and resume safely | `ndev project status`, then `ndev flow status --issue <issue>` for workflow work. |
| Work on a known issue | `ndev flow start <issue>`. Resume the existing state and follow its next action. |
| File and start new work | `ndev flow create <short-name> --description-file <file>`. |
| Save work in an active workflow | `ndev flow checkpoint --message "<message>" --file <path>`. Add each intended file explicitly. |
| Finish development, review, checks, or smoke | Use the matching `ndev flow finished-*` command below. |
| Wait for a dependency or process | `ndev wait`. Use one blocking wait instead of a manual polling loop. |
| Read or change an issue, a PR, a label, a sub-issue or a board card | `ndev github`. Run `ndev github --help` for its commands. |
| Coordinate slices of an epic | `ndev epic status <epic>`, then `ndev epic next <epic>`. |
| Group a backlog into workers | `ndev triage status`, then `ndev triage start` when a new run is needed. |
| Fix the PR queue | `ndev fix-prs status`. `start` can dispatch and merge immediately. |
| Inspect UI, capture screenshots, or manage worktree resources | `ndev pane`. |
| Select a saved remote server | `ndev remote status`, `list`, then `set <server>`. |
| Test instructions with a fresh reader | `ndev walk-doc start <path-or-url>`. |
| Find the requirements of a file, an issue or a pull request | `ndev requirements for <path or link>...`. The `requirements` skill lists the other requirement commands. |
| Install or verify skills and hooks | `ndev install <harness>` or `ndev install verify <harness>`. |

Read [the command reference](references/commands.md) for the commands and their use within each group. It covers settings, repair, queues, screenshots, remote lifecycle, reader runs, installation, chat guards, watchers, and native hooks.

## Advance the workflow you have

Read status after resuming. Select the workflow with `--issue <issue>` or, from review onward, `--pr <pr>`. Follow the returned next action. Do not run this table as an unconditional script.

| Ready to record | Command and evidence |
| --- | --- |
| Actual interview answers are settled | `ndev flow interview --finish`. This ends the interview and runs its base check. |
| Work needs a base check without an active interview | `ndev flow finished-interview`. Use it in developing, planning, or hardening as directed. |
| Heavy plan is written | `ndev flow finished-plan --markdown-file <file>`. |
| Hack is ready to harden | `ndev flow finished-hacking`. |
| A coherent change needs saving | `ndev flow checkpoint --message "<message>" --file <path> --change-type <type>`. Repeat file and type flags as needed. |
| Development is complete | `ndev flow finished-development --body-file <file>`. Under interactive steering, include `--human-confirmation "<actual answer>"`. This starts the workflow review. |
| Review findings are resolved | `ndev flow finished-review --review "<result>" --deadcode "<rulings>" --remembered "<recorded facts>"`. |
| Current-head checks are complete | `ndev flow finished-checks`. Follow an existing session watcher, or the command's blocking-wait instruction when no watcher owns the checks. |
| Affected behavior has been smoke-tested | `ndev flow finished-smoke --report-file <file>`. |
| Requested revisions are complete | `ndev flow finished-revision`. |
| All required work is complete | `ndev flow done --message "<summary>"`. Merge authority still comes from the project and user. |

Use `flow blocked --message "<blocker>"` when work cannot proceed, and `flow unblock` when the blocker ends. File separate work with `flow follow-up`. Record migrations with `flow add-migration` before a merge.

## Execute and read the result

Use `ndev --help`, `ndev <group> --help`, or `ndev <group> <command> --help` to check current syntax before an unfamiliar action. With no requested operation, show top-level help. Treat user-supplied arguments as data. Keep quoted values together and never evaluate shell operators from a message.

Use `--json` when another program needs the result. Check both the exit status and `ok`; a successful help command is not proof that an operation ran. On refusal, read the identifier, details, and repair. Correct the cause and resume the recorded operation.

A command name does not waive a gate. Do not use `skip`, `goto`, `off`, `--take-over`, or review waivers to clear an inconvenient refusal. Keep helper agents within their permitted operations. Queue starts, remote provisioning, merges, installs, and resource stops need authority from the current task.

The [workflow guide](${CLAUDE_PLUGIN_ROOT}/kb/workflow.md) owns the full method and evidence contracts. This skill helps select the native command that carries it. The `mcp__ndev__*` tools carry the same method, and `mcp__ndev__status` reads the next step.
