# Architecture decision records

[kb](README.md) › adr

**An ADR records one decision about how the system is built, and what was turned down, so that nobody proposes a rejected option again without new evidence.** The wiki holds the current state. The ADR holds the reason and the alternatives.

A decision that changes what the system must do (scope or a requirement) is a [PDR](pdr.md). This page also holds the rules that ADRs and PDRs share.

| Record | Answers | Folder |
|---|---|---|
| ADR | How is it built or designed, and why this way? | `docs/adr/` |
| PDR | What must it do, and who decided that? | `docs/pdr/` |

A change can need both. The PDR changes the requirement. The ADR records the design that the new requirement forces. Link the two both ways.

## When to write an ADR

Write it in the same PR as the change, when any of these is true:

- The change picks between designs that code depends on: where data is stored, which service or library, how a limit is measured, which process owns a job.
- The change adds or alters an interface that other code must follow.
- The change edits the project's specification, including a decision id in it.
- The choice is expensive to reverse, or a reasonable person can propose the alternative, or a guard or rule now enforces it.

Do not write one for a bug fix, a refactor that keeps the design, or a test fix.

## Search before you decide

Accepted records are settled. Search them before you plan, design or change behaviour, and do not reopen one without new evidence. The records helper searches both folders:

```sh
node ${CLAUDE_PLUGIN_ROOT}/skills/adr-pdr/scripts/records.mjs search <term>...
```

A record whose status is `Superseded by NNNN` is history. Read the record that replaced it.

## Rules (ADRs and PDRs)

- **A human approves.** An accepted record names that human, the date and the source (a message, an issue comment, a document). An agent writes `Proposed` and the PR says what approval is missing. An agent never marks its own record `Accepted`.
- **One record for each decision.** Number it with the next free number in the folder. Numbers are never reused. If two PRs take the same number, the PR that merges second renumbers.
- **An accepted record is not edited.** Only its `Status` line and its links change. A decision that replaces it is a new record with a higher number, and the old one gets `Superseded by NNNN`. Set that status only when a human has accepted the new record. A record that was never filled in cannot become `Superseded`: fill it first.
- **Considered options is the most important section.** Without it, the record does not stop a rejected option coming back. Give each option and the specific reason it lost.
- **Name every file by its full path** from the repository root, and every issue and PR by its link.
- **Link the record to the wiki page** for its subject, and the wiki page to the record. The wiki describes the present. The record keeps the reason.
- **Write it in the PR that makes the change.** A record that comes later is a guess about the reason.

## Name and place

`docs/adr/NNNN-<slug>.md`, for example `docs/adr/0003-a-pattern-over-the-tree-is-an-ast-grep-rule.md`. The slug is lowercase words joined by hyphens. The title in the file is the decision as a sentence, so a list of titles reads as a list of decisions.

## Template

```markdown
# <the decision, as a sentence>

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD
- Decided by: <name>
- Source: <message, comment or document that carries the decision>
- Issue: <link>. PR: <link>
- Related PDR: <path, or "none">

## Context

What forced the decision, and the code or spec it touches, each with its full path.

## Decision

What was decided, in plain sentences.

## Considered options

- Option, and why it was or was not chosen.

## Consequences

What changes in code, tests and docs, and what stays the same.
```

`records.mjs new adr "<the decision as a sentence>" --issue <link>` creates the next numbered file from this template with the status `Proposed`.

## Enforcement

`records.mjs check` ignores dotfiles, folders and files that are not markdown. It fails a record in the old format (`**Status:**` line, `# NNNN —` title) and names the rewrite. It fails a bad file name, a duplicate number, a status that is not one of the three, a `Superseded by` that names no record, and a record that is not `Proposed` and has an empty field or section. Run it in the project's checks.

A project can go further with a guard. The guard fails a change to a governed file (the North Star, the requirements, the specification) unless the same change adds or edits a record. The fcc-proto guard is the model: `scripts/ci/adr-guard.sh` in [TathataSystems/fcc pull request 1706](https://github.com/TathataSystems/fcc/pull/1706).

- It reads the whole branch against the base.
- It counts no deleted record.
- It waives a typo, a link or a rename only with a commit trailer, `PDR-Unchanged: <reason>` or `ADR-Unchanged: <reason>`, and it prints the reason.

A guard cannot see a check or a limit that changes in code. The PR author writes the record, and the reviewer asks for it.
