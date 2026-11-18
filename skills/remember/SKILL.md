---
name: remember
description: "Record durable, non-obvious lessons from the session in the correct project wiki, skill, guide or memory home. Use before a PR leaves draft or when explicitly asked to remember. Also invoked as /r."
---

# Record what was learned

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Use this check when you record a statement about how the project must work.

Harvest only facts that change future behaviour. A cosmetic change or an unproven hypothesis is not a lesson.

For each fact, ask what it replaced. If a documented claim became false, run `forget` for it.

## Route each fact to exactly one home

The project's wiki is a compounding, interlinked, current-state knowledge base that agents keep (the plugin's `kb/llm-wiki.md`). Most facts go there.

| Fact | Home |
|---|---|
| system, code, pipeline or CI | wiki `dev/...` |
| domain or policy | wiki `domain/...` |
| UI or design decision | wiki `visual/...` (the design system, if the project has one) |
| a plan not yet built | wiki `future/...` |
| explainer for stakeholders | the human docs site, if the project has one |
| reusable agent procedure for this project | the project's skill (`.claude/skills/<skill>/SKILL.md`, and `.agents/skills/` for Codex) |
| repository convention | `CLAUDE.md` / `AGENTS.md`, or the guide that applies |
| reusable lesson across projects | the `dev-wiki` skill |
| person, session or machine state | agent memory |

The routing test for the wiki: **would this fact still be true if the system were rewritten in a different language?** Yes: `domain/`. No: `dev/`.

## Write it

- Read the wiki's `AGENTS.md` and the `docs` skill before a wiki edit.
- A wiki ingest updates the page and its folder note, and adds one new file `.log/YYYY-MM-DD-<slug>.md` in the section.
- Write the current state. Do not add history.
- Update an existing memory file and its index line. Do not make a near-duplicate.
- If both harness trees exist, run `harness-sync` after a skill edit.

Make repository edits in a worktree and pull request, unless you are already on the branch that owns them. Report each destination separately.

## The workflow

`mcp__ndev__finishedDevelopment` fires the remember hook, because the record must be right before the push. Give what you recorded to `mcp__ndev__finishedReview` as `remembered`, or `nothing: <reason>`. Commit with `mcp__ndev__checkpoint`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
