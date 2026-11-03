---
name: implement-spec
description: "Implement a provided specification and its linked tickets on one branch and in one pull request."
disable-model-invocation: true
---

# Implement a spec

Treat the spec as a dependency graph of tickets. Read the spec, the tickets and the relevant repository guidance first. Point to those files; do not copy long explanations.

1. Find the frontier (tickets with no open blocker) and the dependencies. Explore code or external documentation only as needed. Save large findings outside the repository.
2. Use one branch and one PR, which `mcp__ndev__started` opens. The PR closes the spec issue and all its tickets. A ticket never gets its own branch or PR.
3. Implement ready tickets on the shared branch. Work in parallel only when tickets touch disjoint files and share no interface, schema or fixture. Else work in dependency order. Write or change the test first, make the smallest change, and commit with the trailers the repository requires.
4. Recompute the frontier as tickets finish. Continue until every ticket is implemented.
5. When every ticket is implemented, go on with the workflow. Tell the review to check spec coverage as well as repository standards, and fix findings in the same PR.

Use the `work-heavy` and `testing` skills for the worktree, PR, TDD, test-tier, verification and documentation rules.

## The workflow

Call `mcp__ndev__started(issue, shortName)` first, and follow each answer until `mcp__ndev__done`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
