# Architecture decision records

[kb](README.md) › adr

**An ADR records what was chosen and what was turned down, so that nobody proposes a rejected option again without new evidence.** The wiki holds the current state. The ADR holds the reason and the alternatives.

## When to write one

- A choice that is expensive to reverse.
- A choice where a reasonable person would propose the alternative.
- A choice that a guard or a rule now enforces.

## Name and place

- `docs/adr/NNNN-<the-decision-as-a-sentence>.md`. For example: `0003-a-pattern-over-the-tree-is-an-ast-grep-rule.md`.
- The file name states the decision, so a list of file names reads as a list of decisions.
- Numbers increase and are never reused.

## Structure

```markdown
# NNNN — <the decision as a sentence>

**Status:** accepted, YYYY-MM-DD · **Issue:** #N · **Supersedes:** none · **Amends:** none

## The decision
What we do now, in a few sentences or a small table.

## Why
The problem, and the evidence that the decision fixes it. Use measurements.

## Why not the alternatives
Each rejected option, and the specific reason it lost.

## Consequences
What this costs, and what now enforces it.
```

## Rules

- An ADR is not edited to change its decision. A new ADR supersedes it, and the old ADR's status names the new one.
- A status line is the only part of an old ADR that changes.
- "Why not the alternatives" is the most important section. Without it, the ADR does not stop a rejected option coming back.
- Link the wiki page for the subject to the ADR, and the ADR to the wiki page.
