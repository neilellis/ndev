# Native ndev command reference

Choose the operation here, then consult its current `--help` for flags and input files. Examples use placeholders such as `<issue>` and `<file>`; substitute real values. Run in the owning project worktree. The method and approval gates remain in the workflow and task skills.

## Project settings and guidance

| Command | When to use it |
| --- | --- |
| `ndev project status` | Read project identity, mode, steering, and missing setup before work. |
| `ndev project setup --repo <owner/name>` | Configure the repository. Use `--board` when a project board applies. |
| `ndev project migrate-config` | Move the old `.neil-dev.json` to `.ndev.json`, with `git mv` when Git tracks it. It refuses when both files exist and differ. |
| `ndev project dev-servers [start <name>]` | List the dev servers in `.ndev.json` (`devServers`). `start` boots one, waits until its `ready` URL answers or path exists, and records it so the session end stops it. A server that exits or is not ready in time fails with its command, exit code and the end of its log. |
| `ndev project init` | Initialize the project's ndev setup. |
| `ndev project mode` / `steering` | Read the setting. Supply a supported value only when changing it is intended. |
| `ndev project credentials --copy-from-main` | Copy the project's credential file into its worktree through the guarded path. Use `--init` to create one. |
| `ndev project guidance <kind> "<description>"` | Find approved guidance for a component, animation, library, or other supported kind. |
| `ndev project learn` | Start recording reusable lessons. |
| `ndev project report-workflow-bug --title "<title>" --details "<details>"` | Report a fault in ndev with evidence and a reproduction. |
| `ndev project pr-new --title "<title>" --body-file <file> [--base <branch>] [--head <branch>] [--ready]` | Open a pull request, a draft unless `--ready` is given. It returns the number and URL. |
| `ndev project issue-new --title "<title>" --body-file <file> [--label <label>]... [--milestone <number>] [--type <type>]` | File an issue. It returns the number and URL. |

## One issue or PR: flow

Use the entrypoint's stage table for the normal sequence. These commands handle entry, recovery, and side work.

| Command | When to use it |
| --- | --- |
| `ndev flow status --issue <issue>` | Inspect the recorded state and next action, especially after compaction or a handoff. |
| `ndev flow guide` | Read the full workflow instructions. |
| `ndev flow start <issue> --short-name <slug>` | Claim or resume work on an existing issue. Use its returned worktree. |
| `ndev flow create <slug> --description-file <file>` | File an issue and start work when the request has no issue yet. |
| `ndev flow repair --issue <issue> --pr <pr>` | Bind an isolated checkout to an existing open PR after satisfying the printed Git checks. It keeps the used review rounds, unless the earlier PR is a different one that is merged. |
| `ndev flow hotfix <slug> --issue <issue>` | Enter the urgent-fix route only when the task authorizes that route. |
| `ndev flow interview --round-file <json>` | Publish an interview round. Record answers with `--answers-file` or finish with `--finish`. |
| `ndev flow comment --issue <issue> --message-file <file>` | Record an issue or PR comment through the workflow interface. |
| `ndev flow push-draft --sha <full-reviewed-sha> --review "<result>"` | Publish the reviewed draft when that is the next action. It does not replace final review. |
| `ndev flow follow-up --mode issue_only --message-file <file>` | File separate work without starting another worker. Other modes can start work. |
| `ndev flow add-migration <name>` | Create and record a migration before it needs to run after merge. |
| `ndev flow request-secret <name>` | Locate or request a missing project secret through the supported path. |
| `ndev flow authorise-review --head <full HEAD commit id> --reason "<why>"` | After the third review round, review one fixed commit again. It needs a clean worktree and a phrase typed in a terminal in Orca. Ask the human to run it, and never type the phrase yourself. |
| `ndev flow blocked --message "<blocker>"` / `unblock` | Record a blocker and resume when it is resolved. |
| `ndev flow mode` / `steering` | Inspect or intentionally change this workflow's mode or steering. |
| `ndev flow skip`, `goto`, `off`, `on` | Apply an authorized workflow-control decision. They are not routine failure recovery. |

`interview --finish` ends an active interview. `finished-interview` runs a base check in developing, planning, or hardening. It does not end an active interview.

`finished-development` starts review and the dead-code sweep. Do not launch duplicate reviewers. `finished-review` needs the review, sweep rulings, and remember result. `finished-smoke --skipped` and `finished-review --waive-review` apply only where the workflow permits the specific omission. Never invent confirmation or evidence.

After three review rounds no more reviews start. For a substantive finding, commit the fix and ask the human to run `ndev flow authorise-review`. Then wait with `ndev wait agent dispatch:<id>` and run `finished-review`. It passes only in a clean worktree, when each of those reviewers succeeded, its chat has no gaps, and every line with `ndev-review-verdict` in its assistant messages is exactly `ndev-review-verdict: approve <full HEAD commit id>`. An objection that was read stays with the commit. A later commit needs a new authorisation. Do not message a reviewer about its verdict, and do not edit the worktree while it runs.

## Requirement models

A model has a manifest beside it: `docs/formal/models/<name>.json`. The `requirements-model` skill writes both. `kb/requirements.md` describes the manifest.

| Command | When to use it |
| --- | --- |
| `ndev requirements model-check [<manifest>...]` | Check a model against its manifest, its records and the cited code. With no name, it checks each manifest in `docs/formal/models`. A pass is a bounded random search, not a proof. |
| `ndev requirements model-pin <manifest>...` | Write the pin of each code reference. Run it only after you read the cited code against each action. The cited lines must match the last commit. |

## Requirement verification

A verification file, `docs/formal/verification/REQ-NNNN.json`, holds the linked tests of a record. The `requirements-verify` skill has the procedure. `kb/requirements.md` describes the file and the states.

| Command | When to use it |
| --- | --- |
| `ndev requirements verify-brief <REQ-NNNN>` | Print what a fresh judge gets: the Statement, the commit, the linked files and the checks. Commit the covered files and the verification file first. |
| `ndev requirements verify-judge <REQ-NNNN> --commit <sha> --verdict <v> --by "<who>" --evidence <file>` | Record the verdict, `no-counter-example` or `counter-example`. Only after a fresh agent judged the brief. Then commit the verification file. `--overrule "<reason>"` records that a human rejects a current counter-example. `--base <ref>` also reads the counter-example at the merge base. |
| `ndev requirements verify (<REQ-NNNN>... \| --all \| --base <git ref>) [--report <file>]` | Give each requirement its state at the last commit. It needs a clean worktree. It exits 0 only when each one is `verified`. A judgement is an opinion, not a proof. |

## GitHub reads and edits

These commands go through the internal GitHub layer. It runs the `gh` command first and uses REST when that fails. Each command prints one JSON object on each line. `--json` gives them as `lines`. Run `ndev github --help` for the full list.

| Command | When to use it |
| --- | --- |
| `ndev github issue-read <issue>` / `pr-read <pr>` | Read an issue or a PR. |
| `ndev github issue-edit <issue> --body-file <file>` / `pr-edit <pr> --body-file <file>` | Rewrite the title or body of an issue or PR. |
| `ndev github pr-ready <pr>` | Mark a draft PR ready for review when no workflow does this for you. |
| `ndev github label <n> <label>` / `unlabel` / `labelled <label>` | Add or remove a label, or list the open issues and PRs with a label. |
| `ndev github feedback <issue> <pr>` | Read the comments, reviews and inline comments in one list. |
| `ndev github subissues link <parent> <child>...` / `list <parent>` | Link sub-issues to a parent issue, or list them. |
| `ndev github blocked-by add <issue> <blocker>` / `list` / `remove` / `blocking` | Record or read a dependency on work that is not yours. |
| `ndev github board ready` / `awaiting` / `items [<column>]` / `move <item-id> <status>` / `add <issue>` | Read or move cards on the project board. A status is `backlog`, `ready`, `progress`, `review`, `awaiting`, `done` or a column name. |
| `ndev github comment <n> --body <text>` | Comment on an issue or a PR, for example `Carried by #<pr>` on a sub-issue that your PR carries. |
| `ndev github dump issue\|pr <n> [--out <dir>]` | Write an issue or a PR, with its comments, images and diff, to one markdown file. |
| `ndev github merge-main [--dry-run] [--pr <n>]...` | Merge the default branch into each open PR branch, one worktree for each. |
| `ndev github unpushed` | List local commits that are on no remote. Run it before you discard a branch or a worktree. |

## Wait for one condition

| Command | Condition |
| --- | --- |
| `ndev wait agent <dispatch-id>` | The named worker has finished. |
| `ndev wait process <pid>` | The process has ended. Inspect its own final status and log separately. |
| `ndev wait url <url>` | The URL satisfies the wait's availability check. It does not prove the page works. |
| `ndev wait command -- <executable> <args>` | A predicate command exits successfully. Keep arguments after `--` as data. Its timeout can be up to 21600 seconds. |
| `ndev wait pr <target-pr> merged` | The target PR reaches the requested GitHub state. |
| `ndev wait checks <pr>` | Every check on the PR's current head has finished. Only the newest run of each check counts. It exits 1 with each failed check and its log URL, and moves no workflow state. The default timeout is 3600 seconds, at most 21600. |
| `ndev wait branch-ci <branch>` | The newest head commit of the branch, such as `main`, has settled CI. It follows a new head when a merge cancels the runs of the old one, and counts only the newest run of each workflow. It returns each workflow's conclusion and URL, exits 1 with each failed workflow and its log URL, and moves no workflow state. The default timeout is 3600 seconds, at most 21600. |
| `ndev wait issue closed <target-issue>` | The target issue reaches the requested state. Multiple targets are supported. |
| `ndev wait state <target-issue> <state>` | Another issue's workflow reaches the named state. |
| `ndev wait seconds <seconds>` | An intentional bounded delay is needed. |

Use `--issue <caller-issue>` or `--pr <caller-pr>` to identify the waiting workflow, not the dependency. Common wait flags are `--timeout`, `--period`, and `--attempts`. GitHub waits require a period of at least 60 seconds. Default timeout is 1,200 seconds, and the most for other waits. A workflow record that is off or done does not hold or refuse a wait. `flow unblock` can cancel an active bound wait. When a session watcher owns the PR checks, follow it instead of adding another wait. Outside that setup, follow the CLI's instruction to use one blocking wait for the current PR.

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
| `ndev pane screenshot <url> --viewport 390x844 --full-page` | Capture a requested page and viewport. Add supported schemes or viewports as needed. With `--full-page`: one image of the whole page, after a scroll pass. `--wait-seconds` pauses after the load and again after the pass. Read the warnings. Needs Orca 1.4.274 or later. |
| `ndev pane files create <name>` / `copy-from-main <name>` | Create or copy a worktree file through the guarded file action. |
| `ndev pane resources <action> <args>` | Stop or forget recorded resources. Check help for `stop-server`, `stop-stack`, `stop-all`, and `forget`. |

Inspect the captured image before claiming visual verification. A locked desktop or failed capture leaves that check unrun. Do not discard an unrelated resource to clear a conflict.

## Remote servers

Use `ndev remote status` and `list` to inspect saved servers. `set <server>` selects one; `off` clears selection. Selection alone does not start a remote worker.

`create`, `import`, `resize`, and `remove` change remote infrastructure or its registration. Use them only for an authorized infrastructure task. Check the command's current help and follow its confirmation contract. Do not add `--yes` merely to avoid a refusal.

## Fresh-reader documentation checks

Start with `ndev walk-doc start <path-or-url>`, then inspect `status`. Use `ask`, `answer <ask-number> "<text>"`, or `tip` to exchange reader guidance. `restart` starts another attempt, `stop` stops the walk, and `finish` closes it with a summary.

Reader-side `report`, `enhance`, `record`, `reply`, and `escalate` take JSON files. `done <summary>` reports the reader's completion. Follow the walk's role and attempt boundaries instead of submitting a report as another reader.

## Proof

| Command | When to use it |
| --- | --- |
| `ndev proof plan --base <ref> [--pr <n> \| --event <file>] [--proven <sha>]` | Show what Proof checks for this branch: the tier and its reasons, `run` or `skip` for each check, and whether the whole run is skipped. It reads the settings from the base ref and runs no agent. |

## Installation and harness integration

| Command | When to use it |
| --- | --- |
| `ndev install <harness> --dry-run` | Preview the files and conflicts before an authorized install. |
| `ndev install <harness>` | Install or update ndev for `claude`, `codex`, `opencode`, or `antigravity`. `all` selects all built-in harnesses. |
| `ndev install verify <harness>` | Verify the installed release, skills, agents, and hook configuration. |
| `ndev chat-guard status` / `on` / `off` | Inspect or change native Orca idle-send protection for this project (`chatGuard` in `.ndev.json`; off by default). |
| `ndev watch --once` | Perform one watcher tick for an Orca terminal session. Omit `--once` only when a watcher is intended and none already owns the session. |
| `ndev hook <event> --harness <harness>` | Dispatch a native harness event with the expected payload. This is adapter plumbing, not a replacement for workflow commands. |

`install` uses the release that supplies the command. To install new source, invoke that checkout's `bin/ndev`. Do not run a stale installed binary and assume it contains the new skill. `--prefix` selects the release destination. Panel installation is separate through `--panels` and any required approval fingerprint.
