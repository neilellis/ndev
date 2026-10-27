---
name: implement-spec
description: "Implement a provided specification and its linked tickets on one branch and in one pull request."
disable-model-invocation: true
---

# Implement a spec

Treat the spec as a dependency graph of tickets. Read the spec, the tickets and the relevant repository guidance first. Point to those files; do not copy long explanations.

1. Find the frontier (tickets with no open blocker) and the dependencies. Explore code or external documentation only as needed. Save large findings outside the repository.
2. Make one feature branch and worktree from `origin/<base>` (`${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree_claim.sh`), and one draft PR that closes the spec issue and all its tickets. A ticket never gets its own branch or PR.
3. Implement ready tickets on the shared branch. Work in parallel only when tickets touch disjoint files and share no interface, schema or fixture. Else work in dependency order. Write or change the test first, make the smallest change, and commit with the trailers the repository requires.
4. Recompute the frontier as tickets finish. Continue until every ticket is implemented.
5. Run the relevant checks. Then review the whole PR for spec coverage and repository standards (one independent review). Fix findings in the same PR.
6. Mark the PR ready only when the checks pass and the plan, tests and closing references are complete.

Use the `work-heavy` and `testing` skills for the worktree, PR, TDD, test-tier, verification and documentation rules.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
