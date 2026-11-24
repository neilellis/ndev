---
name: remember
description: "Record durable project facts and corrections in the owning wiki, skill, guide or memory. Use before a PR leaves draft or when asked to remember. Use dev-wiki for lessons that apply across projects."
---

# Record what was learned

Harvest only facts that change future behaviour. A cosmetic change or an unproven hypothesis is not a lesson.

A correction is a fact, in each of its forms: the user's words, an edit the user made to a file you wrote, a revert or a rejected variant, and repeated nudges ("smaller", "still too big", "ok"). For nudges, record the value the user accepted, not the steps.

For each fact, ask what it replaced. If a documented claim became false, run `forget` for it.

## Route each fact to exactly one home

The project's wiki is a compounding, interlinked, current-state knowledge base that agents keep (the plugin's `kb/llm-wiki.md`). Most facts go there.

| Fact | Home |
|---|---|
| system, code, pipeline or CI | wiki `dev/...` |
| domain or policy | wiki `domain/...` |
| UI or design decision | wiki `visual/...` (the design system, if the project has one) |
| a rule that a code match can find (a banned value, a raw colour where a token exists) | a guard or lint rule (`${CLAUDE_PLUGIN_ROOT}/kb/guards.md`), whose message holds the reason. Run it on the tree first and report the existing violations by count; do not change product code to clear them unless the user says so |
| a plan not yet built | wiki `future/...` |
| a decision about how it is built, with the options turned down | an ADR in `docs/adr/` (`adr-pdr` skill) |
| an amendment to scope or to a requirement | a PDR in `docs/pdr/` (`adr-pdr` skill), and the requirement's own text edited to match |
| explainer for readers outside the development team | the human docs site, if the project has one |
| reusable agent procedure for this project | the project's skill (`.claude/skills/<skill>/SKILL.md`, and `.agents/skills/` for Codex) |
| repository convention | `CLAUDE.md` / `AGENTS.md`, or the guide that applies |
| reusable lesson across projects | the `dev-wiki` skill |
| person, session or machine state | agent memory |

The routing test for the wiki: **would this fact still be true if the system were rewritten in a different language?** Yes: `domain/`. No: `dev/`.

## Write it

- Read the wiki's `AGENTS.md` and the `docs` skill before a wiki edit.
- A wiki ingest updates the page and its folder note, and adds one new file `.log/YYYY-MM-DD-<slug>.md` in the section.
- Write the current state. Do not add history.
- Give each rule its reason: the user's reason when they gave one. Mark a reason you guessed "unverified", and ask the user to confirm it.
- Write for an agent that was not in the session: name the component class, the value, the token or the file.
- Write a UI rule for the narrowest class that protects the next, different component: "raised surfaces (cards, popovers, menus)", not "the pricing card" and not "every element".
- If a rule already said it and the session broke it again, that rule failed. Make it stricter (a number, a token, "never"); do not add a second rule.
- Update an existing memory file and its index line. Do not make a near-duplicate.
- If both harness trees exist, run `harness-sync` after a skill edit.

Make repository edits in a worktree and pull request, unless you are already on the branch that owns them. Report each destination separately.

## The workflow

`mcp__ndev__finishedDevelopment` fires the remember hook, because the record must be right before the push. Give what you recorded to `mcp__ndev__finishedReview` as `remembered`, or `nothing: <reason>`. Commit with `mcp__ndev__checkpoint`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
