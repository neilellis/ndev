---
name: adversarial-review
description: "Run an independent adversarial review of a pull request, in which a fresh agent that sees only the diff tries to break the change. Use before merge, or when the user says \"adversarial review\", \"try to break this PR\", \"independent review\" or \"review from the code, not the description\"."
---

# Adversarial review

**A fresh agent reviews the change from the repository, not from its description, and tries to break it.** Every check that the author ran came from the author's own account of the change. This review lists the surfaces that the change touches and attacks them. A review that reads the PR body and agrees with it has not happened. The rules behind it are in [verification-policy.md](../../kb/verification-policy.md).

The argument is a PR number or a branch. If there is no argument, review the current branch against the main branch.

## Independence

Never review your own change in the session that wrote it. Start a fresh agent (`Agent`, `general-purpose`). Give it only:

1. The PR number or the branch, and the worktree path.
2. Read-only instructions: no edits, no commits, no pushes.
3. The plan row that the PR claims to advance, **quoted from the plan file**. Do not paraphrase it.
4. The eight checks below, word for word.

Do not give it the PR body, the reasoning in the commit messages, or your own account of the change. It reads the diff and the code. Tell it that its final message is the report.

## The eight checks (give these to the reviewer word for word)

1. **The invariant and its entry points.** From the diff, name every invariant that the change makes or alters: a bound, a refusal, a field name, a wire shape, a durability or ordering rule. For each one, list from the code every entry point that reads or writes the same thing: setters, constructors, network routes, each SDK, configuration loading, environment overrides, scheduled jobs, examples, and other packages that parse the same format. Give the search command for each. Report every entry point that the change did not cover, and say if it now disagrees with the covered ones. Search `docs/adr` and `docs/pdr` (`adr-pdr` skill) for accepted records on the same subject. Report each record that the change contradicts without a new record that supersedes it.
2. **Siblings.** For each function that the diff changes, find the functions of the same shape: the same handler family, the same request builder, the function above and below. Check each one for the same defect.
3. **The plan row, promise by promise.** Quote each promise of the plan row. For each one, cite the code or the test that delivers it, or write *not built*. If the PR marks the row done and a promise is *not built*, that is a finding.
4. **Tests that cannot fail.** For each new test, ask: can it pass against the code before the fix? Look for a mock that accepts any input, an assertion on a value that the test itself supplies, and a live test that skips silently. Then check that CI runs it: it must be under a folder that a CI step discovers, not missing from a list.
5. **Instructions run literally.** Run each command, configuration snippet, code snippet or request that the PR adds to a document. If you cannot run it, trace it to the code that makes it work. If it fails as written, that is a finding.
6. **Break it.** Try at least three inputs or sequences that the author did not test: boundary values, the empty case, a repeated or concurrent call, the build without the feature, a restart in the middle. For a UI change, include the longest value that the schema accepts, an unbreakable string, a missing optional field, counts of 0 and 1, and 1,000 items (`responsive-check`, `references/worst-case-data.md`). Say what happens, from the code or by running it.
7. **A lowered bar.** Run `node ${CLAUDE_PLUGIN_ROOT}/skills/adversarial-review/scripts/lowered-bar.mjs origin/<base>` in the worktree. It lists each line of the diff that lowers the bar. Examples are an added `.skip`, `.only` or `xit`, a deleted test or assertion, and an empty `catch`. Others are a lowered threshold, a longer timeout, and a new lint or type suppression. Then read the diff for the cases that the script cannot see. Each line needs a stated reason in the code, the commit message or the PR body. A line without a reason is a finding.
8. **A simpler design.** Ask the question that a staff engineer asks of a diff: "why did you not just…?" Look for a smaller change: an existing function, a library call, fewer layers, no new option. If a simpler design meets the specification, that is a finding. Name the simpler design.

## The report

The reviewer returns its findings in order of severity. Each finding has:

- `file:line`;
- a specific failure scenario;
- a label: *defect* or *question*.

## What to do with the findings

1. Post the findings on the PR (`gh pr comment`) under the heading **Adversarial review**.
2. For each defect, write a test that fails first, then fix it in the same PR.
3. For each question, answer it in the PR thread.
4. Merge only when every finding is fixed or answered. A human merges.
5. If a finding shows a gap that an earlier review missed, add it to the PR description too, so that the next author sees it.

## The workflow

`mcp__ndev__finishedDevelopment` starts the plugin's own code review. `ndev flow finished-development` also runs the lowered-bar script, and puts its list in the review brief. Use this skill for more, and give the result to `mcp__ndev__finishedReview` as `review`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
