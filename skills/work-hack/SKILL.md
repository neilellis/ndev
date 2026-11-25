---
name: work-hack
description: "The interactive hack development skill (hack mode). Find a solution by free trial and error with the human, and harden it with tests, checks and reviews before it is checked in. Interactive only. Use when the human chooses hack mode, wants to explore a solution before they commit to a design, or wants several UI variants to compare and choose from."
---

# Hack work

Read [the ndev CLI skill](${CLAUDE_PLUGIN_ROOT}/skills/cli/SKILL.md) for native commands and when to use them. Prefer those commands for workflow operations when `ndev` is available. Keep this skill's gates and ownership rules.

Read the applicable parts of the project’s `NORTH_STAR.md`.

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

### Explore UI variants

When the human cannot say how a piece of UI must look or behave, build variants and let the human choose.

- Explore one piece in each round (a toast, a pricing card). For a larger request, start with the piece that has the most effect, and say why.
- Build 3 to 5 variants. Give each one a name that tells its direction ("Quiet", "Dense"), never "Option A", and the axis on which it differs: layout, density, personality, motion or interaction model. Two variants that differ only in colour or copy are one variant.
- Each variant uses the project's tokens and components, and it works fully: real interactions, motion with a reduced-motion state, and realistic content. No lorem ipsum and no dead buttons.
- Put the variants on an isolated surface (a route such as `/prototypes/<slug>`, or one HTML file when there is no app). Production code never imports from it.
- Show one variant at a time, at full size, in its real context. Add a small neutral switcher (keys `1` to `N`, `?v=<n>` kept on reload) that does not use the brand.
- Take a screenshot of each variant and make sure that the console shows no errors. Then show a table: name, axis, when it is the right choice, and what it costs. Do not mark a favourite. The human chooses.

## Harden

Now the change must meet the rules of heavy mode. The hack skipped test first, so this stage gives the proof that test first gives.

1. Read the whole diff against the base: `git diff origin/<base>...HEAD`. List each behaviour that the change adds or alters.
2. For each behaviour, write a test through a public interface. Mock only external boundaries.
3. Prove that each test fails on the base for the intended reason: put the new tests on a copy of the base (for example `git worktree add <tmp> origin/<base>`, copy the test files in, and run them), and keep the output. An import error or a missing file is not proof. Then show that each test passes on HEAD. Remove the temporary worktree after.
4. Remove the spike code, debug output, commented-out code, dead ends, the prototype surface of a UI exploration (unless the human asks to keep it) and every comment that fails `${CLAUDE_PLUGIN_ROOT}/kb/comments.md` (keep only a fact that the trial and error found and the next editor needs). Keep the diff to the goal. Put unrelated discoveries in `mcp__ndev__followUp` with `issue_only`.
5. Commit through `checkpoint`. In `hardening`, each commit runs `fast-checks.sh` and `pre-commit-check.sh`, and a failure stops it. Nothing is pushed yet.
6. Show a concrete development preview when relevant and ask whether the work is done before final checks or review. Keep taking design feedback until the human confirms. Then call `ndev flow finished-development` with `--human-confirmation` containing the human’s answer and `--hardening`: each test, its failure on the base (the command and the failing line) and its pass on HEAD. The tool runs `pre-push-check.sh` and `gates.sh`, and puts the evidence on the PR.

## Review and after

`finishedDevelopment` starts the two-axis review: one reviewer for the standards and one for the specification. While they run, run an adversarial review with the `ndev:adversarial-review` skill, and run the remember hook (the `remember` skill). Fix what the three reviews find with `checkpoint`. Then call `finishedReview` with the three results: it runs `pre-ready-check.sh`, pushes for the first time and marks the PR ready.

A smoke test on the real preview is due for each hack change. Only a human can skip it, with `/flow skip <reason>`.

## Mixed PRs

A PR that carries issues of more than one mode follows the strictest: light, then hack, then heavy. A hack issue holds the commits of its PR until the review, also when another issue on the PR is light.
