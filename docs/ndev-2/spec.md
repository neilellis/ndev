# ndev 2.0 spec

Epic [#64](https://github.com/neilellis/ndev/issues/64). The [parity list](parity.md) links each plugin feature to a work item and a test.

## Where the behavior lives

Move workflow behavior from Claude Code hooks and MCP tools into the CLI. Move the Claude Code user interface into the Orca plugin. Harness hooks forward events to `ndev hook`. The Orca plugin renders panels and sends named actions to the CLI. Both use the same commands and state as a terminal caller.

## Command line

Use the installed `ndev` binary from a terminal, a skill, a hook, or an Orca panel. Reuse the export plan in `scripts/export/export.mjs` and the workflow in `scripts/export/flow/cli.ts`. Port the plugin's newer behavior into these modules and share the state machine and effects. The 2.0 release includes its own assets. It can install without the original plugin checkout.

All groups and commands take `--help`. Commands take `--json` for one result on stdout. The result is `{"ok":true,"result":{...}}` or `{"ok":false,"error":{"code":"...","message":"...","details":{...},"repair":"..."}}`. Omit fields that do not apply. Errors include the item, exit status, and relevant output when a child process fails. Progress goes to stderr. Exit 0 means success, 1 means an operation failed or a guard refused it, and 2 means bad input. Waits also use 3 for timeout and 4 for cancellation. Internal state conflicts use 5 when a safe retry cannot complete. Text and JSON report the same result. In JSON mode a command that needs a human answer returns the next action. It does not prompt.

The following tree omits the common flags. A flag in brackets is optional. Repeat singular list flags to give more than one value. File flags read from disk or from stdin when the path is `-`. Accept `opencode2` as an install profile alias. GitHub issue and PR numbers are positive integers. A flow command uses the current owned record if it needs a target and the caller omitted it. If there is more than one possible record, it asks for the number in its error.

```text
ndev --version
ndev install <claude|codex|opencode|all> [--prefix <dir>] [--dry-run] [--panels] [--approve <fingerprint>]
ndev install <profile> --profile <file> [--prefix <dir>] [--dry-run]
ndev install verify <claude|codex|opencode|all> [--prefix <dir>]
ndev project status
ndev project setup [--repo <owner/name>|--no-repo] [--board <owner/number>|--no-board]
ndev project mode [light|heavy|hack]
ndev project steering [interactive|auto]
ndev project init
ndev project credentials [--copy-from-main|--init]
ndev project learn
ndev project guidance <kind> <description>
ndev project report-workflow-bug --title <title> --details <text>
ndev flow help
ndev flow guide
ndev flow status [--issue <n>|--pr <n>]
ndev flow start <issue> [--short-name <slug>] [--mode <mode>] [--take-over]
ndev flow create <short-name> --description-file <file> [--mode <mode>]
ndev flow hotfix <short-name> [--issue <n>] [--description-file <file>]
ndev flow comment --issue <n>|--pr <n> --message-file <file>
ndev flow interview [--round-file <json>|--answers-file <json>|--finish]
ndev flow finished-interview
ndev flow finished-plan --markdown-file <file>
ndev flow finished-hacking
ndev flow checkpoint --message <text> --file <path>... [--change-type <type>]... [--worktree <path>]
ndev flow finished-development --issue <n>...|--pr <n>... [--message <text>] [--file <path>]... [--change-type <type>]... [--body-file <file>] [--hardening <text>]
ndev flow finished-review --review <text> --deadcode <text> --remembered <text>
ndev flow finished-checks
ndev flow finished-smoke --report-file <file>|--skipped <reason>
ndev flow finished-revision
ndev flow done --message <text> [--remembered <text>]
ndev flow blocked --message <text>
ndev flow unblock [<answer>]
ndev flow follow-up --mode <this_agent|subagent|worktree|issue_only> --message-file <file> [--existing-issue <n>]...
ndev flow add-migration <name> [--workdir <path>] [--new-version]
ndev flow request-secret <name>
ndev flow mode [light|heavy|hack]
ndev flow steering [interactive|auto] [--reason <text>]
ndev flow skip [<reason>]
ndev flow goto <state> [<reason>]
ndev flow off [<reason>] [--project]
ndev flow on [--project]
ndev wait agent <dispatch-id|session-id>
ndev wait url <url>
ndev wait process <pid>
ndev wait seconds <seconds>
ndev wait command -- <executable> [<arg>...]
ndev wait pr <target-pr> <open|closed|merged|draft|ready|mergeable>
ndev wait issue <open|closed> <target-issue>...
ndev wait state <target-issue> <state>
ndev epic start [<issue>|--title <text>] [--short-name <slug>] [--parallel <n>] [--implementer <agent>] [--implementer-model <model>] [--reviewer <agent>] [--reviewer-model <model>] [--run <id>] [--repo-id <id>] [--remote [<server>]|--local] [--remote-repo <selector>] [--take-over]
ndev epic phase <epic> <phase> --evidence <text> [--file <path>]... [--aim <text>] [--issues-file <json>]
ndev epic next <epic>
ndev epic brief <epic> <sub> <implementer|reviewer> [--pr <n>]
ndev epic issue <epic> <sub> <state> [--pr <n>] [--worker <id>] [--workspace <selector>] [--verdict <approve|changes>] [--note <text>]
ndev epic status [<epic>]
ndev epic skip [<reason>] [--issue <n>]
ndev epic goto <state> [<reason>] [--issue <n>]
ndev epic off [--issue <n>]
ndev remote status|list|off
ndev remote set <server>
ndev remote create <name> [--context <name>] [--type <type>] [--location <location>] [--ssh-key <key>] [--floating-ip <name-or-id>] [--yes]
ndev remote remove <name> [--context <name>] [--floating-ip <name-or-id>] [--forget] [--unverified-host] [--yes]
ndev remote import <hetzner-id> --context <name> [--floating-ip <name-or-id>] [--name <name>] [--yes]
ndev remote resize [<type>] [--context <name>] [--server <selector>] [--ssh <user@host>] [--agent <agent>] [--yes]
ndev triage start [--dry-run] [--codex] [--open] [--batch <n>|--sequential] [--since <n>] [--reverse] [--bugs-only] [--mine] [--remote [<server>]] [--hint <text>]
ndev triage clean [--since <n>] [--reverse] [--mine] [--hint <text>]
ndev triage groups --file <json>
ndev triage clean-verdicts --file <json>
ndev triage confirm --issue <n> --revision <n> <close|keep>
ndev triage launch|refresh|reset|status
ndev fix-prs start [--no-merge]
ndev fix-prs status|pause|resume
ndev fix-prs skip|retry <pr>
ndev fix-prs report <pr> <pushed|blocked> [--reason <text>] [--worktree <path>]
ndev pane view [--open]
ndev pane responsive-matrix [--open]
ndev pane screenshot <url> [--viewport <width>x<height>]... [--scheme <light|dark>]... [--full-page] [--wait-seconds <n>]
ndev pane files create|copy-from-main <name>
ndev pane resources stop-server <name>
ndev pane resources stop-stack <id> <stop-keep-data|stop-and-delete>
ndev pane resources stop-all <stop-keep-data|stop-and-delete>
ndev pane resources forget <type> <id>
ndev walk-doc start <path-or-url> [--persona <text>] [--re-record] [--open]
ndev walk-doc ask <question>
ndev walk-doc answer <ask-number> <text>
ndev walk-doc restart [<note>]
ndev walk-doc tip <text>
ndev walk-doc stop|status
ndev walk-doc report|enhance|record|reply|escalate --file <json>
ndev walk-doc done <summary>
ndev walk-doc finish [<summary>]
ndev hook <event> [--harness <harness>]
ndev watch [--session <id>] [--worktree <selector>] [--once]
```

Flow transitions with a single target accept `--issue` or `--pr` unless the tree gives the target form. `finished-plan` takes an issue. `finished-development` accepts both lists when the work spans issues and PRs. An agent can set issue steering to auto only with a reason that no human can answer. A human sets it back through the controls described below. A change of mode or steering that yields hack with auto fails before any write.

Place wait flags before the first positional argument or before `--`. The wait group takes `--issue <caller>` or `--pr <caller>`, `--period <seconds>`, `--attempts <n>`, and `--timeout <seconds>` where they apply. It gives a single blocking call with a 20 minute limit. PR and issue waits default to 300 seconds between reads and refuse a period under 60 seconds. Use `wait command -- sh -c <script>` when the caller explicitly needs shell syntax. Preserve the last check result and prior workflow state. Give each wait its own ID. An unblock, signal, owner exit, or timeout can end only that wait. Report a PID exit as a state change. The exit code comes from the command that started the process or its result file.

## State and effects

| Location | Use |
| --- | --- |
| `<repo>/.neil-dev.json` | Shared project defaults, GitHub, branding, checks, workflow controls, and remote settings. |
| `<worktree>/.neil-dev.worktree.json` | Worktree settings and listed resources. The main checkout uses project settings. |
| `<worktree>/.neil-dev.issue-<n>.json` | Issue history, ownership, check evidence, interviews, PR links, wait state, and recovery data. |
| `<worktree>/.neil-dev.epic-<n>.json` | Epic phases, issue links, dependencies, workers, recovery, and stacked branch records. |
| `<worktree>/.ndev-inited` | A successful run of `scripts/init-project.sh` in this worktree. |
| `<worktree>/.neil-dev.env` | Project values. Report the path and line for a named secret. Keep its value out of output and state. |
| `<worktree>/.walk-doc.json`, `<worktree>/walk-run/<run>/`, `$HOME/.walk-doc/<run>/` | Walk settings, reports and evidence, and reader workspaces. |
| `$HOME/.config/ndev/remote.json` | Local project and host records for saved Orca servers. |
| `$HOME/.local/state/ndev/` | Local session bindings, watcher leases and receipts, triage and PR queue state, and panel state for each worktree. |
| `$HOME/dev-wiki` | Development lessons. Use the bundled seed when the directory is absent. |

Resolve the link from worktree to project with Git. Apply settings in the order issue, worktree, project, then the documented defaults. Keep local worktree and workflow records out of Git. Read existing records and retain fields that belong to other readers. Validate the record before writes. Use a lock and atomic replace for each local state update. Use a revision to refuse stale panel actions. Release record locks before external work, and record the operation so a retry can tell whether it already ran. A failed check leaves its output and the last valid state available.

Use `git` and `gh` for Git and GitHub. Use Orca for worktrees, worker dispatch, session identity and messages, the browser, terminals, and panels. Resolve the Orca host before use. A remote handle stays with the server that issued it. Read structured receipts, and include their failure details. If a start or send has an uncertain result, recover with the request ID and its receipt before attempting it again.

Keep draft PRs until their workflow gates are met. Follow the project merge setting. For this repository a human merges. Check the PR head SHA when recording check, review, or smoke evidence. Keep the checkpoint retry after a rebase. Read the expected remote SHA and prove each remote-only commit has a patch match in HEAD or is reachable from another remote branch. Then use a lease with that SHA. Refuse a new remote commit or a changed lease and keep the local commit.

An epic stores GitHub sub-issues and their blocker links. A child can start from a pushed open blocker PR when the frontier and capacity rules allow it. Record the stack in its brief and give Orca the base branch. After the blocker merges, tell the worker to rebase and retarget. Verify the child only once the blocker is merged and the child PR targets the default branch. Resolve remote worktrees by their server and repository ID. Carry the worker role, agent, and model in its brief. Keep local and remote workers on the same epic state rules.

## Hooks and watcher

The hook process reads the event on stdin. Each event runs through shared CLI handlers. The adapter takes the harness event and gives the same worktree, session, tool, command, and result fields to the handler when those fields exist. The adapter writes the wire format that its harness expects. A decision to deny a tool call must reach the harness before it runs the call. A denial tells the agent to use `ndev flow checkpoint` when that repair applies.

At session start in a linked worktree, copy missing project settings and credentials from the main checkout that Git reports. If no source file exists, write the default settings and an empty credentials file. Set the new credentials file to mode 600. Create a record with no resources for this worktree. Keep existing files. Add local Git excludes for the credentials and worktree record if Git does not already ignore them.

| Event | Work | Claude Code | Codex | opencode |
| --- | --- | --- | --- | --- |
| `session-start` | Bind the session, give setup and issue guidance, and start or reuse the watcher. | `SessionStart` | `SessionStart` | `session.created` and first context hook on resume |
| `prompt-submit` | Reload setup when needed and detect a correction. | `UserPromptSubmit` | `UserPromptSubmit` | Session prompt hook |
| `prompt-context` | Supply mode, steering, branding, repo, wiki, report, workflow, and epic context. | `UserPromptSubmit`, with `SessionStart` context on startup, resume, or compact | `UserPromptSubmit` and `SessionStart` with source `compact` | Session context hook |
| `pre-tool-use` | Apply the walk limits and shell Git guard before quality checks. | `PreToolUse` | `PreToolUse` | Tool execute before |
| `post-tool-use` | Report check hints, review component changes, flag a push for learning, and refresh panel data. | `PostToolUse` | `PostToolUse` | Tool execute after |
| `turn-start` | Record activity and distinguish a human answer from a watcher message. | `UserPromptSubmit` and tool activity | `UserPromptSubmit` and model activity | Session execution start |
| `turn-complete` | Record idle state, clear dead waits, and service the walk and PR queue. | `Stop`, `SubagentStop` | `Stop`, `SubagentStop` | Session execution end events |
| `session-end` | Stop walk resources, apply the worktree stop policy, and release ownership. | `SessionEnd` | `SessionEnd` | Session close or delete when available, with watcher exit handling for a closed terminal |
| `compact` | Mark skill context for reload. | `PostCompact` or `SessionStart` with source `compact` | `PostCompact` | Session compaction events |

On a new session, instruct the agent to start the saved workflow before development. When the worktree has no workflow record, use a selected GitHub issue or the only issue Orca links from the configured repository. Ask which issue to use when the choice is ambiguous. A project that disables the workflow receives a startup notice with the command to enable it.

### Native Orca chat guard

Run `ndev chat-guard on` to enable the guard for local Codex and Claude Code native chats. The prompt hook blocks a send after five minutes above 200,000 context tokens, or after more than 50 minutes of inactivity. It uses the latest available provider transcript accounting, so the token count is approximate. The guard reads a bounded transcript tail. If only the age of a truncated transcript is known, it can still enforce the 50-minute rule.

Run `/compact` in the chat, wait for it to finish, then retry the prompt. The guard leaves Orca's draft handling to the app. Run `ndev chat-guard off` to disable it or `ndev chat-guard status` to check whether it is enabled.

Install one entry per native event for ndev so its checks run in order. Claude Code uses `~/.claude/settings.json`. Codex uses `~/.codex/hooks.json`, or the active Codex config directory, with hook trust set by the user. opencode uses a server plugin that calls the binary with an argument vector and sends JSON on stdin. Test the v2 event names and denial path with the installed v2 host. For Claude Code and Codex, the pre-tool adapter uses each host's denial JSON. Both hosts use a single native prompt hook to run both prompt handlers in order. Preserve other hook entries.

Native interfaces

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [opencode server plugin API](https://opencode.ai/docs/build/plugins/server/)

A profile with no hooks installs a session skill with the event duties that an agent can perform. It states that these are instructions for the agent. It reports which tool guards and session cleanup operations require host support.

Run `ndev watch` in a terminal with `orca terminal create --worktree <selector> --title ndev-watch --command <command> --json`. Keep one watcher per Orca session and worktree. Record the binding and recover stale leases. Accept explicit session and worktree IDs for tests and for start after a restart. Shut down when the binding ends. Report a launch or delivery error with the Orca receipt. The watcher does the following.

- Read the PR head and check results every three minutes by default. Check the SHA again before sending a notice. Send a result once for its fingerprint. Report failed or stuck checks with their names.
- Check for a main turn that ends early and for idle work with no active wait. Clear a stopped wait, suppress reminders for a block or disabled workflow, and block after repeated nudges with no progress. The defaults are one idle nudge after 20 minutes or three early turn-end nudges. Do not send a second prompt into an active turn.
- Use Orca orchestration for worker messages and Orca's session or terminal route for a direct agent prompt. Keep a receipt so a late prompt can be recognized. Preserve the plugin's context refresh after compaction through the next context hook.
- Service triage and the PR queue from their stored schedules. Keep the PR queue's distinct wait, backoff, and retry state. Return a check result with `--once` for tests and diagnostics.

## Orca panels

Copy the current `neilellis.ndev` plugin into `orca-plugin/ndev/` in the panes work item. Keep the Files panel and its file and resource controls where the seed provides them. Add separate panels for interview, view, walk-doc, triage, fix-all-prs, and responsive matrix. The CLI returns text from the same view model when the panel is closed. A person can open a panel in Orca or request it with a command that takes `--open`. Use `orca plugin open neilellis.ndev --panel <id> --json` for the active desktop workspace. Check that the active workspace is the requested worktree before opening the panel. If it differs, tell the person which workspace to select and give the text view. A server without a desktop window also uses the text view. Report the Orca error when an explicit open request fails.

Publish a versioned JSON snapshot per panel and worktree in the local state directory. The snapshot includes `schemaVersion`, worktree ID, panel ID, revision, and data. Its data holds the same rows, questions, findings, controls, and status used for text. When a panel opens, its worker gets the current worktree via `workspace.readContext`, reads the latest snapshot and returns it through `orca.panels.handle`. The panel refreshes while open and ignores older revisions. The CLI needs no dev-only Orca command to update a panel. Use a worktree-local snapshot for remote hosts, subject to the remote bridge check below.

A panel uses `orca.plugin.request` for a named action with the worktree ID, expected revision, action ID, and typed input. The worker checks the current worktree and revision and calls the same command handler as the CLI through a fixed command and argument list. A stale action returns a refresh instruction. Reject unknown action names, paths outside their allowed roots, and input for a different worktree. Keep interview rounds and answers on the issue record. Text mode returns the questions and can record answers from a file. The same path checks their IDs and values. Require explicit human confirmation for resource deletion and close or merge actions that need it. Bind the confirmation to the worktree, action, target, and revision. A caller flag, a TTY, or a current revision alone does not prove human approval.

## Install layout

| Item | Location |
| --- | --- |
| Binary | `$HOME/.local/bin/ndev` by default. With `--prefix`, use `<prefix>/bin/ndev`. |
| Release files | `<prefix>/share/ndev` holds the CLI, scripts, skills, templates, wiki seed, profile data, and Orca plugin. The default prefix is `$HOME/.local`. |
| Install record | `<prefix>/share/ndev/install-manifest.json` lists owned files, versions, and hook entries. |
| Claude Code | `~/.claude/skills/ndev-*`, `~/.claude/agents/ndev-*.md`, and the hook entries above. Respect the active Claude config directory. |
| Codex | `~/.agents/skills/ndev-*`, `~/.codex/agents/ndev-*.toml`, and the hook entries above. Respect `CODEX_HOME` for agents and hooks. |
| opencode | `~/.config/opencode/skills/ndev-*`, `~/.config/opencode/agents/ndev-*.md`, and a server adapter under `~/.config/opencode/plugins/ndev/`. Respect `XDG_CONFIG_HOME`. |
| Profiles with no hooks | Paths and agent format from the profile file. Add the ndev session skill. |

Build a release with the CLI bootstrapping entry available before installation. The install plan lists paths, hook changes, and file conflicts before it writes. It refuses to replace a file it does not own. It writes staged files and the manifest so a retry can finish a partial install. Install shared files once for `all`. Use the existing rewriter for skill references and agent format. Apply each harness's supported role limits, and refuse to claim checks or limits that it does not support. A dry run reports the plan and has no side effects. Verification reads back the install paths and tests native discovery and hook execution.

With `--panels`, delegate to `orca plugin install <folder> --json`. If Orca asks for trust, return its next command with the fingerprint. The operator can rerun with `--approve`. Report the status of the harness install and the plugin install if one did complete. Include a test for rerun after Orca approval. The normal harness install can run without installing the panels.

## Work items and proof

Track this release with the linked sub-issues and their blocker links below. Use one worktree and [PR #65](https://github.com/neilellis/ndev/pull/65). Keep the PR in draft while work remains. A human merges. The stacked PR behavior above applies to epics that the CLI coordinates.

| Work item | Blocked by | Public tests |
| --- | --- | --- |
| [CLI core #67](https://github.com/neilellis/ndev/issues/67) | Spec review | Help, flags, JSON, process errors, repository and profile resolution. |
| [Workflow #68](https://github.com/neilellis/ndev/issues/68) | CLI core | Start, state transitions, guard inputs, retry, checks, and git history in local repo fixtures. |
| [Waits #66](https://github.com/neilellis/ndev/issues/66) | Workflow | One wait per call, timeout, cancellation, recovery, and state restored. |
| [Epic #71](https://github.com/neilellis/ndev/issues/71) | Workflow | GitHub graph, stack brief, remote route, phase gates, and rebase handoff. |
| [Triage #69](https://github.com/neilellis/ndev/issues/69) | Epic, waits | Group and clean decisions, worker receipts, refusal and retry. |
| [Fix-all-prs #70](https://github.com/neilellis/ndev/issues/70) | Waits, triage | Queue order, check SHA, worker report, retry and merge modes. |
| [Panes #72](https://github.com/neilellis/ndev/issues/72) | Fix-all-prs, triage | Plugin worker contracts, opened panel and text output, actions with stale revision. |
| [Hooks #73](https://github.com/neilellis/ndev/issues/73) | Panes, waits | Native event payloads, Git guard pass and deny cases, cleanup and watcher delivery. |
| [Installer #74](https://github.com/neilellis/ndev/issues/74) | Hooks | Dry run, repair, re-install, trust, and native discovery and hooks for each harness. |

Write a public regression test first. Confirm it fails for the intended reason, then run it again with the fix. Use local Git remotes for pushes and lease races. Use fakes for GitHub, Orca, and cloud writes in automated tests. Keep a small live test for bridge behavior that a fake cannot prove. Use temporary homes and temporary worktrees or repos for install and hook tests. Keep each harness's config and credential paths inside the test home, including explicit config environment variables. Keep secrets out of fixtures, panel state and check logs. Report passed, failed, skipped with reason, and not run as distinct results.

## Support and verification

- The install targets are Claude Code, Codex, and opencode v2. The installer trials used Claude Code 2.1.326, Codex 0.166.0, and opencode 2.3.0.
- Use a named action and a confirmation for workflow overrides and triage close. A harness hook's caller role gives no authority to override.
- Test the desktop panel with a connected remote worktree. A headless server uses text. Keep desktop remote panel parity open until the panel can read and change remote worktree state.
- The PR queue merges only when the project permits agent merge. Use `--no-merge` to leave green PRs for a person.
