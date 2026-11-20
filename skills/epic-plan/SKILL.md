---
name: epic-plan
description: "Plan an epic as its coordinator: frame the aim, send helpers to research, write the spec, settle each decision with the human, get an external spec review, then slice the spec into sub-issues with dependencies. Use in the epic workflow states framing to slicing, when mcp__ndev__epicStarted or /flow epic names this skill."
---

# Plan an epic

You are the **coordinator**: one capable model that plans, decides and verifies. Helpers do the legwork: sub-agents research and scout, a different model reviews the spec. You keep the conclusions and the judgement; they keep the file dumps.

The plan is finished when a worker who has only the spec and one sub-issue can implement that issue without omission, and the human has ruled on every decision.

## The workflow

`mcp__ndev__epicStarted` binds this session to the epic and turns the usual one-issue workflow off for it. Each phase ends with `mcp__ndev__epicPhase(issue, finished, evidence, …)`, which checks the evidence and answers with the next step. Follow that answer; if it differs from this skill, the answer wins. `mcp__ndev__epicStatus` reads the state. The human moves a phase by hand with `/flow epic skip|goto`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`, section "The epic workflow".

| State | Finished when | `epicPhase` needs |
|---|---|---|
| `framing` | The aim, the posture and the form of the spec are agreed | `aim` |
| `researching` | Every research question has a findings file with its claims labelled | `files` |
| `specifying` | The spec passes the self-check below | `files` (the spec) |
| `deciding` | The human has ruled on every decision and none is open | `evidence` |
| `spec-review` | Every review finding has a ruling written into the spec | `files` (the reviews), `evidence` |
| `slicing` | Every sub-issue is filed, linked and blocked-by its dependencies | `issues` |

## Framing

Ask the human, in one round, for what code cannot tell you:

- **The aim**: one or two sentences on what the product is for and what this epic changes for it. Every brief and every ruling later quotes it.
- **The posture**: how much durability, backward compatibility and migration care this stage of the project deserves. A prototype and a bank get different specs; reviewers push toward the bank unless the spec says otherwise.
- **The form**: where the spec lives, its format, and how deep it goes. The default is one document in the repository's docs folder with diagrams, written so that another agent can implement from it alone.
- **The gates**: which actions stay with the human (paid calls, hosted data, publishes, merges).

## Researching

Write the research questions as a numbered list and give each to one helper, in parallel, with the model that fits (a strong model for audits and hands-on evaluation, a cheaper one for a side read). Give each helper the question, the files or sources, the stop condition and the return format: a findings file with `file:line` or a link for each claim.

Useful helpers, each separate: what was specified (issues, PRs, docs); what is implemented (verified in code, by a different helper than the one that read the specification); what the outputs must contain (the product's own examples); how the field does it; `ndev:plan-scout` per workstream for the file map, migrations and named tests.

Every claim that shapes a decision carries one label: **ran** (you or a helper executed it and saw the result), **read** (taken from code or a document) or **assumed**. Before an assumed or read claim decides anything, run the cheapest probe that could prove it false: try the access, start the service, run the query on real data. A README is not a measurement.

Number the requirements (R1, R2, …) as you find them. The spec traces each to a plan piece.

## Specifying

Write the spec in the agreed form. It holds: the aim and posture; the terms; the current state with `file:line`; the design, with a diagram where a flow or a write order matters; every point where data is written; the decisions table; the plan as pieces with dependencies, each with a completion checklist and a verification method (named tests, guards, commands); the traceability table from each requirement to its pieces; risks.

Before the human sees it, self-check for the faults a reviewer finds:

- **Contradictions**: one fact stated two ways, most often left behind by an amendment. After each amendment, search the spec for the old wording.
- **Claims about current code**: each is `read` or `ran` at a named line.
- **Order**: nothing reads a value before the step that writes it; no piece depends on a later one.
- **Cannot work as written**: ids, sort orders, one transaction across two stores.
- **Omitted write paths**: every route that changes the data is in the design.
- **Coverage**: each requirement marked covered names the piece that covers it.
- **Size**: a piece one agent can hold; split the others.

## Deciding

Give each decision a stable id (D1, D2, …), the options, your recommendation and its reason. The human can then answer "D3 yes, D4 no".

**Challenge every answer you do not fully agree with.** An answer is input to the design, not a go-ahead. For each one, say "agree" or state the reservation and what you recommend in its place; the human then rules. Record the ruling in the spec in the human's own words.

While this phase is open, change only the spec. File sub-issues, publish and start workers after the spec review, when the human says planning is over.

When the human asks a question, answer it before any other work. In a status line, name what you are waiting for from the human and what you have already settled, so that a recorded ruling does not read as an open question.

## Spec review

Send the spec to a reviewer on a different model (an Orca worker, see the `orchestration` skill; for a second opinion use a second model and forbid it to read the first review until its own is written). The brief asks for findings in these groups: contradictions; wrong claims about current code; design faults; omissions; sequencing and size; risks to the project's rules; strengths. Each finding names the spec section, quotes the passage, gives `file:line`, the reason and the fix. Name the one file the reviewer may write. Tell it to read a long file in ranges.

Rule on every finding against the aim and the posture: **fix** (amend the spec) or **dropped** with the reason, most often over-engineering. Write the table of findings and rulings into the spec. Take to the human only the findings that change a decision they made.

## Slicing

Slice only when the spec has passed review and is merged to the default branch, so that each worker reads it from its base.

- One sub-issue is one workspace and one pull request. Group pieces that touch the same files; keep an issue small enough that an agent does not forget part of it.
- Each issue body has: why (the aim); the spec sections to read; the scope; the completion checklist; the verification (tests first, the commands); `Depends on`; the rules of the work. Point to the spec.
- Record each dependency as a blocked-by link, and only where it is real: a shared interface, schema, fixture or file. Order the early issues so that the first ones unblock the most.
- Generate the issues with one script from the plan rows, run it dry first, and keep the key-to-number map it writes.

`mcp__ndev__epicPhase(finished: "slicing", issues: […])` checks the graph (no cycle, no unknown blocker, every issue open) and moves to `coordinating`. Then load `ndev:epic-coordinate`.
