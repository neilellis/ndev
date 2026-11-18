---
name: epic-coordinate
description: "Coordinate the implementation of an epic: start an implementer and then a reviewer per sub-issue as Orca workers, rule on findings, verify each pull request, merge it with its migrations, and start what it unblocks. Use in the epic workflow states coordinating and closing, when an mcp__ndev__epic tool or /flow epic names this skill."
---

# Coordinate an epic

You are the **coordinator** and the final arbiter. Workers implement and review; you choose the order, rule on findings, verify and merge. You write no product code. Each sub-issue gets one workspace with two workers in turn: an implementer, then a reviewer on a different model.

Keep the aim of the epic in view in every ruling: meet the requirement, keep it simple.

## The workflow

This session is under the epic workflow, not the usual one. Code holds the state and computes the order; you make the judgements.

| Tool | Use |
|---|---|
| `mcp__ndev__epicNext(issue)` | The **frontier**: the sub-issues whose blockers are merged, and those that can start **stacked** on the PR branch of a blocker that is not merged yet, cut to the parallel limit. Start only what it lists. |
| `mcp__ndev__epicBrief(issue, sub, role)` | Writes the implementer or reviewer brief to a file and answers with the command that starts that worker. For a stacked start, the command branches from the blocker's PR branch and the record gets `stackedOn`. |
| `mcp__ndev__epicIssue(issue, sub, state, …)` | Records each move of a sub-issue. `reviewing→verified` runs the verify checks; `verified→merged` reads the merge from GitHub and answers with the new frontier, and with what to tell the worker of each sub-issue stacked on it. If the human merged the PR while the sub-issue was in `reviewing` or `fixing`, call `state: "merged"` from there: it records the merge commit and that verify did not run. |
| `mcp__ndev__epicStatus(issue)` | The table of sub-issues by state. Read it after a compaction. |
| `mcp__ndev__epicPhase(issue, finished, evidence)` | Ends `coordinating` (every sub-issue merged) and `closing`. |

Follow each tool's answer; if it differs from this skill, the answer wins. Each implementer runs the usual workflow (`mcp__ndev__started` … ) in its own worktree. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`, section "The epic workflow".

## The loop

Load the `orchestration` skill once for the Orca commands. Then, for each wake:

1. **Start the frontier.** For each issue from `epicNext`, ready or stacked: `epicBrief(role: "implementer")` writes the brief and answers with the `orca orchestration worker-start` command, filled in. Run that command as given, then `epicIssue(state: "implementing", worker, workspace)` with the dispatch id and the workspace path from its result. Start the stacked issues too: do not wait for the blocker to merge. `epicBrief` gives each the blocker's PR branch as its base, and a stacked start with no such brief is refused.
2. **End the turn.** Orca wakes you when a worker reports, asks or stalls. Hold no poll and no sleep loop.
3. **On an implementer's `worker_done`:** read its report for the PR, the checks and each departure from the spec. Then `epicBrief(role: "reviewer")`, run the command it answers with (the reviewer starts in the same workspace), and `epicIssue(state: "reviewing", pr, worker)`.
4. **On a reviewer's `worker_done`:** rule on every finding (below). With changes required, send the rulings to the implementer in one message (`orca orchestration send --to dispatch:<id>`) and `epicIssue(state: "fixing", verdict: "changes", note)`. When the implementer reports again, go back to `reviewing`; start a new review only when the fix is more than the ruling asked for.
5. **Verify:** `epicIssue(state: "verified")`. It refuses unless the PR is open, out of draft, green, mergeable and its migrations are registered. Then read the diff yourself for scope: the completion checklist of the issue, and anything the issue did not ask for.
6. **Merge** with the `ndev:merge` skill, which applies the registered migrations. Then `epicIssue(state: "merged")` and start the new frontier.
7. **Move the stack.** When the answer of `merged` names sub-issues stacked on the merged one, send each worker the instruction it gives, as given: merge the default branch in, push, and give the PR the default branch as its base. Do this before any other start. `verified` refuses a stacked PR until this is done.

**Workers on the saved server.** Only when the human asks for it: `mcp__ndev__epicStarted(issue, remote: true)` starts the workers of new sub-issues on the Orca server that `/dev remote` saved for the project (a string names another saved server; `remote: false` goes back to this machine). It also needs `remoteRepo`, the selector of the repository on that server, from `orca repo list --environment <server> --json`. The commands from `epicBrief` then carry `--on <server>`; run them as given. Record the implementer's `workspace` as the worktree id on the server (`<repoId>::<path>`, the `id` that `orca worktree list --environment <server> --json` lists), not a path. A sub-issue in flight stays where its workspace is. Address a remote worker by its dispatch id only, and push the spec files first: the server has only what is on GitHub. A refusal names the missing value and its repair; never fall back to this machine by yourself.

When every sub-issue is merged, `epicPhase(finished: "coordinating")`. In `closing`, check the epic end to end against the aim (the acceptance in the spec, run for real where the human allows it), list what remains, and report.

## Rulings

A reviewer's finding is evidence, not an order. For each one decide, against the spec, the aim and the project's posture:

- **Required in this PR**: it breaks the issue's scope, the spec or a project rule, or it hides a failure.
- **Not required**: say why (outside the issue, over-engineering, a later issue covers it) and record it in the PR body.

Send the rulings as one numbered message. A worker's question arrives with a proposed default: answer with `orca orchestration reply --id <msg>`, "defaults OK" plus the reason, or the correction.

A worker that fixes something outside its issue (a flaky test, a tool patch) has made a decision for you. Read those commits; accept them when they are small and needed for the checks, else have them moved to their own issue. Tell the human what you accepted.

After three review rounds on one issue, stop the loop on it: narrow the issue, split it, or ask the human.

## Stacked sub-issues

A stack lets a chain P1 → P2 → P3 run at the same time: P2 starts from the PR branch of P1 as soon as P1 is in review. It costs a rework when P1 changes.

- **Merge from the bottom.** A stacked PR is verified only when the PR below it is merged and its own base is the default branch. Review them in any order.
- **A ruling that changes a blocker's interface moves its stack.** When a required finding changes what the blocker gives to others (a schema, a type, a function signature, a file that moved), tell the worker of each issue stacked on it, in the same turn as the ruling: what changes, and to merge the blocker's branch in (`git fetch origin`, `git merge origin/<blocker branch>`) when the fix is pushed. `epicStatus` shows "stacked on #n". A fix inside the blocker needs no message.
- **A blocker that is dropped or split** leaves its stack on a dead branch. Stop those workers and decide with the human.
- **Two unmerged blockers on different branches** cannot carry a stack: `epicNext` says "Not stackable" and why. The issue starts when all but one are merged, or when one of the blockers is itself stacked on the others.
- **Stacking is your choice.** When the blocker's review is likely to change its interface, wait for the review before you start what depends on it.

## Ask the human

Decide what is yours: order, parallelism, rulings, merges at a project level that lets an agent merge. Take these to the human as one question each, with your recommendation, and carry on with the issues that do not depend on the answer:

- an action behind a gate set in framing (a paid call, a publish, hosted data);
- a merge whose release has a consequence users see (existing records refused, data rewritten);
- pending hosted migrations that belong to other work;
- a ruling that reverses a decision the human made in the spec.

Answer a direct question from the human before any other work.

## Failures and their repairs

| Failure | Repair |
|---|---|
| `worker-start` fails with `failedStage: agent_readiness`, `timeout` | The workspace setup (the dependency install) outran the start. `worker-release --dispatch <id>`, wait until the install has ended, then `worker-start --task <task id> --retry-of <failed id> --worktree path:<workspace> …`. |
| A worker "is waiting on a prompt" or "stopped without reporting" | `worker-read --dispatch <id> --source auto`, then answer it or `send` the next instruction. Check `orca orchestration check --run <run>` at the start of each session: escalations queue while you are away. |
| A reviewer returns a partial review of a long file | `send` a method to the same dispatch: read in ranges of at most 250 lines, one command per range. |
| `merge.sh` answers `"migrations": []` for a PR that adds migration files | The implementer did not use `mcp__ndev__addMigration`. The verify check refuses this; if it is already merged, compare `supabase migration list` with the folder and ask the human before `db push`, which applies every pending file. |
| The hosted database has pending migrations from other PRs | Find them before the merge, not after. Ask the human once whether to apply them all. |
| A wait check never passes | Run the predicate once by hand before you wait on it; a command that fails (a flag of another platform's tool) looks the same as "not yet". |
| `verified` refuses with "the base is … not the default branch" | The PR is still stacked. Merge the PR below it and record it `merged`, send the worker the instruction in the refusal, then verify again. If the blocker's branch was deleted at the merge, GitHub has moved the base already and only the merge of the default branch remains. |
| A stacked worker reports that `started` blocked on its open blocker, or that a check refused a file of the blocker (a migration) | The stack explains both: the workflow compares with the default branch. Tell it to call `mcp__ndev__unblocked`, or to leave the file; it passes when the blocker is merged. |
| The merge of a PR closes the epic issue | Reopen it; a sub-issue PR closes its own issue only. |
| The context was compacted | `epicStatus`, then `orca orchestration worker-list --run <run>`; the record and Orca hold the state, your memory does not. |

## Reports to the human

Report when a decision is theirs, when an issue merges, and when the epic ends. Lead with the decisions as numbered questions, then the PRs with their status, then follow-up issues you can create. Say what you did not run.
