---
name: adversarial-review
description: "Run an independent adversarial review of a pull request: a fresh agent gets only the diff and the quoted plan row, runs six checks and tries to break the change. Use before merge, or when the user says \"adversarial review\", \"try to break this PR\", \"independent review\" or \"review from the code, not the description\"."
---

# Adversarial review

**A fresh agent reviews the change from the repository, not from its description, and tries to break it.** Every check that the author ran came from the author's own account of the change. This review lists the surfaces that the change touches and attacks them. A review that reads the PR body and agrees with it has not happened. The rules behind it are in [verification-policy.md](../../kb/verification-policy.md).

The argument is a PR number or a branch. If there is no argument, review the current branch against the main branch.

## Independence

Never review your own change in the session that wrote it. Start a fresh agent (`Agent`, `general-purpose`). Give it only:

1. The PR number or the branch, and the worktree path.
2. Read-only instructions: no edits, no commits, no pushes.
3. The plan row that the PR claims to advance, **quoted from the plan file**. Do not paraphrase it.
4. The six checks below, word for word.

Do not give it the PR body, the reasoning in the commit messages, or your own account of the change. It reads the diff and the code. Tell it that its final message is the report.

## The six checks (give these to the reviewer word for word)

1. **The invariant and its entry points.** From the diff, name every invariant that the change makes or alters: a bound, a refusal, a field name, a wire shape, a durability or ordering rule. For each one, list from the code every entry point that reads or writes the same thing: setters, constructors, network routes, each SDK, configuration loading, environment overrides, scheduled jobs, examples, and other packages that parse the same format. Give the search command for each. Report every entry point that the change did not cover, and say if it now disagrees with the covered ones.
2. **Siblings.** For each function that the diff changes, find the functions of the same shape: the same handler family, the same request builder, the function above and below. Check each one for the same defect.
3. **The plan row, promise by promise.** Quote each promise of the plan row. For each one, cite the code or the test that delivers it, or write *not built*. If the PR marks the row done and a promise is *not built*, that is a finding.
4. **Tests that cannot fail.** For each new test, ask: can it pass against the code before the fix? Look for a mock that accepts any input, an assertion on a value that the test itself supplies, and a live test that skips silently. Then check that CI runs it: it must be under a folder that a CI step discovers, not missing from a list.
5. **Instructions run literally.** Run each command, configuration snippet, code snippet or request that the PR adds to a document. If you cannot run it, trace it to the code that makes it work. If it fails as written, that is a finding.
6. **Break it.** Try at least three inputs or sequences that the author did not test: boundary values, the empty case, a repeated or concurrent call, the build without the feature, a restart in the middle. For a UI change, include the longest value that the schema accepts, an unbreakable string, a missing optional field, counts of 0 and 1, and 1,000 items (`responsive-check`, `references/worst-case-data.md`). Say what happens, from the code or by running it.

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

`mcp__ndev__finishedDevelopment` starts the plugin's own code review. Use this skill for more, and give the result to `mcp__ndev__finishedReview` as `review`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
