---
name: fix-ci
description: "Fix failed checks and merge conflicts on the associated pull request until its current revision is green and mergeable. Use when the user asks to fix CI or make an existing PR ready."
---

# Fix CI on the associated PR

Keep working until the associated PR is out of draft, green and mergeable. A human merges. Never merge the PR and never push to the base branch.
Use `work-light` for development and `github` for PR operations. Keep diagnosis and design in one main agent context. Keep the original task, closing issue references and session constraints.

## The workflow

While a workflow runs, it tells you about a failed check. Fix it, commit with `mcp__ndev__checkpoint`, and call `mcp__ndev__finishedChecks` when the checks end. After three failed attempts, the workflow blocks itself. Call `mcp__ndev__blocked(message)` only when you need a human for another reason. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Identify the PR once

1. Use the PR that the user names or that this session already owns.
2. Else run `${CLAUDE_PLUGIN_ROOT}/scripts/work/work-status.sh --branch <current-branch> --owned-worktree <abs-path> --json`.
3. Ask only when the result gives more than one PR or none.
4. Continue the existing branch and worktree. Never open a second PR.
5. Read the task note and existing evidence. Record the PR URL, head SHA, failed checks and next action.

## Diagnose, fix and verify

While a workflow runs, it watches the checks and refuses a wait helper. With no workflow, wait for checks with the `github` skill's helper, once, in the foreground:

```bash
wait-for-pr-change.sh <pr> --skip-success --json
```

A change event or an exit code is not success. No checks is not a pass. Never replace the helper with manual polling.

For each failure:

- Read the failed job, its logs and annotations. Find the first causal error.
- Classify it: code defect, merge conflict, missing tool, runner failure, or a failure inherited from the base branch.
- Do not assume a timeout is transient or that a queued job is broken. Diagnose a runner only when the evidence points to the runner. Do not restart a busy runner or stop another task to free a resource.
- Fix the cause with focused TDD through a public interface. Keep the regression test. Never weaken a check to get green.
- Resolve conflicts with the `resolving-merge-conflicts` skill. Keep both intents.
- Retry a job only when the cause is fixed or the evidence shows a transient failure. An unchanged failure needs diagnosis, not blind retries.
- Rerun the checks that the code, dependency or base change can affect.
- Get the independent review that `work-light` requires for behaviour changes.

Commit coherent fixes. While a workflow runs, `mcp__ndev__checkpoint` commits and pushes them. With no workflow, push with the repo's checked-push command named in its CLAUDE.md, else `git push`. Never use `--no-verify`. Then wait for checks on the new head SHA.
For a local command, use `${CLAUDE_PLUGIN_ROOT}/scripts/work/wait_for_process_end.sh <pid>`, then read the final log and exit status.

## Complete with current evidence

Follow the `remember` skill before the PR leaves draft. If a preview needs a ready PR, meet the gates, mark it ready (`finishedReview` does this while a workflow runs), then verify the real deployment. An ignored deployment is not preview evidence.

Completion needs all of these:

- The head SHA is the revision you submitted.
- The PR is open, out of draft and explicitly mergeable. `UNKNOWN` is not mergeable.
- Every applicable check is complete and successful. No failure, cancellation, timeout, pending check or required action remains.
- Each skipped check is confirmed as excluded by workflow conditions. Report it as skipped, never as passed. A required check that did not run blocks completion.
- All verification and review that the original task requires is done.

Report the PR URL, head SHA and short evidence, with excluded checks named. If access, an external service or a user decision blocks progress, name the blocker and leave a pickup note: completed evidence, pending checks, exact next action. Never report a draft, red or unverified PR as done.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
