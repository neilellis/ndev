---
name: work-interactive
description: "Design an underspecified feature with the user, resolve assumptions and test entry points, then implement it or publish vertical-slice issues."
disable-model-invocation: true
---

# Design work with the user

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Read the applicable sections before you propose a design that affects project goals or rules.

Use this for a new idea, a vague request, or an issue with no contract that you can implement. Do not use it for a specified issue or a queue of ready work.

## The workflow

The `mcp__ndev__*` tools carry each development session: call `mcp__ndev__started(issue, shortName)` first, and follow the next step that each tool answers with. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Prepare

Before you ask questions, read the project's glossary (for example `CONTEXT.md`), its domain notes, the relevant pages of the project's wiki (start at its index) and the applicable decision records (ADRs). Look up facts in the repository; do not ask the user for them.

## Interview

- Cover the whole area of uncertainty in small rounds. Ask only decisions that the code and docs cannot answer. Stop and let the user answer.
- Resolve terms against the glossary. Write accepted terms into the glossary. Verify behaviour claims against the code.
- Do not reopen a recorded decision without new evidence.
- Agree one or a few observable `Test entry point:` locations. Prefer an existing entry point at the highest boundary that can see the changed behaviour. Use the `testing` skill for test-tier and resource rules.
- Record assumptions and what is out of scope.

## Deliver

- **One coherent session:** implement it with the `work-heavy` skill (or `work-light` for a small change), in one worktree and one PR.
- **Several sessions or people:** write a spec: problem, solution, behaviour, decisions, testing, out of scope. Split it into vertical slices. Each slice can be demonstrated alone, fits one agent session and declares its blockers. Show the slices to the user. Then create one issue for each: outcome, test entry point, acceptance criteria, blockers. Link the dependencies with the `github` skill. Do not create duplicate or speculative tickets.

Keep plans readable for the user. Keep the user's authorisation boundary: a plan does not authorise implementation, external writes or a release until the user accepts that next step.
