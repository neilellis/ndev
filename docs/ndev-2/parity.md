# ndev 2.0 parity list

The source paths are relative to `neilellis/ndev-plugin` at commit `b6e2547a66ae63c87acf86857102a2b09f92802f`, except where a row names the Orca plugin. The MCP inventory comes from the registration arrays. The command and hook inventory comes from the registered handlers. The skill and agent inventory comes from files with their entry definitions.

The [spec](spec.md#work-items-and-proof) links the nine sub-issues. This work belongs to [epic #64](https://github.com/neilellis/ndev/issues/64). Tests in this list are acceptance cases. A test link names the suite that ran for the stated behavior. Rows marked **Drop** give the reason and the test of the replacement or removal.

## MCP tools

| Plugin tool | Source | ndev 2.0 | Work item | Acceptance test |
| --- | --- | --- | --- | --- |
| `create` | `hooks/workflow/tools.ts` | `ndev flow create` | Workflow | File one issue and start it with its mode. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `comment` | `hooks/workflow/tools.ts` | `ndev flow comment` | Workflow | Post to the named issue or PR without a workflow. Reject both targets. |
| `started` | `hooks/workflow/tools.ts` | `ndev flow start` | Workflow | Claim the worktree and draft PR once. Resume without a duplicate. Refuse takeover from a live owner. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `interview` | `hooks/workflow/tools.ts`, `hooks/workflow/interview-model.ts` | `ndev flow interview` | Workflow | Save and answer a round by question ID. Reject stale answers. Advance only when the interview finishes. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `setSteering` | `hooks/workflow/tools.ts` | `ndev flow steering auto --reason` | Workflow | Log the reason on the issue and PR. Refuse hack mode. |
| `finishedPlan` | `hooks/workflow/tools.ts` | `ndev flow finished-plan` | Workflow | Read the plan, add it to the PR, and enter development. |
| `checkpoint` | `hooks/workflow/tools.ts` | `ndev flow checkpoint` | Workflow | Commit only the named files, run checks, and retry a held commit without a duplicate. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `finishedInterview` | `hooks/workflow/tools.ts` | `ndev flow finished-interview` | Workflow | Run the base check for light and heavy modes. Return a failed check for retry. |
| `hotfix` | `hooks/workflow/tools.ts` | `ndev flow hotfix` | Workflow | File or resume the urgent issue with a draft PR, leaving the current workflow bound. Exercise direct-commit mode. |
| `finishedHacking` | `hooks/workflow/tools.ts` | `ndev flow finished-hacking` | Workflow | Move the approved hack to hardening and keep its commits local. |
| `finishedDevelopment` | `hooks/workflow/tools.ts` | `ndev flow finished-development` | Workflow | Hold the commit for review. Start review and lesson work when the last issue on the PR finishes. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `finishedReview` | `hooks/workflow/tools.ts` | `ndev flow finished-review` | Workflow | Read the review, run the pre-ready check, push, and mark the PR ready. |
| `finishedChecks` | `hooks/workflow/tools.ts` | `ndev flow finished-checks` | Workflow | Reject red, pending, or old-head evidence. Accept green checks on HEAD. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `finishedSmoke` | `hooks/workflow/tools.ts` | `ndev flow finished-smoke` | Workflow | Post a report for HEAD. Refuse a skip in hack mode. |
| `finishedRevision` | `hooks/workflow/tools.ts` | `ndev flow finished-revision` | Workflow | Refuse feedback with no answer and return to checks after answers. |
| `blocked` | `hooks/workflow/tools.ts` | `ndev flow blocked` | Workflow | Save the prior state, set the Orca flag, and send one persistent alert. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `unblocked` | `hooks/workflow/tools.ts` | `ndev flow unblock` | Workflow | Withdraw the alert and restore the prior state. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `done` | `hooks/workflow/tools.ts` | `ndev flow done` | Workflow | List every open gate. When complete, honor the merge setting. |
| `followUp` | `hooks/workflow/tools.ts` | `ndev flow follow-up` | Workflow | Run each mode. Pass existing issues to one worker and PR without filing duplicates. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `addMigration` | `hooks/workflow/tools.ts` | `ndev flow add-migration` | Workflow | Create a named migration, list it on the PR, and keep SQL at the new version after a rename. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `reportWorkflowBug` | `hooks/workflow/tools.ts`, `hooks/workflow/bug-report.ts` | `ndev project report-workflow-bug` | Workflow | Send the reproduction to the ndev maintainer route. Deduplicate repeated faults and enforce the rate limit. |
| `iNeedA` | `hooks/workflow/tools.ts`, `hooks/workflow/i-need-a.ts` | `ndev project guidance` | Workflow | Return the configured suggestions for each kind and reject an invalid kind. [CLI test](../../tests/ndev-cli.test.mjs) |
| `screenshot` | `hooks/workflow/tools.ts`, `hooks/workflow/screenshot.ts` | `ndev pane screenshot` | Panes | Save each viewport and scheme. Close the tab after success and leave it open for login. [Pane test](../../tests/ndev-panes.test.mjs) |
| `waitForSubAgent` | `hooks/workflow/tools.ts` | `ndev wait agent` | Waits | Wait for the named Orca worker or agent to finish. Report a lost dispatch. |
| `waitForURL` | `hooks/workflow/tools.ts` | `ndev wait url` | Waits | Wait through a non-2xx response and return on a 2xx response. |
| `waitForProcessEnd` | `hooks/workflow/tools.ts` | `ndev wait process` | Waits | Observe PID exit and report that the command result comes from its log or result file. |
| `waitForSeconds` | `hooks/workflow/tools.ts` | `ndev wait seconds` | Waits | Wait for a set time and restore the original state. [Wait test](../../tests/ndev-waits.test.mjs) |
| `waitFor` | `hooks/workflow/tools.ts` | `ndev wait command` | Waits | Retry a nonzero exit. Enforce the attempt, child time, and overall limits. [Wait test](../../tests/ndev-waits.test.mjs) |
| `waitForPR` | `hooks/workflow/tools.ts` | `ndev wait pr` | Waits | Observe each supported PR state with a GitHub-safe period. Keep caller and target IDs distinct. |
| `waitForIssue` | `hooks/workflow/tools.ts` | `ndev wait issue` | Waits | Wait until all named issues reach the requested state. |
| `waitForState` | `hooks/workflow/tools.ts` | `ndev wait state` | Waits | Read another worktree without GitHub. Wait for a missing record and accept a later reachable phase. |
| `status` | `hooks/workflow/tools.ts` | `ndev flow status` | Workflow | Resolve issue, PR, or session and give the next step without writing. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| `requestSecret` | `hooks/workflow/tools.ts`, `hooks/workflow/secrets.ts` | `ndev flow request-secret` | Workflow | Find the first source and print only the path and line. |
| `epicStarted` | `hooks/workflow/epic.ts` | `ndev epic start` | Epic | Create or resume an epic, bind the coordinator, and suspend the issue workflow for that session. [Epic test](../../tests/ndev-epic.test.mjs) |
| `epicPhase` | `hooks/workflow/epic.ts` | `ndev epic phase` | Epic | Validate phase evidence, files, and the issue graph before a move. [Epic test](../../tests/ndev-epic.test.mjs) |
| `epicNext` | `hooks/workflow/epic.ts` | `ndev epic next` | Epic | Report work that can start, is active, or waits, under the parallel limit. [Epic test](../../tests/ndev-epic.test.mjs) |
| `epicBrief` | `hooks/workflow/epic.ts` | `ndev epic brief` | Epic | Write the brief and return Orca worker arguments for each role. [Epic test](../../tests/ndev-epic.test.mjs) |
| `epicIssue` | `hooks/workflow/epic.ts` | `ndev epic issue` | Epic | Enforce moves and evidence. Store the active worker, PR, and workspace. [Epic test](../../tests/ndev-epic.test.mjs) |
| `epicStatus` | `hooks/workflow/epic.ts` | `ndev epic status` | Epic | Show the state, next step, and sub-issues without a write. |
| `triage_groups` | `hooks/triage.tsx` | `ndev triage groups` | Triage | Reject a duplicate or missing issue. Accept a full partition and eligible screened issues. [Triage test](../../tests/ndev-triage.test.mjs) |
| `clean_verdicts` | `hooks/triage.tsx` | `ndev triage clean-verdicts` | Triage | Require one verdict per issue and evidence for each proposed close. [Triage test](../../tests/ndev-triage.test.mjs) |
| `report` | `hooks/fix-all-prs.tsx` | `ndev fix-prs report` | Fix-all-prs | Take a pushed or blocked report for the current PR and refuse another PR. [Queue test](../../tests/ndev-fix-prs.test.mjs) |
| `walk_report` | `hooks/walk-doc/index.tsx` | `ndev walk-doc report` | Panes | Save a finding from the reader and hold that reader for a reply. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| `walk_enhance` | `hooks/walk-doc/index.tsx` | `ndev walk-doc enhance` | Panes | Save a suggestion and let the reader proceed. |
| `walk_record` | `hooks/walk-doc/index.tsx` | `ndev walk-doc record` | Panes | Accept media in the run folder and reject files outside it. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| `walk_answer` | `hooks/walk-doc/index.tsx` | `ndev walk-doc answer` | Panes | Send the answer to the parent for the named open question. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| `walk_done` | `hooks/walk-doc/index.tsx` | `ndev walk-doc done` | Panes | Store the reader's completion and send the summary. |
| `walk_reply` | `hooks/walk-doc/index.tsx` | `ndev walk-doc reply` | Panes | Resume the same reader, start a fresh reader, or record a note as directed. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| `walk_escalate` | `hooks/walk-doc/index.tsx` | `ndev walk-doc escalate` | Panes | Send the question and the steps tried to the human. |
| `walk_finish` | `hooks/walk-doc/index.tsx` | `ndev walk-doc finish` | Panes | Write the report, stop the run resources, and report completion. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| `walk_ask` | `hooks/walk-doc/index.tsx` | `ndev walk-doc ask` | Panes | Send a numbered question while the reader keeps working. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| `walk_status` | `hooks/walk-doc/index.tsx` | `ndev walk-doc status` | Panes | Return phase, attempt, findings, copy pages, and denials in JSON. [Walk test](../../tests/ndev-walk-doc.test.mjs) |

## Slash commands

| Plugin command | Source | ndev 2.0 | Work item | Acceptance test |
| --- | --- | --- | --- | --- |
| `/dev` | `hooks/register.ts` | `ndev project status`, `ndev --help` | CLI core | Show current settings and the setup command when values are absent. |
| `/dev help` | `hooks/register.ts` | `ndev --help` | CLI core | List groups and show help for each group and command. [CLI test](../../tests/ndev-cli.test.mjs) |
| `/dev setup` | `hooks/register.ts`, `hooks/setup.ts` | `ndev project setup` | CLI core | Save the GitHub repo and board or the named opt-outs. [CLI test](../../tests/ndev-cli.test.mjs) |
| `/dev mode` | `hooks/register.ts`, `hooks/worktree-settings.ts` | `ndev project mode` | CLI core | Toggle light and heavy. Set hack by name and refuse it in auto. [CLI test](../../tests/ndev-cli.test.mjs) |
| `/dev steering` | `hooks/register.ts` | `ndev project steering` | CLI core | Toggle or set steering at the right scope. Refuse auto in hack. [CLI test](../../tests/ndev-cli.test.mjs) |
| `/dev-mode` | `hooks/register.ts` | **Drop** slash alias. Use `ndev project mode`. | CLI core | Show the replacement in help. |
| `/dev-steering` | `hooks/register.ts` | **Drop** slash alias. Use `ndev project steering`. | CLI core | Show the replacement in help. |
| `/dev-setup` | `hooks/register.ts` | **Drop** slash alias. Use `ndev project setup`. | CLI core | Show the replacement in help. |
| `/learn` | `hooks/register.ts`, `hooks/learn.ts` | `ndev project learn`, `ndev-dev-wiki` | Hooks | Return the lesson workflow and choose between project and shared wiki. |
| `/dev export` | `hooks/export.ts`, `scripts/export/export.mjs` | `ndev install` and `--dry-run` | Installer | Plan and install for each harness from one source. Verify a profile with no hooks. [Installer test](../../scripts/export/tests/ndev-install.test.mjs) |
| `/dev triage`, `/dev triage status` | `hooks/triage.tsx` | `ndev triage status` | Triage | Show phase, groups, last activity, and an open question. |
| `/dev triage start` | `hooks/triage.tsx` | `ndev triage start` | Triage | Exercise board and open sets, filters, agent and server choice, batch size, and a dry run with no writes. [Triage test](../../tests/ndev-triage.test.mjs) |
| `/dev triage clean` | `hooks/triage.tsx` | `ndev triage clean`, `ndev triage confirm` | Triage | Gather evidence by chunk and require human confirmation per issue before close. [Triage test](../../tests/ndev-triage.test.mjs) |
| `/dev triage launch` | `hooks/triage.tsx` | `ndev triage launch` | Triage | Start a saved dry plan. Report a partial launch and its Orca Run ID. [Triage test](../../tests/ndev-triage.test.mjs) |
| `/dev triage refresh` | `hooks/triage.tsx` | `ndev triage refresh` | Triage | Read worker status and PRs from Orca and GitHub. |
| `/dev triage reset` | `hooks/triage.tsx` | `ndev triage reset` | Triage | Clear local triage state and keep the Orca Run record. |
| `/dev remote` without an argument | `hooks/remote.ts` | `ndev remote status` | Epic | Report the selected server or the unset state. Diagnose a stale ID. |
| `/dev remote <server>` | `hooks/remote.ts`, `hooks/remote-store.ts` | `ndev remote set` | Epic | Resolve ID, name, or recipe ID and save by project. Refuse ambiguity. [Remote test](../../tests/ndev-remote.test.mjs) |
| `/dev remote list` | `hooks/remote.ts` | `ndev remote list` | Epic | List server IDs and mark the saved choice. |
| `/dev remote off` | `hooks/remote.ts` | `ndev remote off` | Epic | Clear this project's choice. [Remote test](../../tests/ndev-remote.test.mjs) |
| `/dev remote create` | `hooks/remote.ts`, `hooks/remote-host.ts` | `ndev remote create` | Epic | Refuse an unnamed billing context or absent confirmation. Verify a labeled server and host key with fakes. |
| `/dev remote remove` | `hooks/remote.ts`, `hooks/remote-host.ts` | `ndev remote remove` | Epic | Refuse an unmanaged host. Test snapshot and IP retention and the explicit forget path. [Remote test](../../tests/ndev-remote.test.mjs) |
| `/dev remote import` | `hooks/remote-import.ts` | `ndev remote import` | Epic | Require the billing context and host-key proof. Record managed resources. |
| `/dev remote resize` | `hooks/remote-resize.ts` | `ndev remote resize` | Epic | Reject an unknown worker mapping. Resume remote workers after resize and report failures. |
| `/flow`, `/flow status` | `hooks/workflow/command.ts` | `ndev flow status` | Workflow | Report binding, state, mode, next step, and watcher status. |
| `/flow help` | `hooks/workflow/command.ts` | `ndev flow --help` | CLI core | List flow commands and their target flags. |
| `/flow guide` | `hooks/workflow/command.ts` | `ndev flow guide` | Workflow | Read the bundled workflow guide and diagram reference. |
| `/flow mode` | `hooks/workflow/command.ts` | `ndev flow mode` | Workflow | Read and change an issue override with the expected precedence. |
| `/flow steering` | `hooks/workflow/command.ts` | `ndev flow steering` | Workflow | A human sets interactive mode and an agent cannot set it back. |
| `/flow skip` | `hooks/workflow/command.ts` | `ndev flow skip` | Workflow | Record the human's reason and move only to the next phase. |
| `/flow goto` | `hooks/workflow/command.ts` | `ndev flow goto` | Workflow | Validate the target and log a human override. |
| `/flow unblock` | `hooks/workflow/command.ts` | `ndev flow unblock` | Waits | Restore state and cancel the specific wait. [Wait test](../../tests/ndev-waits.test.mjs) |
| `/unblock <message>` | `hooks/workflow/command.ts` | `ndev flow unblock <answer>` | Waits | End a wait from a second terminal and deliver the answer to the owner. [Wait test](../../tests/ndev-waits.test.mjs) |
| `/flow off` | `hooks/workflow/command.ts` | `ndev flow off` | Workflow | Disable a workflow and keep its state. |
| `/flow on` | `hooks/workflow/command.ts` | `ndev flow on` | Workflow | Enable a stopped workflow and restore guidance. |
| `/flow off project` | `hooks/workflow/command.ts` | `ndev flow off --project` | Workflow | Persist the project setting and quiet its watchers. |
| `/flow on project` | `hooks/workflow/command.ts` | `ndev flow on --project` | Workflow | Persist the project setting and resume eligible workflows. |
| `/flow epic`, `/flow epic status` | `hooks/workflow/epic.ts` | `ndev epic status` | Epic | Report the active epic and the next action. |
| `/flow epic <issue>` | `hooks/workflow/epic.ts` | `ndev epic start <issue>` | Epic | Resume the named epic and give the coordinator the next step. |
| `/flow epic <title>` | `hooks/workflow/epic.ts` | `ndev epic start --title` | Epic | File and start one epic for the title. |
| `/flow epic skip` | `hooks/workflow/epic.ts` | `ndev epic skip` | Epic | Save the human's evidence and notify the coordinator. |
| `/flow epic goto` | `hooks/workflow/epic.ts` | `ndev epic goto` | Epic | Reject an invalid phase and notify on a valid move. |
| `/flow epic off` | `hooks/workflow/epic.ts` | `ndev epic off` | Epic | Leave the record and restore normal workflow. |
| `/fix-prs`, `/fix-prs start` | `hooks/fix-all-prs.tsx` | `ndev fix-prs start` | Fix-all-prs | Start with the oldest open PR and keep green PRs for a human with `--no-merge`. [Queue test](../../tests/ndev-fix-prs.test.mjs) |
| `/fix-prs status` | `hooks/fix-all-prs.tsx` | `ndev fix-prs status` | Fix-all-prs | Show the current PR and next action. |
| `/fix-prs pause` | `hooks/fix-all-prs.tsx` | `ndev fix-prs pause` | Fix-all-prs | Pause dispatch and keep the queue. [Queue test](../../tests/ndev-fix-prs.test.mjs) |
| `/fix-prs resume` | `hooks/fix-all-prs.tsx` | `ndev fix-prs resume` | Fix-all-prs | Restore the queue from disk and continue. |
| `/fix-prs skip` | `hooks/fix-all-prs.tsx` | `ndev fix-prs skip` | Fix-all-prs | Skip the named PR and pick the next one. [Queue test](../../tests/ndev-fix-prs.test.mjs) |
| `/fix-prs retry` | `hooks/fix-all-prs.tsx` | `ndev fix-prs retry` | Fix-all-prs | Clear the wait state for the named PR and retry it. [Queue test](../../tests/ndev-fix-prs.test.mjs) |
| `/view` | `hooks/view.tsx` | `ndev pane view` | Panes | Show the same worktree facts in text and in the panel. [Pane test](../../tests/ndev-panes.test.mjs) |
| `/responsive-matrix` | `hooks/responsive-check.tsx` | `ndev pane responsive-matrix` | Panes | Load the newest run and give the matrix and its evidence paths. [Pane test](../../tests/ndev-panes.test.mjs) |
| `/walk-doc <path-or-url>` | `hooks/walk-doc/index.tsx` | `ndev walk-doc start` | Panes | Start a reader on the named path or URL with persona and recording flags. |
| `/walk-doc ask` | `hooks/walk-doc/index.tsx` | `ndev walk-doc ask` | Panes | Send a question to the current reader and record its ID. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| `/walk-doc restart` | `hooks/walk-doc/index.tsx` | `ndev walk-doc restart` | Panes | Replace the reader and keep the run history. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| `/walk-doc tip` | `hooks/walk-doc/index.tsx` | `ndev walk-doc tip` | Panes | Save the tip for later readers and deliver it to the current one. |
| `/walk-doc stop` | `hooks/walk-doc/index.tsx` | `ndev walk-doc stop` | Panes | Stop reader resources and keep the report and evidence. |

## Hooks and nudges

| Plugin behavior | Source | ndev 2.0 | Work item | Acceptance test |
| --- | --- | --- | --- | --- |
| Session start and feature setup | `hooks/register.ts`, `hooks/worktree-settings.ts` | `ndev hook session-start` | Hooks | Bind the session, ensure worktree settings, and report setup failure with a repair. |
| GitHub setup prompt | `hooks/register.ts`, `hooks/setup.ts` | `ndev hook session-start`, `ndev project setup` | Hooks | Offer setup when data is missing. Save a selected or typed answer. |
| Shared wiki setup | `hooks/register.ts`, `scripts/wiki/init.sh` | `ndev hook session-start` | Hooks | Seed an absent wiki. Report an existing directory with no index. |
| First issue prompt | `hooks/workflow/ask-issue.ts`, `hooks/register.ts` | `ndev hook session-start` | Hooks | Offer issue selection in an interactive session and respect a decision to decline. |
| Project init and build marker | `hooks/init-project.ts` | `ndev hook session-start`, `ndev hook prompt-submit`, `ndev project init` | Hooks | Run the configured setup for an unbuilt worktree and report the trigger, failure, and repair. |
| Credentials setup and guidance | `hooks/credentials.ts` | `ndev hook session-start`, `ndev project credentials` | Hooks | Copy from main or initialize from the permitted shell file. Refuse an unignored file and keep values out of output. |
| Running resource guidance | `hooks/worktree-stacks.ts` | `ndev hook prompt-context` | Hooks | List live services and repairs for past cleanup failures. |
| Prompt submission and correction | `hooks/register.ts` | `ndev hook prompt-submit` | Hooks | Reload pending settings and add guidance to a human correction only. |
| Prompt composition | `hooks/register.ts`, `hooks/workflow/tools.ts`, `hooks/workflow/epic.ts` | `ndev hook prompt-context` and installed guidance | Hooks | Supply mode, steering, brand, GitHub, wiki, report, setup, and active work context. |
| Skill reset on compaction | `hooks/workflow/tools.ts` | `ndev hook compact` | Hooks | Load skill context again after a main session compact. |
| Shell-code Git guard | `hooks/shell-code.ts`, `hooks/workflow/tools.ts`, `tests/workflow-git-guard.test.ts` | `ndev hook pre-tool-use` | Hooks | Port the deny and allow cases through the hook. Cover shell paths, scripts, active code in heredocs, commands in quotes, data literals, worktree changes, and helper and hotfix limits. [Hook test](../../tests/ndev-hooks.test.mjs) |
| Duplicate CI wait guard | `hooks/workflow/tools.ts` | `ndev hook pre-tool-use` | Hooks | Reject a redundant wait for the watched PR and allow the hotfix PR wait. |
| Walk tool guard and reader access | `hooks/walk-doc/index.tsx` | `ndev hook pre-tool-use`, reader profile | Hooks | Deny out-of-role tools and paths before execution and allow the intended reader actions. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| Claude CLI subscription warning | `hooks/quality.ts` | `ndev hook pre-tool-use` | Hooks | Return the configured warning and let the matched tool run. |
| Edited file checks | `hooks/quality.ts` | `ndev hook post-tool-use` | Hooks | Report findings after edits outside a workflow. Omit the duplicate check when the workflow owns it. |
| Commit check reminder | `hooks/quality.ts` | `ndev hook post-tool-use` | Hooks | Return a configured hint after a commit outside a workflow. |
| Worktree submodule setup | `hooks/quality.ts` | `ndev hook post-tool-use` | Hooks | Start setup after a worktree add. Report a failed setup with the command output. |
| Component guidance | `hooks/component-check.ts`, `hooks/component-files.ts` | `ndev hook post-tool-use` | Hooks | Detect a new component and report reuse guidance without duplicating it. [Hook test](../../tests/ndev-hooks.test.mjs) |
| Learn after push | `hooks/learn.ts`, `hooks/shell-code.ts` | `ndev hook post-tool-use` | Hooks | Suggest lesson capture after a successful shell push and ignore text that names a push. [Hook test](../../tests/ndev-hooks.test.mjs) |
| Triage shell reply | `hooks/triage.tsx` | `ndev hook post-tool-use` or receipt from Orca | Hooks | Clear the question after a successful reply. Keep it open and report an error after failure. |
| Responsive matrix refresh | `hooks/responsive-check.tsx` | `ndev hook post-tool-use` and panel refresh | Hooks | Pick up a completed responsive run and keep old results when there is no new run. |
| Main turn start and late nudge | `hooks/workflow/watchdog.ts` | `ndev hook turn-start`, `ndev watch` | Hooks | Suppress the nudge during a new turn. Identify a delayed watcher message by its receipt. |
| Main turn end dispatch | `hooks/register.ts`, `hooks/workflow/watchdog.ts`, `hooks/fix-all-prs.tsx`, `hooks/walk-doc/index.tsx` | `ndev hook turn-complete` | Hooks | Update queue activity and Walk state, restore dead waits, and notify only when the workflow needs it. |
| Reviewer answer at turn end | `hooks/workflow/watchdog.ts`, `hooks/workflow/tools.ts` | `ndev hook turn-complete` and Orca worker receipt | Hooks | Store the review against its original issue even after the owner changes tasks. |
| Session cleanup | `hooks/register.ts`, `hooks/walk-doc/index.tsx`, `hooks/worktree-stacks.ts`, `hooks/workflow/tools.ts` | `ndev hook session-end`, watcher recovery | Hooks | Stop the Walk, apply the stack policy, and release the owner. Report partial cleanup. [Hook test](../../tests/ndev-hooks.test.mjs) |
| Workflow CI checks and conflict notices | `hooks/workflow/watchdog.ts` | `ndev watch` | Hooks | Send a result for the current head, report failing or stuck checks, and ignore stale reads. [Watcher test](../../tests/ndev-watch.test.mjs) |
| Early turn-end nudge | `hooks/workflow/watchdog.ts` | `ndev watch` | Hooks | Send the next step after a normal incomplete turn and block after the repeat limit. |
| Idle and PR health nudge | `hooks/workflow/watchdog.ts` | `ndev watch` | Hooks | Recover idle work, return done work to revision on new feedback, and suppress notices when blocked or waiting. |
| Idle compaction and context refresh | `hooks/workflow/watchdog.ts`, `hooks/workflow/tools.ts` | `ndev watch` plus compact adapter | Hooks | Refresh the skill after a supported compaction. Report a skipped or failed compact and deliver the due notice. |
| Watcher status and progress line | `hooks/workflow/progress.ts`, `hooks/workflow/watchdog.ts` | CLI progress on stderr, flow status and Orca panels | Hooks | Show active step, elapsed time, and the last watcher result. |
| Interview close | `hooks/workflow/interview.tsx` | Orca panel close and durable pending round | Panes | Close the view without completing the round, then reopen or answer in text. |
| View timer | `hooks/view.tsx` | Orca panel refresh | Panes | Show changes to files and resources while the panel is open. |
| Responsive matrix timer | `hooks/responsive-check.tsx` | Orca panel refresh | Panes | Show new cells as the evidence appears. |
| Triage scheduler and PR checks | `hooks/triage.tsx` | Triage tick in `ndev watch` | Triage | Advance batches, alert on a stalled worker, and link the current PRs. |
| PR queue outgoing messages | `hooks/fix-all-prs.tsx` | Orca send receipts | Fix-all-prs | Track the recipient and delivery or failure in the queue log. |
| PR queue incoming messages and idle notices | `hooks/fix-all-prs.tsx` | Orca inbox and `ndev watch` | Fix-all-prs | Update an owner's activity, detect a block, and refresh stale context where supported. |
| PR queue scheduler | `hooks/fix-all-prs.tsx` | PR queue tick in `ndev watch` | Fix-all-prs | Resume after restart and advance through checks, owner waits, backoff, and retries. |

## Panels and workflow behavior

| Plugin feature | Source | ndev 2.0 | Work item | Acceptance test |
| --- | --- | --- | --- | --- |
| Interview pane | `hooks/workflow/interview.tsx`, `hooks/workflow/interview-model.ts` | Orca interview panel and `ndev flow interview` | Panes | Render questions, recommendations, notes, and answers. Submit equivalent answers from text mode. [Pane test](../../tests/ndev-panes.test.mjs) |
| View pane | `hooks/view.tsx`, `hooks/view-layout.ts` | Orca view panel and `ndev pane view` | Panes | Render workflow, review, settings, and resources for the current worktree. Match text output. [Pane test](../../tests/ndev-panes.test.mjs) |
| Walk-doc pane | `hooks/walk-doc/index.tsx`, `hooks/walk-doc/walk.ts` | Orca walk-doc panel and `ndev walk-doc status` | Panes | Compare findings, messages, media, and copy review state on panel and CLI. |
| Responsive matrix pane | `hooks/responsive-check.tsx` | Orca responsive matrix panel and `ndev pane responsive-matrix` | Panes | Compare viewport and scheme results, image paths, and progress. [Pane test](../../tests/ndev-panes.test.mjs) |
| Triage pane | `hooks/triage.tsx` | Orca triage panel and `ndev triage status` | Panes | Compare groups, questions, progress, PRs, and clean confirmation state. |
| Fix-all-prs pane | `hooks/fix-all-prs.tsx` | Orca fix-all-prs panel and `ndev fix-prs status` | Panes | Compare the queue, current step, checks, owners, and failures. |
| PR summary above prompt | `hooks/fix-all-prs.tsx`, `hooks/workflow/progress.ts` | Orca queue panel and CLI status | Panes | Show the open and complete counts and current step. |
| Files panel and resource controls | Orca plugin `orca-plugin.json`, `worker/main.mjs`, `worker/files.mjs`, `worker/resources.mjs` | Bundled Orca Files panel and `ndev pane files` and `ndev pane resources` | Panes | List and create files, copy from main, and stop or forget resources. Require confirmation for data deletion. [Pane test](../../tests/ndev-panes.test.mjs) |
| Walk reader runs and copy review | `hooks/walk-doc/index.tsx`, `hooks/walk-doc/prompts.ts`, `hooks/walk-doc/walk.ts` | `ndev walk-doc` and Orca worker | Panes | Start a reader with a fresh environment, keep run evidence, and send read pages to copy review. [Walk test](../../tests/ndev-walk-doc.test.mjs) |
| Triage worker groups and placement | `hooks/triage.tsx` | `ndev triage` and Orca orchestration | Triage | Pass the grouped issue brief and limits to Orca, link receipts, and respect existing work and dependencies. [Triage test](../../tests/ndev-triage.test.mjs) |
| Triage clean reviews | `hooks/triage.tsx` | `ndev triage clean` and `ndev triage confirm` | Triage | Show evidence, keep a declined issue open, and close only the confirmed issue and revision. [Triage test](../../tests/ndev-triage.test.mjs) |
| Fix-all-prs queue, owner, and merge rules | `hooks/fix-all-prs.tsx` | `ndev fix-prs` and `ndev watch` | Fix-all-prs | Match active owners and recover ones that stopped. Test green, draft, red, conflict, rate limit, and no-merge cases. |
| Stacked epic sub-issues | `hooks/workflow/epic.ts`, `tests/epic.test.ts` | `ndev epic next`, `ndev epic brief`, and `ndev epic issue` | Epic | Start from an open blocker PR head. Refuse a closed base. Notify after merge and refuse verification until the child targets the default branch. [Epic test](../../tests/ndev-epic.test.mjs) |
| Remote epic workers | `hooks/workflow/epic.ts`, `hooks/remote.ts`, `tests/epic.test.ts` | `ndev epic start --remote` and Orca host routing | Epic | Resolve the saved server and repo, make the brief available there, and dispatch both roles with the correct worker and worktree IDs. [Epic test](../../tests/ndev-epic.test.mjs) |
| Checkpoint push after rebase | `hooks/workflow/tools.ts`, `tests/workflow-checkpoint-rebase.test.ts` | `ndev flow checkpoint` | Workflow | Push with the observed SHA lease for patch matches. Refuse remote-only work and preserve history when the lease races. [Workflow test](../../scripts/export/tests/ndev-workflow.test.mjs) |
| Wait recovery and cancellation | `hooks/workflow/tools.ts`, `hooks/workflow/command.ts` | `ndev wait`, `ndev flow unblock` | Waits | Restore the saved phase for a dead wait and reject an update from the old wait after another starts. [Wait test](../../tests/ndev-waits.test.mjs) |
| Claude engine registration and plugin host | `hooks/hooks.json`, `hooks/register.ts`, `.claude-plugin/plugin.json` | **Drop** engine registration. The CLI runs the behavior and Orca owns the panels. | Installer | Install and exercise tools, hooks, and panel state without loading the old plugin. [Installer test](../../scripts/export/tests/ndev-install.test.mjs) |
| Report faults by editing plugin main | `hooks/workflow/bug-report.ts` | **Drop** direct-on-main repair. The ndev repository uses PRs. | Workflow | Report a fault through the new route and verify that it leaves the default branch untouched. |

## Skills and agents

Install each retained skill as `ndev-<name>`. Tests check native discovery, linked assets, and the rewritten references for each profile. They run a workflow fixture when a skill routes through a replaced tool. Install the agent definitions with the matching profile syntax and permissions. Tests check each role's discovery and its brief or limits.

| Feature | Source | ndev 2.0 | Work item | Acceptance test |
| --- | --- | --- | --- | --- |
| `adr-pdr` skill | `skills/adr-pdr/SKILL.md` | `ndev-adr-pdr` skill | Installer | Discover `ndev-adr-pdr` and resolve its references in each harness. |
| `adversarial-review` skill | `skills/adversarial-review/SKILL.md` | `ndev-adversarial-review` skill | Installer | Discover `ndev-adversarial-review` and resolve its references in each harness. |
| `archify` skill | `skills/archify/SKILL.md` | `ndev-archify` skill | Installer | Discover `ndev-archify` and resolve its references in each harness. |
| `are-we-done` skill | `skills/are-we-done/SKILL.md` | `ndev-are-we-done` skill | Installer | Discover `ndev-are-we-done` and resolve its references in each harness. |
| `ast-grep` skill | `skills/ast-grep/SKILL.md` | `ndev-ast-grep` skill | Installer | Discover `ndev-ast-grep` and resolve its references in each harness. |
| `brand` skill | `skills/brand/SKILL.md` | `ndev-brand` skill | Installer | Discover `ndev-brand` and resolve its references in each harness. |
| `browser-arrows` skill | `skills/browser-arrows/SKILL.md` | `ndev-browser-arrows` skill | Installer | Discover `ndev-browser-arrows` and resolve its references in each harness. |
| `clean-reader` skill | `skills/clean-reader/SKILL.md` | `ndev-clean-reader` skill | Installer | Discover `ndev-clean-reader` and resolve its references in each harness. |
| `command-reuse` skill | `skills/command-reuse/SKILL.md` | `ndev-command-reuse` skill | Installer | Discover `ndev-command-reuse` and resolve its references in each harness. |
| `copy` skill | `skills/copy/SKILL.md` | `ndev-copy` skill | Installer | Discover `ndev-copy` and resolve its references in each harness. |
| `cut-release` skill | `skills/cut-release/SKILL.md` | `ndev-cut-release` skill | Installer | Discover `ndev-cut-release` and resolve its references in each harness. |
| `database` skill | `skills/database/SKILL.md` | `ndev-database` skill | Installer | Discover `ndev-database` and resolve its references in each harness. |
| `deadcode` skill | `skills/deadcode/SKILL.md` | `ndev-deadcode` skill | Installer | Discover `ndev-deadcode` and resolve its references in each harness. |
| `dev-wiki` skill | `skills/dev-wiki/SKILL.md` | `ndev-dev-wiki` skill | Installer | Discover `ndev-dev-wiki` and resolve its references in each harness. |
| `diagram-design` skill | `skills/diagram-design/SKILL.md` | `ndev-diagram-design` skill | Installer | Discover `ndev-diagram-design` and resolve its references in each harness. |
| `doc-coverage` skill | `skills/doc-coverage/SKILL.md` | `ndev-doc-coverage` skill | Installer | Discover `ndev-doc-coverage` and resolve its references in each harness. |
| `docs` skill | `skills/docs/SKILL.md` | `ndev-docs` skill | Installer | Discover `ndev-docs` and resolve its references in each harness. |
| `docs-legibility` skill | `skills/docs-legibility/SKILL.md` | `ndev-docs-legibility` skill | Installer | Discover `ndev-docs-legibility` and resolve its references in each harness. |
| `docs-sync` skill | `skills/docs-sync/SKILL.md` | `ndev-docs-sync` skill | Installer | Discover `ndev-docs-sync` and resolve its references in each harness. |
| `docs-team` skill | `skills/docs-team/SKILL.md` | `ndev-docs-team` skill | Installer | Discover `ndev-docs-team` and resolve its references in each harness. |
| `epic-coordinate` skill | `skills/epic-coordinate/SKILL.md` | `ndev-epic-coordinate` skill | Installer | Discover `ndev-epic-coordinate` and resolve its references in each harness. |
| `epic-plan` skill | `skills/epic-plan/SKILL.md` | `ndev-epic-plan` skill | Installer | Discover `ndev-epic-plan` and resolve its references in each harness. |
| `finish` skill | `skills/finish/SKILL.md` | `ndev-finish` skill | Installer | Discover `ndev-finish` and resolve its references in each harness. |
| `fix-all-prs` skill | `skills/fix-all-prs/SKILL.md` | `ndev-fix-all-prs` skill | Installer | Discover `ndev-fix-all-prs` and resolve its references in each harness. |
| `fix-ci` skill | `skills/fix-ci/SKILL.md` | `ndev-fix-ci` skill | Installer | Discover `ndev-fix-ci` and resolve its references in each harness. |
| `for-codex` skill | `skills/for-codex/SKILL.md` | **Drop** project-only symlink procedure. Use `ndev install codex` to install the CLI, hooks, and assets together. | Installer | Codex discovers the installed skills without the plugin checkout. |
| `forget` skill | `skills/forget/SKILL.md` | `ndev-forget` skill | Installer | Discover `ndev-forget` and resolve its references in each harness. |
| `github` skill | `skills/github/SKILL.md` | `ndev-github` skill | Installer | Discover `ndev-github` and resolve its references in each harness. |
| `goal-work` skill | `skills/goal-work/SKILL.md` | `ndev-goal-work` skill | Installer | Discover `ndev-goal-work` and resolve its references in each harness. |
| `harness-sync` skill | `skills/harness-sync/SKILL.md` | `ndev-harness-sync` skill | Installer | Discover `ndev-harness-sync` and resolve its references in each harness. |
| `hotfix` skill | `skills/hotfix/SKILL.md` | `ndev-hotfix` skill | Installer | Discover `ndev-hotfix` and resolve its references in each harness. |
| `hyperfine` skill | `skills/hyperfine/SKILL.md` | `ndev-hyperfine` skill | Installer | Discover `ndev-hyperfine` and resolve its references in each harness. |
| `i` skill | `skills/i/SKILL.md` | Consolidated into `ndev-issue` | Installer | Discover `ndev-issue` in each harness. |
| `i-have-adhd` skill | `skills/i-have-adhd/SKILL.md` | `ndev-i-have-adhd` skill | Installer | Discover `ndev-i-have-adhd` and resolve its references in each harness. |
| `implement-spec` skill | `skills/implement-spec/SKILL.md` | `ndev-implement-spec` skill | Installer | Discover `ndev-implement-spec` and resolve its references in each harness. |
| `improve-agent` skill | `skills/improve-agent/SKILL.md` | `ndev-improve-agent` skill | Installer | Discover `ndev-improve-agent` and resolve its references in each harness. |
| `infographic` skill | `skills/infographic/SKILL.md` | `ndev-infographic` skill | Installer | Discover `ndev-infographic` and resolve its references in each harness. |
| `interview` skill | `skills/interview/SKILL.md` | `ndev-interview` skill | Installer | Discover `ndev-interview` and resolve its references in each harness. |
| `issue` skill | `skills/issue/SKILL.md` | `ndev-issue` skill | Installer | Discover `ndev-issue` and resolve its references in each harness. |
| `merge` skill | `skills/merge/SKILL.md` | `ndev-merge` skill | Installer | Discover `ndev-merge` and resolve its references in each harness. |
| `milestone-release` skill | `skills/milestone-release/SKILL.md` | `ndev-milestone-release` skill | Installer | Discover `ndev-milestone-release` and resolve its references in each harness. |
| `milestone-release-notes` skill | `skills/milestone-release-notes/SKILL.md` | `ndev-milestone-release-notes` skill | Installer | Discover `ndev-milestone-release-notes` and resolve its references in each harness. |
| `mobile-testing` skill | `skills/mobile-testing/SKILL.md` | Mobile capture helper in `ndev-responsive-check` | Installer | Capture mobile screenshots through the responsive-check skill. |
| `modern-web-guidance` skill | `skills/modern-web-guidance/SKILL.md` | `ndev-modern-web-guidance` skill | Installer | Discover `ndev-modern-web-guidance` and resolve its references in each harness. |
| `motion` skill | `skills/motion/SKILL.md` | `ndev-motion` skill | Installer | Discover `ndev-motion` and resolve its references in each harness. |
| `perf-review` skill | `skills/perf-review/SKILL.md` | `ndev-perf-review` skill | Installer | Discover `ndev-perf-review` and resolve its references in each harness. |
| `pick-up-prs` skill | `skills/pick-up-prs/SKILL.md` | `ndev-pick-up-prs` skill | Installer | Discover `ndev-pick-up-prs` and resolve its references in each harness. |
| `project-analysis` skill | `skills/project-analysis/SKILL.md` | `ndev-project-analysis` skill | Installer | Discover `ndev-project-analysis` and resolve its references in each harness. |
| `publish` skill | `skills/publish/SKILL.md` | `ndev-publish` skill | Installer | Discover `ndev-publish` and resolve its references in each harness. |
| `r` skill | `skills/r/SKILL.md` | Consolidated into `ndev-remember` | Installer | Discover `ndev-remember` in each harness. |
| `react-grab` skill | `skills/react-grab/SKILL.md` | `ndev-react-grab` skill | Installer | Discover `ndev-react-grab` and resolve its references in each harness. |
| `remember` skill | `skills/remember/SKILL.md` | `ndev-remember` skill | Installer | Discover `ndev-remember` and resolve its references in each harness. |
| `report-work-done` skill | `skills/report-work-done/SKILL.md` | `ndev-report-work-done` skill | Installer | Discover `ndev-report-work-done` and resolve its references in each harness. |
| `reset` skill | `skills/reset/SKILL.md` | `ndev-reset` skill | Installer | Discover `ndev-reset` and resolve its references in each harness. |
| `resolving-merge-conflicts` skill | `skills/resolving-merge-conflicts/SKILL.md` | `ndev-resolving-merge-conflicts` skill | Installer | Discover `ndev-resolving-merge-conflicts` and resolve its references in each harness. |
| `responsive-check` skill | `skills/responsive-check/SKILL.md` | `ndev-responsive-check` skill | Installer | Discover `ndev-responsive-check` and resolve its references in each harness. |
| `retro` skill | `skills/retro/SKILL.md` | `ndev-retro` skill | Installer | Discover `ndev-retro` and resolve its references in each harness. |
| `second-opinion` skill | `skills/second-opinion/SKILL.md` | `ndev-second-opinion` skill | Installer | Discover `ndev-second-opinion` and resolve its references in each harness. |
| `site-check` skill | `skills/site-check/SKILL.md` | `ndev-site-check` skill | Installer | Discover `ndev-site-check` and resolve its references in each harness. |
| `testing` skill | `skills/testing/SKILL.md` | `ndev-testing` skill | Installer | Discover `ndev-testing` and resolve its references in each harness. |
| `ux-principles` skill | `skills/ux-principles/SKILL.md` | `ndev-ux-principles` skill | Installer | Discover `ndev-ux-principles` and resolve its references in each harness. |
| `video-docs` skill | `skills/video-docs/SKILL.md` | `ndev-video-docs` skill | Installer | Discover `ndev-video-docs` and resolve its references in each harness. |
| `video-explainer` skill | `skills/video-explainer/SKILL.md` | `ndev-video-explainer` skill | Installer | Discover `ndev-video-explainer` and resolve its references in each harness. |
| `video-finish` skill | `skills/video-finish/SKILL.md` | `ndev-video-finish` skill | Installer | Discover `ndev-video-finish` and resolve its references in each harness. |
| `video-how-to` skill | `skills/video-how-to/SKILL.md` | `ndev-video-how-to` skill | Installer | Discover `ndev-video-how-to` and resolve its references in each harness. |
| `video-images` skill | `skills/video-images/SKILL.md` | `ndev-video-images` skill | Installer | Discover `ndev-video-images` and resolve its references in each harness. |
| `video-marketing` skill | `skills/video-marketing/SKILL.md` | `ndev-video-marketing` skill | Installer | Discover `ndev-video-marketing` and resolve its references in each harness. |
| `video-narration` skill | `skills/video-narration/SKILL.md` | `ndev-video-narration` skill | Installer | Discover `ndev-video-narration` and resolve its references in each harness. |
| `video-podcast-effect` skill | `skills/video-podcast-effect/SKILL.md` | `ndev-video-podcast-effect` skill | Installer | Discover `ndev-video-podcast-effect` and resolve its references in each harness. |
| `video-publish` skill | `skills/video-publish/SKILL.md` | `ndev-video-publish` skill | Installer | Discover `ndev-video-publish` and resolve its references in each harness. |
| `video-render-review` skill | `skills/video-render-review/SKILL.md` | `ndev-video-render-review` skill | Installer | Discover `ndev-video-render-review` and resolve its references in each harness. |
| `video-scenes` skill | `skills/video-scenes/SKILL.md` | `ndev-video-scenes` skill | Installer | Discover `ndev-video-scenes` and resolve its references in each harness. |
| `video-setup` skill | `skills/video-setup/SKILL.md` | `ndev-video-setup` skill | Installer | Discover `ndev-video-setup` and resolve its references in each harness. |
| `video-types` skill | `skills/video-types/SKILL.md` | `ndev-video-types` skill | Installer | Discover `ndev-video-types` and resolve its references in each harness. |
| `video-workflow` skill | `skills/video-workflow/SKILL.md` | `ndev-video-workflow` skill | Installer | Discover `ndev-video-workflow` and resolve its references in each harness. |
| `what-do-you-need` skill | `skills/what-do-you-need/SKILL.md` | `ndev-what-do-you-need` skill | Installer | Discover `ndev-what-do-you-need` and resolve its references in each harness. |
| `wiki-lint` skill | `skills/wiki-lint/SKILL.md` | `ndev-wiki-lint` skill | Installer | Discover `ndev-wiki-lint` and resolve its references in each harness. |
| `work-hack` skill | `skills/work-hack/SKILL.md` | `ndev-work-hack` skill | Installer | Discover `ndev-work-hack` and resolve its references in each harness. |
| `work-heavy` skill | `skills/work-heavy/SKILL.md` | `ndev-work-heavy` skill | Installer | Discover `ndev-work-heavy` and resolve its references in each harness. |
| `work-heavy-auto` skill | `skills/work-heavy-auto/SKILL.md` | `ndev-work-heavy-auto` skill | Installer | Discover `ndev-work-heavy-auto` and resolve its references in each harness. |
| `work-interactive` skill | `skills/work-interactive/SKILL.md` | `ndev-work-interactive` skill | Installer | Discover `ndev-work-interactive` and resolve its references in each harness. |
| `work-light` skill | `skills/work-light/SKILL.md` | `ndev-work-light` skill | Installer | Discover `ndev-work-light` and resolve its references in each harness. |
| `work-light-auto` skill | `skills/work-light-auto/SKILL.md` | `ndev-work-light-auto` skill | Installer | Discover `ndev-work-light-auto` and resolve its references in each harness. |
| `board-survey` agent | `agents/board-survey.md` | `ndev-board-survey` agent | Installer | Discover the role and load its brief and permissions in each harness. |
| `copy-editor` agent | `agents/copy-editor.md` | `ndev-copy-editor` agent | Installer | Discover the role and load its brief and permissions in each harness. |
| `dev-task` agent | `agents/dev-task.md` | `ndev-dev-task` agent | Installer | Discover the role and load its brief and permissions in each harness. |
| `diff-reviewer` agent | `agents/diff-reviewer.md` | `ndev-diff-reviewer` agent | Installer | Discover the role and load its brief and permissions in each harness. |
| `issue-implementer` agent | `agents/issue-implementer.md` | `ndev-issue-implementer` agent | Installer | Discover the role and load its brief and permissions in each harness. |
| `plan-scout` agent | `agents/plan-scout.md` | `ndev-plan-scout` agent | Installer | Discover the role and load its brief and permissions in each harness. |
| `tdd-implementer` agent | `agents/tdd-implementer.md` | `ndev-tdd-implementer` agent | Installer | Discover the role and load its brief and permissions in each harness. |
| `work-heavy-auto-orchestrator` agent | `agents/work-heavy-auto-orchestrator.md` | `ndev-work-heavy-auto-orchestrator` agent | Installer | Discover the role and load its brief and permissions in each harness. |
| `walk` agent | `hooks/walk-doc/index.tsx`, `hooks/walk-doc/prompts.ts` | Orca Walk reader with the installed reader profile | Panes | Launch only for a Walk run. Bind reader tools and preserve the role limits. |
