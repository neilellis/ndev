---
name: epic-plan
description: "Plan an epic as its coordinator, so that a worker can build each sub-issue from the spec alone. Use in the epic workflow states framing to slicing, when mcp__ndev__epicStarted or /flow epic names this skill."
---

# Plan an epic

Read [the ndev CLI skill](${CLAUDE_PLUGIN_ROOT}/skills/cli/SKILL.md) for native commands and when to use them. Prefer those commands for workflow operations when `ndev` is available. Keep this skill's gates and ownership rules.

You are the **coordinator**: one capable model that plans, decides and verifies. Helpers do the legwork: sub-agents research and scout, a different model reviews the spec. You keep the conclusions and the judgement; they keep the file dumps.

The plan is finished when a worker who has only the spec and one sub-issue can implement that issue without omission, and the human has ruled on every decision.

## The workflow

`mcp__ndev__epicStarted` binds this session to the epic and turns the usual one-issue workflow off for it. Each phase ends with `mcp__ndev__epicPhase(issue, finished, evidence, …)`, which checks the evidence and answers with the next step. Follow that answer; if it differs from this skill, the answer wins. `mcp__ndev__epicStatus` reads the state. The human moves a phase by hand with `/flow epic skip|goto`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`, section "The epic workflow".

| State | Finished when | `epicPhase` needs |
|---|---|---|
| `framing` | The aim, the posture, the form of the spec and the sources are agreed, and the human has signed off the core idea | `aim`, `sources`, `files` (the core idea) |
| `researching` | Every research question has a findings file with its claims labelled | `files` |
| `specifying` | The spec passes the self-check below | `files` (the spec) |
| `deciding` | The human has ruled on every decision and none is open | `evidence` |
| `spec-review` | Every review finding has a ruling written into the spec, and the spec PR refers to the epic | `files` (the reviews), `specPr`, `evidence` |
| `slicing` | The human approved the breakdown, and every sub-issue is filed, linked and blocked-by its dependencies | `issues`, `approval` |

## Framing

Ask the human, in one round, for what code cannot tell you:

- **The aim**: one or two sentences on what the product is for and what this epic changes for it. Every brief and every ruling later quotes it.
- **The posture**: how much durability, backward compatibility and migration care this stage of the project deserves. A prototype and a bank get different specs; without a stated posture, reviewers push toward the bank.
- **The form**: where the spec lives, its format, and how deep it goes. The default is one document in the repository's docs folder with diagrams, written so that another agent can implement from it alone.
- **The gates**: which actions stay with the human (paid calls, hosted data, publishes, merges).
- **The sources**: the documents that the requirements come from, such as the customer prompt, a brief, an issue or the notes of a call. Read each one in full. `epicPhase` records each as a path or a link in `sources`. When there is none, give the reason as `no source: <reason>`. Framing cannot finish without one of the two.

Then write the **one-page core idea** to a file in the repository, so that the human can confirm the one idea that matters before a long spec exists:

- the aim;
- the central mechanism, in a few sentences: how the thing works, not what it touches;
- 3 to 5 worked acceptance examples, each on its own line as `A1: <input> → <expected output>`, taken from the sources where they have one.

Show the page to the human. Change it until the human signs it off, and record the sign-off in the evidence. `epicPhase` takes the page as its one entry in `files`, and refuses fewer than 3 or more than 5 acceptance examples.

When the behaviour or the look of the thing is still open, build a prototype with the `prototype` skill before `specifying`. It answers the question with something the human can try. Keep it out of the product code, and keep it linked from the spec.

## Researching

Write the research questions as a numbered list and give each to one helper, in parallel, with the model that fits (a strong model for audits and hands-on evaluation, a cheaper one for a side read). Give each helper the question, the files or sources, the stop condition and the return format: a findings file with `file:line` or a link for each claim.

Useful helpers, each separate: what was specified (issues, PRs, docs, ADRs and PDRs); what is implemented (verified in code, by a different helper than the one that read the specification); what the outputs must contain (the product's own examples); how the field does it; `ndev:plan-scout` per workstream for the file map, migrations and named tests.

Every claim that shapes a decision carries one label: **ran** (you or a helper executed it and saw the result), **read** (taken from code or a document) or **assumed**. Before an assumed or read claim decides anything, run the cheapest probe that could prove it false: try the access, start the service, run the query on real data. A README is not a measurement.

Number the requirements (R1, R2, …) as you find them. Each R cites the source passage it comes from: the source document and the words it quotes, or "no source" with the human's ruling. The spec traces each R up to its source passage and down to a plan piece.

## Specifying

Write the spec in the agreed form. It opens with the core idea page from framing, as signed off. It holds: the aim and posture; the terms; the current state with `file:line`; the design, with a diagram where a flow or a write order matters; every point where data is written; the decisions log (D1, D2, …); the plan as pieces with dependencies, each with a completion checklist and a verification method (named tests, guards, commands); the traceability table from each requirement up to its source passage and down to its pieces; risks.

The spec also has an **Ask first** section. It lists the gates from framing. It also lists the build actions that need approval, such as a schema change, auth, a delete or a new dependency. Keep it apart from what is out of scope.

Two more sections keep the fog apart from the decided route:

- **Not yet specified**: what is in scope but not sharp enough yet to build from. Name each item and what would make it sharp.
- **Out of scope**: what is ruled out, each item with the reason and who ruled.

Before the human sees it, self-check for the faults a reviewer finds:

- **Contradictions**: one fact stated two ways, most often left behind by an amendment. After each amendment, search the spec for the old wording.
- **Claims about current code**: each is `read` or `ran` at a named line.
- **Order**: nothing reads a value before the step that writes it; no piece depends on a later one.
- **Cannot work as written**: ids, sort orders, one transaction across two stores.
- **Omitted write paths**: every route that changes the data is in the design.
- **Coverage**: each requirement marked covered names the piece that covers it.
- **Source**: every R has a source passage, and every source passage of substance has an R. Read the sources again for this check, not your notes. A requirement with no passage, or a passage with no R, is a departure: rule on it with the human.
- **Size**: a piece one agent can hold; split the others.

## Deciding

Give each decision a stable id (D1, D2, …), the options, your recommendation and its reason. The human can then answer "D3 yes, D4 no".

**Challenge every answer you do not fully agree with.** An answer is input to the design, not a go-ahead. For each one, say "agree" or state the reservation and what you recommend in its place; the human then rules. Record the ruling in the spec's decisions log in the human's own words. Write a ruling that amends a requirement as a PDR (`adr-pdr` skill), with the human's ruling as the source.

Test each ruled D against the three ADR tests of `${CLAUDE_PLUGIN_ROOT}/kb/adr.md`: hard to reverse, surprising later, and a real trade-off. A D that passes all three becomes `docs/adr/NNNN-<decision>.md` in the kb/adr.md form, with the human's ruling as its source and the options that lost. It is linked from the D-entry, and the ADR links back. A D that fails a test stays in the decisions log only.

Put the terms of the spec into the project glossary (`GLOSSARY.md` at the root, or where the project keeps it): each term, its meaning in one sentence, and the words to avoid. Change a term that is there already only with the human.

A choice can be irreversible or costly, such as a schema, a public API or a data migration. Before the spec fixes one, get a second opinion with the `second-opinion` skill. Write its record in the decisions log.

While this phase is open, change only the spec. File sub-issues, publish and start workers after the spec review, when the human says planning is over.

When the human asks a question, answer it before any other work. In a status line, name what you are waiting for from the human and what you have already settled, so that a recorded ruling does not read as an open question.

## Spec review

Send the spec to a reviewer on a different model (an Orca worker, see the `orchestration` skill; for a second opinion use a second model and forbid it to read the first review until its own is written). Give the reviewer the sources and the core idea from framing. The brief asks the reviewer to check the design against the core idea and each of its acceptance examples, and asks for findings in these groups: departures of the spec from the source (a requirement the source does not hold, a passage the spec drops or changes); contradictions; wrong claims about current code; design faults; omissions; sequencing and size; risks to the rules in `CLAUDE.md`, `AGENTS.md`, the wiki and the ADRs; strengths. Each finding names the spec section, quotes the passage, gives `file:line`, the reason and the fix. Name the one file the reviewer may write. Tell it to read a long file in ranges.

Rule on every finding against the aim and the posture: **fix** (amend the spec) or **dropped** with the reason, most often over-engineering. Write the table of findings and rulings into the spec. Take to the human only the findings that change a decision they made.

Open the spec PR with `Refs #<epic>` in its body, never a closing keyword (Closes, Fixes, Resolves) for the epic: merged, such a PR closes the epic before any sub-issue is built. Give its number in `specPr`. `epicPhase` reads the PR and refuses a body that closes the epic or does not say `Refs #<epic>`.

## Slicing

Slice only when the spec has passed review and is merged to the default branch, so that each worker reads it from its base.

- File no sub-issue for an item that is Not yet specified. When it becomes clear, it goes back through deciding and a spec amendment, and is sliced after that.
- Cut tracer-bullet vertical slices. Each slice is a narrow complete path through every layer it needs, so that a worker can verify it alone. Do not cut by layer, such as all the schema first and all the API after.
- Put prefactoring first: a change that makes the later slices easy and changes no behaviour is an early slice of its own.
- For a wide refactor, use expand–contract: add the new form beside the old one, move the callers over in slices, then remove the old form in a last slice.
- The first sub-issue is a thin end-to-end slice that proves the core idea on one acceptance example. It goes through every layer the idea needs, and does nothing more.
- One sub-issue is one workspace and one pull request. Group pieces that touch the same files; keep an issue small enough that an agent does not forget part of it.
- Each issue body has: why (the aim); the spec sections to read; the scope; the completion checklist; the verification (tests first, the commands); `Depends on`; the rules of the work. Point to the spec.
- Record each dependency as a blocked-by link, and only where it is real: a shared interface, schema, fixture or file. Order the early issues so that the first ones unblock the most.
- Generate the issues with one script from the plan rows, run it dry first, and keep the key-to-number map it writes.

Show the breakdown to the human before any issue is filed: a table with one row for each sub-issue, with its title, blocked by, what it delivers. File nothing until the human approves it. Record the approval in the human's words in `approval`.

Keep to the cap of 30 sub-issues. Above it, split the epic into child epics, each with its own part of the spec. Each child epic is an epic issue of its own, planned and coordinated with its own `/flow epic`. Only the human can keep more than 30 in one epic: give the human's reason in `capOverride`, and the tool records it as gate-override debt for closing.

`mcp__ndev__epicPhase(finished: "slicing", issues: […], approval)` checks the approval, the cap and the graph (no cycle, no unknown blocker, every issue open) and moves to `coordinating`. Then load `ndev:epic-coordinate`.
