# Product decision records

[kb](README.md) › pdr

**A PDR records one decision that changes the scope or the requirements: what the system must do, what a check or a report must contain, or how a result is judged.** It holds who decided, the source, the options considered and what follows, so that a later reader can trace why a requirement changed.

The requirement text is edited in place and always states the present. The PDR is the amendment record: it quotes the old wording and says who changed it, when and why. A decision about how the system is built is an [ADR](adr.md). The rules that both share (human approval, numbering, supersession, search) are on that page.

## When to write a PDR

Write it in the same PR as any of these:

- An edit to the project's `NORTH_STAR.md`, or to a requirement document (a requirements folder, a prompt or contract that states what the output must contain).
- A check, rule or gate added, removed, narrowed or widened because the requirement changed, and not because the code is being restructured.
- A change to a stored expected output (a golden file) or to an evaluation baseline that the owner decided.
- A ruling by the owner that settles a conflict between two rules, documents or checks.
- A change of scope: an item added to or dropped from an epic's goal, or a new requirement from a source (a message, a review, a customer or partner ruling).

Do not write one for a bug fix, a refactor or a test fix that changes no requirement.

## Who decides

The owner of the requirement decides. An agent never amends a requirement on its own account. When work shows that a requirement is wrong or in conflict, the agent finds the evidence, states the options, and asks the human (the `interview` skill in an interactive session). The human's answer is the `Source` of the record. Under auto steering, the agent writes the PDR as `Proposed`, says in the PR what approval is missing, and does not change the requirement text until the human accepts it.

## Name and place

`docs/pdr/NNNN-<slug>.md`, for example `docs/pdr/0001-describe-evidence-scope-without-narrating-absence.md`. The title in the file is the decision as a sentence.

## Template

```markdown
# <the decision, as a sentence>

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD
- Decided by: <name>
- Source: <message, comment or document that carries the decision>
- Issue: <link>. PR: <link>
- Requirement changed: <full path and section, or "none: scope only">

## Context

What forced the decision. Quote the rules or text in conflict, each with its path and line. Quote the old wording of a requirement that changes.

## Decision

What was decided, in plain sentences.

## Considered options

- Option, and why it was or was not chosen.

## Consequences

What changes in code, checks, prompts and docs, and what stays the same.
```

`records.mjs new pdr "<the decision as a sentence>" --issue <link>` creates the next numbered file from this template with the status `Proposed`.

## Rules for PDRs

- If the project keeps an edit log of its requirements, the amendment gets its row there, and the row links to the PDR.
- When a PDR forces a design change, write an ADR for it. Link the two both ways: `Related PDR` in the ADR, and the ADR in the PDR's Consequences.
- A change to a golden file or a baseline names the owner who checked it, and the date, in Consequences.
- Never hide a conflict between two requirements. A PDR that settles it names both and says which one wins and why.
