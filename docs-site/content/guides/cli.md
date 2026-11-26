---
title: CLI reference
description: Complete command reference, JSON output contract and exit codes for all 15 ndev command groups.
---

# CLI reference

Run `ndev <group> <command> [options]` from a terminal, a skill, a native harness hook or an Orca panel. Every group and subcommand supports `--help` and `--json`.

```sh
ndev --version
ndev --help
ndev <group> --help
ndev <group> <command> --help
```

## JSON contract and exit codes

With `--json`, `ndev` prints one JSON object to `stdout` and sends progress messages to `stderr`. In JSON mode, commands never block waiting for interactive terminal prompts. If a human decision is needed, the result names the next action.

Success:

```json
{ "ok": true, "result": { } }
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "...",
    "message": "...",
    "details": { },
    "repair": "..."
  }
}
```

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Operation failed or a guard refused the action. |
| `2` | Invalid arguments or bad input. |
| `3` | Wait timed out. |
| `4` | Wait cancelled. |
| `5` | Internal state conflict where a safe retry cannot complete. |

## Command groups overview

| Group | Purpose |
| --- | --- |
| `install` | Install or verify `ndev` for Claude Code, Codex, opencode or custom profiles. |
| `project` | Read and update project settings, credentials, guidance, issues and pull requests. |
| `github` | Compact GitHub issue, pull request, sub-issue, blocker and project board operations. |
| `flow` | Start, advance, checkpoint, repair and complete issue workflows. |
| `wait` | Perform one bounded blocking wait for an agent, URL, PID, command, PR, check or issue. |
| `epic` | Coordinate epic phases, sub-issues, review debt, stacked PRs and workers. |
| `remote` | Select, create, import, resize or remove saved remote Orca servers. |
| `triage` | Load, clean, group and launch issue work in Orca. |
| `fix-prs` | Run and inspect the automated pull request repair queue. |
| `pane` | Show worktree views, responsive matrices, screenshots, files and resource controls. |
| `walk-doc` | Run a fresh-reader walkthrough over documentation. |
| `chat-guard` | Enable or inspect 50-minute idle send protection for native Orca chats. |
| `hook` | Handle native lifecycle events from Claude Code, Codex or opencode. |
| `requirements` | Author, trace, check, render and publish requirement records (`REQ-NNNN`). |
| `watch` | Run the session, PR check and idle watcher inside an Orca terminal. |

## `install`

```text
ndev install <claude|codex|opencode|all> [--prefix <dir>] [--dry-run] [--panels] [--approve <fingerprint>]
ndev install <profile> --profile <file> [--prefix <dir>] [--dry-run]
ndev install verify <claude|codex|opencode|all> [--prefix <dir>]
```

## `project`

```text
ndev project status
ndev project setup [--repo <owner/name>|--no-repo] [--board <owner/number>|--no-board]
ndev project mode [light|heavy|hack]
ndev project steering [interactive|auto]
ndev project init
ndev project credentials [--copy-from-main|--init]
ndev project learn
ndev project guidance <kind> <description>
ndev project report-workflow-bug --title <title> --details <text>
ndev project pr-new --title <title> --body-file <file> [--base <branch>] [--head <branch>] [--ready]
ndev project issue-new --title <title> --body-file <file> [--label <label>]... [--assignee <login>]... [--milestone <number>] [--type <type>]
```

## `github`

```text
ndev github repo
ndev github default-branch
ndev github issue-read <issue>
ndev github pr-read <pr>
ndev github issue-edit <issue> [--title <title>] [--body-file <file>]
ndev github pr-edit <pr> [--title <title>] [--body <text> | --body-file <file>]
ndev github pr-ready <pr>
ndev github pr-reopen <pr>
ndev github label <issue-or-pr> <label>
ndev github unlabel <issue-or-pr> <label>
ndev github labelled <label>
ndev github feedback <issue> <pr>
ndev github subissues link <parent> <child>... | list <parent>
ndev github blocked-by add|remove <issue> <blocker>... | list <issue> | blocking <issue>
ndev github board ready | awaiting | items [<column>] | fields | move <item-id> <status-or-column> | set <item-id> <field> <value> | add <issue> [<column>]
ndev github comment <issue-or-pr> --body <text>
ndev github dump issue|pr <n> [--out <dir>] [--repo <owner/name>]
ndev github merge-main [--dry-run] [--pr <n>]... [--worktree-dir <dir>] [--install-cmd <cmd>] [--push-cmd <cmd>] [--trusted-file <path>]... [--trailer <line>]...
ndev github milestones
ndev github issues-by-milestone <exact title>
ndev github pr-list [--head <branch>] [--state open|closed|all] [--limit <n>]
ndev github pr-search <query> [--limit <n>]
ndev github pr-diff <pr>
ndev github pr-commit-dates <pr>
ndev github pr-rows [--limit <n>]
ndev github view-json pr|issue <n|branch|url> --fields <fields> | pr --open [--limit <n>] --fields <fields>
ndev github run-status <run-id>
ndev github unpushed
```

## `flow`

```text
ndev flow help | guide
ndev flow status [--issue <n>|--pr <n>]
ndev flow start <issue> [--pr <n>] [--short-name <slug>] [--mode <mode>] [--take-over]
ndev flow repair --issue <n> --pr <n> [--take-over]
ndev flow create <short-name> --description-file <file> [--mode <mode>]
ndev flow hotfix <short-name> [--issue <n>] [--description-file <file>]
ndev flow comment --issue <n>|--pr <n> --message-file <file>
ndev flow interview [--round-file <json>|--answers-file <json>|--finish]
ndev flow finished-interview
ndev flow finished-plan --markdown-file <file>
ndev flow finished-hacking
ndev flow checkpoint --message <text> --file <path>... [--change-type <type>]... [--worktree <path>]
ndev flow finished-development [--issue <n>]... [--pr <n>]... [--message <text>] [--file <path>]... [--change-type <type>]... [--body-file <file>] [--hardening <text>] [--human-confirmation <text>]
ndev flow push-draft [--issue <n>|--pr <n>] --sha <full-reviewed-sha> --review <text>
ndev flow finished-review (--review <text> | --waive-review <reason>) --deadcode <text> --remembered <text>
ndev flow authorise-review --head <full HEAD commit id> --reason <text>
ndev flow finished-checks
ndev flow finished-smoke --report-file <file>|--skipped <reason>
ndev flow finished-revision
ndev flow revisit
ndev flow done --message <text> [--remembered <text>]
ndev flow blocked --message <text>
ndev flow unblock [<answer>]
ndev flow follow-up --mode <this_agent|subagent|worktree|issue_only> --message-file <file> [--existing-issue <n>]...
ndev flow add-migration <name> [--workdir <path>] [--new-version | --adopt <path>]
ndev flow request-secret <name>
ndev flow mode [light|heavy|hack]
ndev flow steering [interactive|auto] [--reason <text>]
ndev flow skip [<reason>]
ndev flow goto <state> [<reason>]
ndev flow off [<reason>] [--project]
ndev flow on [--project]
```

## `wait`

Place wait options (`--issue <n>`, `--pr <n>`, `--period <seconds>`, `--attempts <n>`, `--timeout <seconds>`) before the first positional argument or before `--`. Default cap is 20 minutes (6 hours for `command`, `checks` and `branch-ci`).

```text
ndev wait agent <dispatch-id|session-id>
ndev wait url <url>
ndev wait process <pid>
ndev wait seconds <seconds>
ndev wait command -- <executable> [<arg>...]
ndev wait pr <target-pr> <open|closed|merged|draft|ready|mergeable>
ndev wait issue <open|closed> <target-issue>...
ndev wait state <target-issue> <state>
ndev wait checks <pr> [--timeout <seconds>] [--period <seconds>]
ndev wait branch-ci <branch> [--timeout <seconds>] [--period <seconds>]
```

## `epic`

```text
ndev epic start [<issue>|--title <text>] [--short-name <slug>] [--parallel <n>] [--implementer <agent>] [--implementer-model <model>] [--reviewer <agent>] [--reviewer-model <model>] [--run <id>] [--repo-id <id>] [--remote [<server>]|--local] [--remote-repo <selector>] [--take-over] [--base-sha <sha>] [--coordinator-model <model>] [--posture <standard|deadline>] [--full-suites-file <json>]
ndev epic import <epic> --issues-file <json> --evidence <text>
ndev epic phase <epic> <phase> --evidence <text> [--file <path>]... [--aim <text>] [--source <path|link|no source: reason>]... [--approval <text>] [--cap-override <reason>] [--spec-pr <n>] [--issues-file <json>] [--closing-file <json>]
ndev epic debt <epic> --file <json>
ndev epic ruling <epic> <debt-key> --file <json>
ndev epic next <epic>
ndev epic brief <epic> <sub> <implementer|reviewer> [--pr <n>]
ndev epic issue <epic> <sub> <state> [--pr <n>] [--worker <id>] [--workspace <selector>] [--verdict <approve|changes>] [--note <text>] [--override <reason>]
ndev epic status [<epic>]
ndev epic skip [<reason>] [--issue <n>]
ndev epic goto <state> [<reason>] [--issue <n>]
ndev epic off [--issue <n>]
```

## `triage`, `fix-prs` and `remote`

```text
ndev triage start [--dry-run] [--codex] [--open] [--batch <n>|--sequential] [--since <n>] [--reverse] [--bugs-only] [--mine] [--remote [<server>]] [--hint <text>]
ndev triage clean [--since <n>] [--reverse] [--mine] [--hint <text>]
ndev triage groups --file <json>
ndev triage clean-verdicts --file <json>
ndev triage confirm --issue <n> --revision <n> <close|keep>
ndev triage launch | refresh | reset | status

ndev fix-prs start [--no-merge]
ndev fix-prs status | pause | resume
ndev fix-prs skip <pr> | retry <pr>
ndev fix-prs report <pr> <pushed|blocked> [--reason <text>] [--worktree <path>]

ndev remote status | list | off
ndev remote set <server>
ndev remote create <name> [--context <name>] [--type <type>] [--location <location>] [--ssh-key <key>] [--floating-ip <name-or-id>] [--yes]
ndev remote remove <name> [--context <name>] [--floating-ip <name-or-id>] [--forget] [--unverified-host] [--yes]
ndev remote import <hetzner-id> --context <name> [--floating-ip <name-or-id>] [--name <name>] [--yes]
ndev remote resize [<type>] [--context <name>] [--server <selector>] [--ssh <user@host>] [--agent <agent>] [--yes]
```

## `pane`, `walk-doc`, `chat-guard`, `hook` and `watch`

```text
ndev pane view [--open]
ndev pane responsive-matrix [--open]
ndev pane screenshot <url> [--viewport <width>x<height>]... [--scheme <light|dark>]... [--full-page] [--wait-seconds <n>]
ndev pane files <create|copy-from-main> <name>
ndev pane resources <stop-server|stop-stack|stop-all|forget> <args>

ndev walk-doc start <path-or-url> [--persona <text>] [--re-record] [--open]
ndev walk-doc ask <question> | answer <ask-number> <text> | restart [<note>] | tip <text>
ndev walk-doc stop | status | done <summary> | finish [<summary>]
ndev walk-doc report|enhance|record|reply|escalate --file <json>

ndev chat-guard on | off | status

ndev hook <session-start|prompt-submit|prompt-context|pre-tool-use|post-tool-use|turn-start|turn-complete|session-end|compact> [--harness <harness>]

ndev watch [--session <id>] [--worktree <selector>] [--once]
```

## `requirements`

```text
ndev requirements new "<short title>" --author "<name>, <name>" --type <type> [--origin explicit|implied|PR] [--level soft|normal|hard] [--section <name>] [--base <git ref>]
ndev requirements list [--status <status>] [--section <name>] [--level soft|normal|hard] [--type <type>] [--flagged]
ndev requirements search <term>...
ndev requirements quote <path> <first line> <last line>
ndev requirements check | render [--check] | publish [--check]
ndev requirements guard --base <git ref>
ndev requirements agree <REQ-NNNN> --by "<name>"
ndev requirements flag <REQ-NNNN> "<why it looks wrong>" | <REQ-NNNN> --clear
ndev requirements level <REQ-NNNN> soft|normal|hard
ndev requirements type <REQ-NNNN> principle|product|ux|design|operational|implementation|architectural|process
ndev requirements author <REQ-NNNN> "<name>"...
ndev requirements model <REQ-NNNN> <path.qnt[#name]>...
ndev requirements sync [<REQ-NNNN>...]
ndev requirements log <REQ-NNNN> "<what changed>"
ndev requirements sources [--tier <n>]
ndev requirements ledger <path> <first line> <last line> "<reason>"
ndev requirements uncovered [<path>...]
ndev requirements untraced --prs <file>
ndev requirements link <REQ-NNNN> <pull request link> [--prs <file>] [--issue <issue link>]
ndev requirements file <REQ-NNNN> <path or pattern>...
ndev requirements decision <REQ-NNNN> <path>...
ndev requirements trace --prs <file> --issues <file>
ndev requirements links|explained|levels|types <REQ-NNNN>... | --base <git ref>
ndev requirements cites <body file> --kind issue|pr
ndev requirements for <path | issue or pull request link | #N --repo <owner>/<repo>>... [--status <status> | --all]
ndev requirements narrate "<section>" [--from <file>] | narrative
ndev requirements references <path>
ndev requirements retire <path>... --pdr <file> [--keep <file>,<file>]
ndev requirements deprecate <REQ-NNNN> --reason "<why>" --decided-by "<name>" [--by <REQ-NNNN>]
ndev requirements fixed --base <git ref>
```
