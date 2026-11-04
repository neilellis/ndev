---
name: work-heavy
description: "The interactive heavyweight development skill (heavy mode). The heavyweight staged development method for larger or riskier changes: multi-step features, cross-cutting changes, high-risk work such as schema, auth or migrations, and any change that needs a written plan, independent reviews and staged verification. Uses worktrees, a draft PR as the plan of record, TDD, a two-axis review, verification, knowledge ingest and continuation state. Use `work-light` instead for focused fixes and small features; `work-light` is the default. Load `work-heavy` when the user or an orchestrator (`work-heavy-auto`, `work-light-auto`, `goal-work`, a preloading agent) names it."
---

# Development method (staged)

Use this skill for one larger or riskier development task. For a focused fix or a small feature, use
`work-light`, which is the default. Choose `work-heavy` when the change has several steps, crosses
modules, touches schema, auth or migrations, or needs a plan, independent reviews and staged
verification.

## The workflow

While the project does not set `"workflow": false` in `.neil-dev.json`, the `mcp__ndev__*` tools carry this method. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`. Each tool records the state in `.neil-dev.issue-<id>.json` and answers with the next step. Follow that answer. If it differs from this skill, the answer wins.

| Stage | Tool | What the tool does |
|---|---|---|
| Start or resume | `mcp__ndev__started(issue, shortName, mode)` | Claims the worktree and opens the draft PR. Call it first. |
| Interview (interactive) | `mcp__ndev__interview(interviewJson)`, then `mcp__ndev__interview()` | Asks the human in a pane, then goes on. Load the `interview` skill. |
| Plan (heavy) | `mcp__ndev__finishedPlan(markdown_file)` | Puts the plan in the PR body. |
| Save work | `mcp__ndev__checkpoint(message, files, changeTypes)` | Runs the checks, commits the named files, and pushes. `changeTypes` adds to the types that set the review instructions. Use it and not `git commit` or `git push`. |
| Development ends | `mcp__ndev__finishedDevelopment(issues, prs, message, files)` | Commits and starts the code review at once. Do not start another review. |
| Review ends | `mcp__ndev__finishedReview(review, deadcode, remembered)` | Needs the review result, the dead-code result and the remember result. Then it pushes and marks the PR ready. |
| Checks end | `mcp__ndev__finishedChecks()` | The workflow watches CI and conflicts and tells you. Do not start a wait helper while it watches. |
| Smoke ends | `mcp__ndev__finishedSmoke(report or skipped)` | Posts the report. |
| Feedback answered | `mcp__ndev__finishedRevision()` | Goes back to the checks. |
| All complete | `mcp__ndev__done(message)` | Checks everything and marks it done. |

Give each call its `issue`. From `reviewing` onward, you can give its `pr`. `started` takes an optional `mode`: choose `heavy` for a multi-step, cross-cutting or high-risk change, and `light` for the others. The human can change it with `/flow mode`. The mode in the answer of `started` wins over the session's mode.

At any stage: `mcp__ndev__status()` reads the state. `mcp__ndev__setSteering(steering, reason)` sets auto when no human can answer. `mcp__ndev__blocked(message)` and `mcp__ndev__unblocked(message)` reach the human. `mcp__ndev__followUp(mode, message)` files other work. `mcp__ndev__addMigration(name)` adds a migration for after the merge. `mcp__ndev__requestSecret(name)` finds where a secret is set. `mcp__ndev__iNeedA(kind, description)` gives guidance on a component, library, brand style or animation. `mcp__ndev__reportWorkflowBug(title, details)` starts an agent that fixes a fault of the plugin. `mcp__ndev__waitForPR(issue, pr, state)` and `mcp__ndev__waitForIssue(waitOn, state)` hold the agent until another PR or issue reaches a state. `mcp__ndev__waitForState(issue_id, state)` holds it until another issue's workflow reaches a workflow state. Past half of its retries, a wait tells the human.

A helper agent cannot move the workflow. It can call only `status`, `requestSecret`, `followUp` with `issue_only`, `iNeedA`, `reportWorkflowBug` and `screenshot`. The fragments below say how to do the work of each stage.

Read only the reference for the current fragment:

| Reference | Fragments |
|---|---|
| `references/setup.md` | F0 resume and blockers, F0b default-branch health, F0c `incomprehensible` label, F1 worktree and draft PR |
| `references/planning.md` | F2 plan, F2a test entry point (seam) |
| `references/prose.md`, `references/writing.md` | F2b writing for humans, F2c readability gate |
| `references/implement.md` | F3 TDD, F3b comments, F3b1 naming, F3b2 logging, F3c two-axis review, F3d dead-code sweep |
| `references/verify.md` | F4 verify loop, F5 knowledge ingest |
| `references/state.md` | F6 continuation state, F6b review feedback, F7 questions |
| `references/prs.md` | Batching, dependent work, new work found while you work |
| `references/guards.md` | How tests lie. Read before you write a guard. |
| `references/verify-traps.md` | Traps that give a false green. Read before you quote a number or believe a status. |

Do the fragments in this order: F0 → F1 → F2 → F3 → F4 → F5 → F6. Use F7 when you are blocked. Do
not wait invisibly.

## Find the repository and its settings

```bash
REPO=$("${CLAUDE_PLUGIN_ROOT}/scripts/github/gh.sh" repo | jq -r .repo)  # owner/name
BASE=$("${CLAUDE_PLUGIN_ROOT}/scripts/github/gh.sh" default-branch)   # default branch
```

Board work needs the GitHub project board owner and number (`GH_PROJECT_OWNER`,
`GH_PROJECT_NUMBER`) and, if they differ from the defaults, its column names
(`WORK_READY_COL_READY`, `_PROGRESS`, `_REVIEW`, `_AWAITING`, `_DONE`). Take them from the
arguments or from the project's `CLAUDE.md`. If neither gives them, stop and say: "Set
GH_PROJECT_OWNER and GH_PROJECT_NUMBER, and any column names that are not Ready, In progress,
In review, Awaiting Feedback and Done, in `CLAUDE.md` or pass them as arguments." Board moves use
`${CLAUDE_PLUGIN_ROOT}/scripts/board/board.sh` (`board.sh ready|awaiting|items|move <itemId> <status>`,
status `backlog|ready|progress|review|awaiting|done`). Issue operations use the `github` skill's
`gh.sh` (`gh.sh subissues link`, `gh.sh blocked-by list|add`, `gh.sh labelled incomprehensible`). Typecheck, lint, test, build and E2E
commands come from the project's `CLAUDE.md`. If they are not there, find them once in the
package manifests and record them in the PR body.

## Golden rules

1. Work in a worktree cut from `origin/$BASE`. Never edit, commit or push in the shared checkout.
2. Use a feature branch and one PR per unit of work. A human merges. Never push to `$BASE`.
3. Preserve unrelated user changes. Stage files by name.
4. The draft PR body is the plan of record. It has a `Seam:` / `Test entry point:` line and one
   `Closes #<n>` per issue it closes.
5. Every commit carries the commit trailer that the repository or session requires.
6. Write the failing test first and watch it fail for the intended reason.
7. Mock only external boundaries: third-party APIs, the clock, the network.
8. Find the cause before you write a fix. A mechanism nobody has run is a hypothesis.
9. Commit before you mutation-test. Prove a guard in both directions: it fails with the defect and
   passes without it.
10. Run every gate from inside the worktree, with an absolute path. Give each worktree its own
    databases and ports. Record each local stack that you start in it with
    `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree-env.sh add-stack --kind supabase --project-id <id> --cli-version <x.y.z> --workdir <dir>`,
    and each dev server by name with
    `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree-env.sh add-dev-server --name <name> --pid $! --port <port> --cwd <dir>`,
    so the session-end hook stops them.
11. Claim green only on fresh evidence: a run you just did, with its exit status and its log.
12. Never weaken, skip or silence a check to make it pass.
13. A removal is not finished until the text that describes it is gone (`forget` skill).
14. Run the typecheck and lint first. They are fast and they name the line.
15. Never poll. While a workflow runs, it watches the checks and tells you. With no workflow, run one blocking wait helper in the foreground and read its result.
16. For UI work, read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` before you write or replace a component, and choose each component from it.

## Waiting

For PR checks while a workflow runs, do not wait: the workflow watches them, tells you the result, and refuses the wait helper. With no workflow, run `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh` once in the foreground. For a local
process, wait on its PID in the foreground (for example `while kill -0 <pid> 2>/dev/null; do sleep
30; done` inside one command). Do not poll with `ps`, read partial logs or send progress updates.
Read the log when the wait ends. A process that ended has not necessarily succeeded: check the exit
status and the final log.

## Record every failure

Every `except` and every `catch` records the failure or lets it raise. A handler that swallows a
failure makes a broken run look clean. A check that did not run is not a check that passed.

Classify by severity. An unexpected failure is ERROR. A recoverable failure is WARNING. Control
flow is INFO.

## Error reporting

Every error message prints the failed identifier and useful diagnostics: the exit code and the
command's own output. When the cause or the safe repair is known, the message names the repair
command. Do not make an operator find a known repair in a stack trace, a log path or the source.

## TTY log visibility

For a long interactive run, use the project's shared log formatter. It shows the coloured log level
first, then a coloured stable context prefix (for example `component:stage:sub-stage:`), and it
colours changing values such as progress counts. Set the context at stage boundaries. Do not put
ANSI codes in log messages. Redirected and JSON logs contain no terminal escape codes.

## Testing and verification

Use the `testing` skill's unit, integration and E2E tiers. Choose the smallest observable entry
point, keep live resources out of unit tests, and mutation-test architectural guards. Run focused
checks, then the project typecheck and lint, then the affected suite. A docs-only change can skip
code checks. For a code change, the dead-code sweep is part of final verification.

## PR shape

Batch small dependent issues into one branch and PR, in dependency order. Keep unrelated issues and
risky schema, auth or migration work separate. A related discovery becomes a linked sub-issue that
this PR carries. An unrelated discovery becomes a separate issue, with no PR. Check the closing
references again after every PR body edit. Details: `references/prs.md`.

When a procedure changes, update the reference that owns it and keep this file short.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
