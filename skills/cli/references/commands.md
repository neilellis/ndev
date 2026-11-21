# Native ndev command reference

Choose the operation here, then consult its current `--help` for flags and input files. Examples use placeholders such as `<issue>` and `<file>`; substitute real values. Run in the owning project worktree. The method and approval gates remain in the workflow and task skills.

## Project settings and guidance

| Command | When to use it |
| --- | --- |
| `ndev project status` | Read project identity, mode, steering, and missing setup before work. |
| `ndev project setup --repo <owner/name>` | Configure the repository. Use `--board` when a project board applies. |
| `ndev project init` | Initialize the project's ndev setup. |
| `ndev project mode` / `steering` | Read the setting. Supply a supported value only when changing it is intended. |
| `ndev project credentials --copy-from-main` | Copy the project's credential file into its worktree through the guarded path. Use `--init` to create one. |
| `ndev project guidance <kind> "<description>"` | Find approved guidance for a component, animation, library, or other supported kind. |
| `ndev project learn` | Start recording reusable lessons. |
| `ndev project report-workflow-bug --title "<title>" --details "<details>"` | Report a fault in ndev with evidence and a reproduction. |

## One issue or PR: flow

Use the entrypoint's stage table for the normal sequence. These commands handle entry, recovery, and side work.

| Command | When to use it |
| --- | --- |
| `ndev flow status --issue <issue>` | Inspect the recorded state and next action, especially after compaction or a handoff. |
| `ndev flow guide` | Read the full workflow instructions. |
| `ndev flow start <issue> --short-name <slug>` | Claim or resume work on an existing issue. Use its returned worktree. |
| `ndev flow create <slug> --description-file <file>` | File an issue and start work when the request has no issue yet. |
| `ndev flow repair --issue <issue> --pr <pr>` | Bind an isolated checkout to an existing open PR after satisfying the printed Git checks. |
| `ndev flow hotfix <slug> --issue <issue>` | Enter the urgent-fix route only when the task authorizes that route. |
| `ndev flow interview --round-file <json>` | Publish an interview round. Record answers with `--answers-file` or finish with `--finish`. |
| `ndev flow comment --issue <issue> --message-file <file>` | Record an issue or PR comment through the workflow interface. |
| `ndev flow push-draft --sha <full-reviewed-sha> --review "<result>"` | Publish the reviewed draft when that is the next action. It does not replace final review. |
| `ndev flow follow-up --mode issue_only --message-file <file>` | File separate work without starting another worker. Other modes can start work. |
| `ndev flow add-migration <name>` | Create and record a migration before it needs to run after merge. |
| `ndev flow request-secret <name>` | Locate or request a missing project secret through the supported path. |
| `ndev flow blocked --message "<blocker>"` / `unblock` | Record a blocker and resume when it is resolved. |
| `ndev flow mode` / `steering` | Inspect or intentionally change this workflow's mode or steering. |
| `ndev flow skip`, `goto`, `off`, `on` | Apply an authorized workflow-control decision. They are not routine failure recovery. |

`interview --finish` ends an active interview. `finished-interview` runs a base check in developing, planning, or hardening. It does not end an active interview.

`finished-development` starts review and the dead-code sweep. Do not launch duplicate reviewers. `finished-review` needs the review, sweep rulings, and remember result. `finished-smoke --skipped` and `finished-review --waive-review` apply only where the workflow permits the specific omission. Never invent confirmation or evidence.

## Wait for one condition

| Command | Condition |
| --- | --- |
| `ndev wait agent <dispatch-id>` | The named worker has finished. |
| `ndev wait process <pid>` | The process has ended. Inspect its own final status and log separately. |
| `ndev wait url <url>` | The URL satisfies the wait's availability check. It does not prove the page works. |
| `ndev wait command -- <executable> <args>` | A predicate command exits successfully. Keep arguments after `--` as data. |
| `ndev wait pr <target-pr> merged` | The target PR reaches the requested GitHub state. |
| `ndev wait issue closed <target-issue>` | The target issue reaches the requested state. Multiple targets are supported. |
| `ndev wait state <target-issue> <state>` | Another issue's workflow reaches the named state. |
| `ndev wait seconds <seconds>` | An intentional bounded delay is needed. |

Use `--issue <caller-issue>` or `--pr <caller-pr>` to identify the waiting workflow, not the dependency. Common wait flags are `--timeout`, `--period`, and `--attempts`. GitHub waits require a period of at least 60 seconds. Default timeout is 1,200 seconds. `flow unblock` can cancel an active bound wait. When a session watcher owns the PR checks, follow it instead of adding another wait. Outside that setup, follow the CLI's instruction to use one blocking wait for the current PR.

## Coordinate an epic

| Command | When to use it |
| --- | --- |
| `ndev epic start <epic>` | Bind or resume the coordinator. Record the original base, coordinator model, and suite roster for closing. |
| `ndev epic status <epic>` | Read phases, sub-issues, debt, and the next action. |
| `ndev epic import <epic> --issues-file <json> --evidence "<evidence>"` | Adopt existing issues with explicit classification and verified ownership. |
| `ndev epic next <epic>` | Compute the ready or stacked frontier before starting workers. |
| `ndev epic brief <epic> <sub> implementer` | Produce the worker brief and start command. Use `reviewer` for the review role. |
| `ndev epic issue <epic> <sub> <state>` | Record a sub-issue transition with its required worker, PR, verdict, or note. |
| `ndev epic phase <epic> <phase> --evidence "<evidence>"` | Finish the current phase with its required files and evidence. |
| `ndev epic debt <epic> --file <json>` | Record a skipped check, unreviewed merge, or overridden gate. |
| `ndev epic ruling <epic> <debt-key> --file <json>` | Record a reasoned disposition for a debt item. |
| `ndev epic skip`, `goto`, `off` | Apply an authorized phase-control decision. Closing cannot be bypassed. |

Closing uses `phase <epic> closing --closing-file <json>` with `--evidence`. It requires exact-SHA full-suite receipts on the clean default branch, a different-model whole-epic R-id review, and rulings on debt. Read the epic skills and workflow guide for the file schemas.

## Backlog and PR queues

| Command | When to use it |
| --- | --- |
| `ndev triage status` | Resume the recorded run without launching duplicate workers. |
| `ndev triage start --dry-run` | Preview issue collection before starting a new run. |
| `ndev triage start` | Begin authorized backlog coordination. Use `--sequential` or `--batch` for admission limits. |
| `ndev triage groups --file <json>` | Record the coordinator's issue groups. |
| `ndev triage launch` / `refresh` | Start admissible groups or reconcile worker receipts. |
| `ndev triage clean` | Start stale-issue review. Submit evidence with `clean-verdicts --file <json>`. |
| `ndev triage confirm --issue <issue> --revision <revision> close` | Record the human's closure decision. `keep` preserves the issue. |
| `ndev triage reset` | Reset the run only when that action is intended. |
| `ndev fix-prs status` | Inspect the recorded PR queue and current owner before acting. |
| `ndev fix-prs start --no-merge` | Start repairs without granting automatic merges. Plain `start` can dispatch and merge immediately. |
| `ndev fix-prs pause` / `resume` | Stop admission or resume the existing queue. |
| `ndev fix-prs skip <pr>` / `retry <pr>` | Apply an intended queue decision after checking existing attempts. |
| `ndev fix-prs report <pr> pushed --worktree <path>` | Report a completed push. Use `blocked --reason "<reason>"` for a blocker. |

Inspect existing workers before starting or resuming a queue. CLI state and Orca worker ownership must agree. Use the triage and fix-all-prs skills for coordination policy.

## UI, files, and worktree resources

| Command | When to use it |
| --- | --- |
| `ndev pane view --open` | Open the worktree's view in Orca. Omit `--open` for text data. |
| `ndev pane responsive-matrix --open` | Inspect the responsive comparison. |
| `ndev pane screenshot <url> --viewport 390x844 --full-page` | Capture a requested page and viewport. Add supported schemes or viewports as needed. |
| `ndev pane files create <name>` / `copy-from-main <name>` | Create or copy a worktree file through the guarded file action. |
| `ndev pane resources <action> <args>` | Stop or forget recorded resources. Check help for `stop-server`, `stop-stack`, `stop-all`, and `forget`. |

Inspect the captured image before claiming visual verification. A locked desktop or failed capture leaves that check unrun. Do not discard an unrelated resource to clear a conflict.

## Remote servers

Use `ndev remote status` and `list` to inspect saved servers. `set <server>` selects one; `off` clears selection. Selection alone does not start a remote worker.

`create`, `import`, `resize`, and `remove` change remote infrastructure or its registration. Use them only for an authorized infrastructure task. Check the command's current help and follow its confirmation contract. Do not add `--yes` merely to avoid a refusal.

## Fresh-reader documentation checks

Start with `ndev walk-doc start <path-or-url>`, then inspect `status`. Use `ask`, `answer <ask-number> "<text>"`, or `tip` to exchange reader guidance. `restart` starts another attempt, `stop` stops the walk, and `finish` closes it with a summary.

Reader-side `report`, `enhance`, `record`, `reply`, and `escalate` take JSON files. `done <summary>` reports the reader's completion. Follow the walk's role and attempt boundaries instead of submitting a report as another reader.

## Installation and harness integration

| Command | When to use it |
| --- | --- |
| `ndev install <harness> --dry-run` | Preview the files and conflicts before an authorized install. |
| `ndev install <harness>` | Install or update ndev for `claude`, `codex`, or `opencode`. `all` selects all built-in harnesses. |
| `ndev install verify <harness>` | Verify the installed release, skills, agents, and hook configuration. |
| `ndev chat-guard status` / `on` / `off` | Inspect or intentionally change native Orca idle-send protection. |
| `ndev watch --once` | Perform one watcher tick for an Orca terminal session. Omit `--once` only when a watcher is intended and none already owns the session. |
| `ndev hook <event> --harness <harness>` | Dispatch a native harness event with the expected payload. This is adapter plumbing, not a replacement for workflow commands. |

`install` uses the release that supplies the command. To install new source, invoke that checkout's `bin/ndev`. Do not run a stale installed binary and assume it contains the new skill. `--prefix` selects the release destination. Panel installation is separate through `--panels` and any required approval fingerprint.
