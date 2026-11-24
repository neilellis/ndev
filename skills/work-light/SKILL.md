---
name: work-light
description: "Implement focused fixes and small features in light mode, the default. One owner handles diagnosis, TDD, verification and the PR. Use work-heavy for larger or risky changes."
---

# Light work

Read [the ndev CLI skill](${CLAUDE_PLUGIN_ROOT}/skills/cli/SKILL.md) for native commands and when to use them. Prefer those commands for workflow operations when `ndev` is available. Keep this skill's gates and ownership rules.

Read the applicable parts of the project’s `NORTH_STAR.md`.

One main agent owns each fix from diagnosis to PR. Small helpers keep its context focused.
This is the everyday coding workflow. Use the `work-heavy` skill for multi-step features, cross-cutting or high-risk changes that need a plan, reviews and staged verification.
Repository safety rules, required gates and domain rules still apply.
Do not chain planning, TDD, review and board skills automatically. Read a specialist skill only when its rules apply.

## The workflow

While the project does not set `"workflow": false` in `.neil-dev.json`, the `mcp__ndev__*` tools carry this method. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`. Each tool records the state in `.neil-dev.issue-<id>.json` and answers with the next step. Follow that answer. If it differs from this skill, the answer wins.

| Stage | Tool | What the tool does |
|---|---|---|
| Start or resume | `mcp__ndev__started(issue, shortName, mode)` | Claims the worktree. The first push of a real change opens the draft PR. Call it first. |
| Interview (interactive) | `mcp__ndev__interview(interviewJson)`, then `mcp__ndev__interview()` | Asks the human in a pane, then goes on. Load the `interview` skill. |
| Plan (heavy) | `mcp__ndev__finishedPlan(markdown_file)` | Puts the plan in the PR body and runs `pre-push-check.sh` on the base. |
| Base check (light, auto) | `mcp__ndev__finishedInterview()` | With no interview, call it before any code. It runs `pre-commit-check.sh` on the base. `interview()` runs the same check when it goes on to development. A failure does not stop you: fix it if small, or use `followUp` or `blocked`. |
| Save work | `mcp__ndev__checkpoint(message, files, changeTypes)` | Runs the checks, commits the named files, and pushes. `changeTypes` adds to the types that set the review instructions. Use it and not `git commit` or `git push`. |
| Development ends | `mcp__ndev__finishedDevelopment(issues, prs, message, files, body_file)` | Commits and starts the code review and the dead-code sweep at once. Do not start another review. `body_file` is optional: the PR body. |
| Review ends | `mcp__ndev__finishedReview(review, deadcode, remembered)` | Needs the review result, your triage of the sweep and the remember result. Then it pushes and marks the PR ready. |
| Checks end | `mcp__ndev__finishedChecks()` | The workflow watches CI and conflicts and tells you. Do not start a wait helper while it watches. |
| Smoke ends | `mcp__ndev__finishedSmoke(report or skipped)` | Posts the report. |
| Feedback answered | `mcp__ndev__finishedRevision()` | Goes back to the checks. |
| All complete | `mcp__ndev__done(message)` | Checks everything and marks it done. |

Give each call its `issue`. From `reviewing` onward, you can give its `pr`. `started` takes an optional `mode`: choose `heavy` for a multi-step, cross-cutting or high-risk change, and `light` for the others. The human can change it with `/flow mode`. The mode in the answer of `started` wins over the session's mode.

At any stage: `mcp__ndev__status()` reads the state. `mcp__ndev__setSteering(steering, reason)` sets auto when no human can answer. `mcp__ndev__blocked(message)` and `mcp__ndev__unblocked(message)` reach the human. `mcp__ndev__followUp(mode, message)` files other work. `mcp__ndev__addMigration(name)` adds a migration for after the merge. `mcp__ndev__requestSecret(name)` finds where a secret is set. `mcp__ndev__iNeedA(kind, description)` gives guidance on a component, library, brand style or animation. `mcp__ndev__reportWorkflowBug(title, details)` starts an agent that fixes a fault of the plugin. `mcp__ndev__waitForPR(issue, pr, state)` and `mcp__ndev__waitForIssue(waitOn, state)` hold the agent until another PR or issue reaches a state. `mcp__ndev__waitForState(issue_id, state)` holds it until another issue's workflow reaches a workflow state. Past half of its retries, a wait tells the human.

A helper agent cannot move the workflow. It can call only `status`, `requestSecret`, `followUp` with `issue_only`, `iNeedA`, `reportWorkflowBug` and `screenshot`. The steps below say how to do the work of each stage.

## Spend tokens on the fix

- Batch independent reads and searches into one tool call. Keep dependent steps in order.
- Use existing scripts for repeated setup, checks, reports and waits. If a repeated procedure has no helper, add a small tested script with clear results and failure exit codes, in the owning skill's `scripts/` folder. The `command-reuse` skill has the recipes.
- Do not reread unchanged instructions or files already in context. Do not audit session history.
- Never hide a failure inside a batch. Never lose an exit status through a pipe.
- Keep successful output to a summary. Keep full logs in files for diagnosis.
- In a long interactive run, put the coloured log level first. Never colour JSON or redirected logs.

Never poll PR checks, deployments or local processes by hand: no loops of status calls, sleeps or log tails.
While a workflow runs, it watches the PR for you. Otherwise run the wait helper once in the foreground. Read its result when it returns. Then resume, do other useful work, or leave a pickup note.

## Find the starting point

1. Use the path from the error, issue, import or task note first.
2. If the area is unknown, use the starting-point table in the project's CLAUDE.md or AGENTS.md, if it has one. Else read the project's wiki (start at its index) once and open only the relevant topic.
3. Scope the first search to that file or package: `rg --files <dir>`, `rg -n -F <text>`.
4. Use `ast-grep` for code structure. For callers, search both `NAME($$$)` and `$_.NAME($$$)`. Check aliases and string dispatch where the interface uses them. For an exhaustive structural search, use the `ast-grep` skill's `find.sh`.
5. Widen to imports, callers or neighbouring packages only when a named question stays open.

Search the decision records for the area before you design or change behaviour: `adr-pdr` skill, `records.mjs search <terms>`. An accepted ADR or PDR is settled; do not reopen it without new evidence.

When the project has `docs/formal/requirements/`, start from the records: the work exists to fulfil them. Read each record that the issue cites. If it cites none in force, find one or propose one with the status `Proposed`. Also find the requirement records that the change touches: `ndev requirements for <path>...` on the files that you plan to change, and `ndev requirements search <terms>` (the `requirements` skill). The change must meet each `Accepted` record. Read the Quint models in their `model` lists. `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md`, section "In the workflow", says what to do with them at each stage, and when a model is necessary.

Keep a short path list in the task note and reuse it. If a known path is absent, make one scoped search and correct the stale map. Absence is not proof that the feature is gone.

For an external API, find the installed version and the local call site before you search the web. Fetch the relevant section of the official documentation. Do not repeat a broad search.

For UI work, read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` before you write or replace a component, and choose each component from it.

## Start once

While a workflow runs, `mcp__ndev__started` does the status check and the worktree claim, so go on to the task note below. With no workflow, collect the task status in one call, with `${CLAUDE_PLUGIN_ROOT}/scripts/work/work-status.sh`:

```sh
work-status.sh --repo <repo> --task <branch-slug> --fetch --json [--owned-worktree <abs-path>] [--base <branch>]
```

Use `--issue <n>`, `--pr <n>` or `--branch <name>` when you know it. The result gives matching PRs, CI state, branches, worktrees, pending changes and base freshness. Do not repeat those queries.

Follow the status: `new`, `existing`, `resume`, `blocked` or `closed`. An error is not evidence of new work. A clean worktree does not prove ownership.
Only for `new`, claim a worktree with `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree_claim.sh`:

```sh
worktree_claim.sh <repo> <task> origin/<base> [<worktree-parent>]
```

Pass the Orca workspace folder as `<worktree-parent>` when the project uses Orca (see the `orca-cli` skill). A claim failure stops work on that task. Never reset, remove or take over another session's worktree. Keep the base checkout untouched.

Write one short task note: the symptom, the required behaviour, and `Test entry point:` (a public interface that shows the defect). Ask only about unresolved behaviour, scope or consequential design. Batch the questions.
Write a plan only when interfaces, migrations or competing designs need a decision. Keep it to the decision, boundaries, risks and test evidence.
For a design decision that is hard to change later, get an independent view with the `second-opinion` skill. It asks Codex or Claude only when their quota allows.
If baseline health matters, check it once on the base commit. An unrelated baseline failure is recorded, not fixed, and not counted as a pass.

## Fix with TDD

1. Write a regression test through the chosen public interface.
2. Run it. Confirm that the intended defect causes the failure. An import error or a missing dependency is not proof.
3. Add the smallest fix. Run the test again.
4. Run nearby tests after any refactor. Commit the coherent change.

- Use independent expected values. Mock only external boundaries. Keep the regression test as the permanent guard.
- Add integration or browser coverage only when it detects a different failure.
- For an architectural guard, prove that a bad example fails and a valid example passes.
- When the change alters behaviour that a record's model specifies, change the model first, then prove it with a mutant and a witness (kb/requirements.md, "Prove the model").
- Keep the Trace current: add `- File:` lines with `ndev requirements file`, cite `REQ-NNNN` in the source, and propose a record for new behaviour. Never change a Statement or a Source text without the human's agreement.
- Documentation-only changes need validation of the artefact, not artificial failing tests.
- Never hide a failure, weaken a rule, or add a recovery path that nobody approved.
- Every error message prints the failed identifier and useful diagnostics. When the repair is known, the message names it.
- Do not write comments in code. The only exception is a fact that took a lot of research or trial and error to find; if you are not sure, leave it out. The rule is `${CLAUDE_PLUGIN_ROOT}/kb/comments.md`.

## Confirm development is done

Under interactive steering, show a concrete development preview when relevant and keep taking design feedback. Ask whether the work is done before final checks or review. Wait for the human to confirm. If they request changes, keep developing and ask again when those changes are ready. Only then call `ndev flow finished-development` with `--human-confirmation` containing the human’s answer. The CLI refuses an interactive finish without this answer, before staging files, checks or review. Auto steering continues without this confirmation.

## Finish once

Inspect the final diff for scope, accidental changes and missing acceptance criteria.
For behaviour changes, get one independent review of specification and correctness. While a workflow runs, `mcp__ndev__finishedDevelopment` starts it. Give the reviewer the requirements, diff, constraints and test evidence, not your defence of the solution. A self-review is not an independent review; if no reviewer is available, report the review as pending.

Choose the checks from the affected behaviour. Use the commands named in the project's CLAUDE.md or AGENTS.md:

| Change | Evidence |
|---|---|
| Application code | Regression test and affected suites; lint and type checks; the repo's precheck command, if it has one. |
| Dead code risk | The `deadcode` skill's sweep against the base. Resolve or explain each finding. |
| Web behaviour or deployment | Build, end-to-end tests, and a smoke test of the affected behaviour on the real preview URL. |
| Schema, auth, concurrency, external interfaces | Failure cases through the affected integration tests. |
| Documentation or skills only | `git diff --check`; `${CLAUDE_PLUGIN_ROOT}/scripts/docs/readability.sh`; `test -f` for each changed reference; a skill validator if one is installed. A missing validator is an unrun check. |

Run each required check once against the finished change. After a fix or base update, rerun only what it can affect. Report **passed**, **failed**, **skipped (with reason)** and **not run** as separate states, in a comment on the PR. With no PR, put them in the commit message.

One PR per coherent unit of work, in draft while work remains. Move the task note into the PR body (while a workflow runs, with `body_file`): problem, resulting behaviour, test evidence, limits, `Test entry point:`, closing issue references and the required commit trailers. Link the PR and its issues in the Trace of each touched record with `ndev requirements link`. Then run `ndev requirements check` and `guard`. Update documentation when a durable fact changes. When the change decides how the system is built, or amends a requirement, record it with the `adr-pdr` skill in the same PR. Follow the `remember` skill before the PR leaves draft. While a workflow runs, its result goes to `mcp__ndev__finishedReview` as `remembered`.

While a workflow runs, push with `mcp__ndev__checkpoint`. Otherwise push with the repo's checked-push command named in its CLAUDE.md, else `git push`. Hooks run. Never use `--no-verify` and never change the hooks path to skip them. Resolve base conflicts and commit before you continue.

While a workflow runs, do not wait for CI: the workflow watches it, tells you the result, and refuses the wait helper. With no workflow, wait for CI with `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh`. Always pass `--skip-success`:

```sh
wait-for-pr-change.sh <pr> --skip-success --json
```

A change event is not a pass. Read the check conclusions for the intended commit. For a local process, use `${CLAUDE_PLUGIN_ROOT}/scripts/work/wait_for_process_end.sh <pid>`, then read the log and result. A process that ended is not a success.
If you pause for CI, leave one pickup note: commit, completed evidence, pending checks, next action. On resume, read that note. Do not restart the workflow.
Report done only with current evidence. Keep incomplete work in draft with a reason. A human merges. Keep the worktree while verification or revision still needs it.

## Targeted helpers

Claude: use Sonnet (`sonnet`). Codex: use Luna (`luna`). Use them for a tightly defined subtask that needs little judgement but fills the context with tool output. If the helper model is unavailable, say so and do the task locally. Do not silently switch to a more expensive model.

The main agent owns the diagnosis, design, scope and result. Do not split each TDD step into a separate agent. Give the helper only:

- the question or outcome;
- the worktree, allowed files and input;
- the command, the stop condition and the timeout;
- the evidence and a short return format.

| Task | Brief |
|---|---|
| Trace a call path | Find callers of the named interface in the named packages. Return paths, not file dumps. |
| Diagnose a long log | Return the first causal error, its line and a short explanation. |
| Wait for CI (no workflow only) | Run the wait helper for the named PR and commit. Return changed check results and pending checks. |
| Await an event | Run a bounded watcher for the named event or process exit. Return the evidence, failure or timeout. |
| Simple refactor | Change the agreed symbol in the named files, run the named tests, return the diff summary. |
| File cleanup | Remove only named, owned temporary outputs after proving no active task needs them. |

Waiting belongs in scripts, also inside a helper. Tell an editing helper which files it owns and that other agents work nearby. Never delete another worktree, unpushed work or unknown files to make a task pass.

## Several fixes at once

- Give each independent fix its own worktree, branch and main agent context.
- File separation does not prove independence. Check shared interfaces, schema, fixtures and runtime state. Keep coupled fixes together, in dependency order.
- Use separate databases, ports and output paths. Serialise shared browsers, end-to-end runs and other exclusive resources.
- When you start a local stack in a worktree (for example `supabase start` with the worktree's own project id), record it at once with `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree-env.sh add-stack --kind supabase --project-id <id> --cli-version <x.y.z> --workdir <dir>`. The session-end hook then stops it. If you stop it yourself, run `worktree-env.sh remove-stack --kind supabase --project-id <id>`. If `add-stack` refuses because `.neil-dev.worktree.json` is not git-ignored, tell the person to add it to `.gitignore`.
- When you start a dev server in a worktree, start it in the background and record it at once by a name for what it shows: `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree-env.sh add-dev-server --name <docs|ui|...> --pid $! --port <port> --cwd <dir>`. The session-end hook then stops it. The same name again replaces the entry. If you stop it yourself, run `worktree-env.sh remove-dev-server --name <name>`. If a command says the file is version 1, run the `migrate` command that it names.
- After one fix lands, assess its effect on the others.
- Keep unrelated discoveries out of the diff.
- Keep the main agent on the user's chosen model. Reserve Astra (the escalation model) for an unresolved diagnosis, a consequential design decision or a risky review. Give it a bounded brief with the evidence and the decision needed.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
