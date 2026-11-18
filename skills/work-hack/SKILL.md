---
name: work-hack
description: "The interactive hack development skill (hack mode). Find a solution by free trial and error with the human, then harden it before it is checked in: tests that pin the behaviour and fail on the base, a clean diff, all the checks, a two-axis review, an adversarial review and a smoke test. Interactive only. Use when the human chooses hack mode, or wants to explore a solution before they commit to a design."
---

# Hack work

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Use this check when you plan architecture or change project rules.

Hack mode has two parts. First, the human and the agent hack at a solution with few rules. Then the agent makes the change strict before any of it is pushed. A human steers hack mode at every step, so it is interactive only: auto steering refuses it.

## The workflow

While the project does not set `"workflow": false` in `.neil-dev.json`, the `mcp__ndev__*` tools carry this method. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`. The answer of each tool names the next step. If it differs from this skill, the answer wins.

| Stage | State | Tool that ends it |
|---|---|---|
| Hack | `developing` | `mcp__ndev__finishedHacking()` |
| Harden | `hardening` | `mcp__ndev__finishedDevelopment(issues, prs, message, files, hardening)` |
| Review | `reviewing` | `mcp__ndev__finishedReview(review, deadcode, remembered)` |
| Checks, smoke, done | `ci`, `smoke`, `finishing` | As in light and heavy mode. |

Hack mode has no interview and no plan. `started` goes straight to `developing`.

## Hack

The aim is a solution that works. Try ideas, throw them away, and follow the human's lead.

- Write the goal of the issue in one line in the PR body. A hack with no goal has no end.
- Commit through `mcp__ndev__checkpoint` as often as is useful. In hack mode it commits on this computer only: it does not push, and no CI runs. `fast-checks.sh` runs and reports, and a failure does not stop the commit.
- Test first is not required here. Spike code, debug output and dead ends are allowed.
- Do not push with `git push`, and do not merge. Nothing leaves this computer before the review.
- When the human agrees that the solution works, call `mcp__ndev__finishedHacking()`.

## Harden

Now the change must meet the rules of heavy mode. The hack skipped test first, so this stage gives the proof that test first gives.

1. Read the whole diff against the base: `git diff origin/<base>...HEAD`. List each behaviour that the change adds or alters.
2. For each behaviour, write a test through a public interface. Mock only external boundaries.
3. Prove that each test fails on the base for the intended reason: put the new tests on a copy of the base (for example `git worktree add <tmp> origin/<base>`, copy the test files in, and run them), and keep the output. An import error or a missing file is not proof. Then show that each test passes on HEAD. Remove the temporary worktree after.
4. Remove the spike code, debug output, commented-out code, dead ends and every comment that fails `${CLAUDE_PLUGIN_ROOT}/kb/comments.md` (keep only a fact that the trial and error found and the next editor needs). Keep the diff to the goal. Put unrelated discoveries in `mcp__ndev__followUp` with `issue_only`.
5. Commit through `checkpoint`. In `hardening`, each commit runs `fast-checks.sh` and `pre-commit-check.sh`, and a failure stops it. Nothing is pushed yet.
6. Call `mcp__ndev__finishedDevelopment` with `hardening`: each test, its failure on the base (the command and the failing line) and its pass on HEAD. The tool runs `pre-push-check.sh` and `gates.sh`, and puts the evidence on the PR.

## Review and after

`finishedDevelopment` starts the two-axis review: one reviewer for the standards and one for the specification. While they run, run an adversarial review with the `ndev:adversarial-review` skill, and run the remember hook (the `remember` skill). Fix what the three reviews find with `checkpoint`. Then call `finishedReview` with the three results: it runs `pre-ready-check.sh`, pushes for the first time and marks the PR ready.

A smoke test on the real preview is due for each hack change. Only a human can skip it, with `/flow skip <reason>`.

## Mixed PRs

A PR that carries issues of more than one mode follows the strictest: light, then hack, then heavy. A hack issue holds the commits of its PR until the review, also when another issue on the PR is light.
