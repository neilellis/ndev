# PR shape: batching, dependent work, new work

Part of the `work-heavy` skill.

## PR batching

The number of PRs, not their size, is the scarce resource. Scope a PR by a *coherent unit of work*,
not by issue number.

**Batch** an epic's sub-issue chain, or a contiguous phase of it. Also batch a small cluster of
closely coupled issues that make sense only when they ship together.

**Do not batch** unrelated issues, however small. "It saves CI" is not a relation, and a revert
removes every issue in the batch. Do not batch risky work (schema, auth, migration) with anything
else. Do not batch past what a reviewer can read: about 3 to 5 small issues, or one epic phase. When
you can choose, batch siblings, not strangers.

**Mechanics.** The discipline per issue does not change. Only the PR is shared:

- **Branch and PR:** name the branch after the **lead** issue (`claude/issue-<lead>`) so that
  branch-keyed tools keep working. The title names the epic or cluster. The body has one
  `Closes #<k>` line per issue.
- **One teammate per member issue** when the batch is complex. Each teammate works its issue on the
  shared branch. This keeps each issue's context separate and the top-level thread small.
- **In the PR**, do the issues in dependency order, each with its own body section, TDD tasks, pinned
  tests and commits. `${CLAUDE_PLUGIN_ROOT}/scripts/work/gates.sh <n> HEAD <pr>` must pass for **each** member,
  not only the lead. Each section has its own `Test entry point:`.
- **Cheap gates run per task** (unit suites, lint, typecheck). **Expensive gates run once per
  batch**, when the whole batch is in: E2E, the CI wait, the preview build, the browser smoke.
- **Board:** move all member cards together. The state comment (F6) names the batch and the status of
  each member.
- **Gating:** in a batch, the commit order satisfies sibling merge-gating. An external
  `depends on #X` on an open PR that is not yours is a block: record it with `gh.sh blocked-by add`.

## Dependent work

**A dependency is a commit order, not a second PR.** When change B needs change A, both go in one
PR. A comes first, then B, each with its own commit and body section. A teammate per member keeps
each context small. The PR targets `$BASE`.

A second PR costs a full CI pass, a preview build and a review. A second PR is made only when a human
asks for one by name.

**A dependency on an open PR that is not yours** is a block, not a stack. Record it with
`gh.sh blocked-by add <n> <blocker#>` and work on something else.

## New work found while you work

Planning or implementing an issue often finds work that must be done but was not requested. **A
session that works a PR opens no other PR.** Only a human message can authorise a second one, or a
`followUp` call with the mode `subagent` or `worktree` from the `workflow` tools (`kb/workflow.md`).
Without this rule, one PR makes a chain of issues, each with its own PR, CI pass and review.

**Related to your issue**, at any size. While a workflow runs, call `followUp` with the mode `this_agent` and skip these steps. Otherwise:

1. **Open it as a sub-issue of your issue.** Create the issue, then link it:
   `gh.sh subissues link <your-issue> <new-issue>`. The board then shows one chain, not two unrelated
   cards.
2. **Mark it as carried by your PR.** Comment `Carried by #<pr>` on the sub-issue and move its card to
   *In progress*, so that a board survey skips it. Add `Closes #<child>` to your PR body, one line per
   sub-issue.
3. **Give it to a teammate on your branch** (`tdd-implementer`). The teammate works it test-first with
   its own review, commits on your branch, and stages files by name. Run teammates in parallel only on
   work in different files. Your PR body gets a section for the sub-issue with its own
   `Test entry point:` line.

Size does not change the rule. A related schema change or a two-day refactor is still a sub-issue in
this PR, done by a teammate.

**Unrelated to your issue**: open a plain issue on the board with the evidence, and continue. Do not
open a PR for it, do not start a worktree for it, and do not link it under your issue. The state
comment ([F6](state.md#f6--continuation-state-and-handoff)) names it so that a human can decide.
