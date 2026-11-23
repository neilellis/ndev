---
name: adr-pdr
description: "Search, write and check the project's decision records: ADRs in docs/adr (how the system is built, and the options turned down) and PDRs in docs/pdr (amendments to scope and requirements). Use before you design or change behaviour, when a decision or a requirement changes, or when the user says ADR, PDR, decision record or \"why did we decide\"."
---

# Decision records

Two folders hold the reasons that the code and the wiki do not:

| Record | Holds | Folder |
|---|---|---|
| ADR | A decision about how the system is built, and the options that lost | `docs/adr/` |
| PDR | An amendment to scope or to a requirement: what changed, who decided, why | `docs/pdr/` |

The method, the scope of each kind, the rules and the templates are in `${CLAUDE_PLUGIN_ROOT}/kb/adr.md` and `${CLAUDE_PLUGIN_ROOT}/kb/pdr.md`. Read the page for the kind you write.

The helper is `${CLAUDE_PLUGIN_ROOT}/skills/adr-pdr/scripts/records.mjs`. Run it with `node` from the project. It reads the git top level, or `--root <dir>`.

| Command | What it does |
|---|---|
| `records.mjs search <term>... [--kind adr\|pdr]` | Lists the records that hold every term, with status and title. Says how many records it searched when none match. |
| `records.mjs list [adr\|pdr]` | Lists each record with its status and title. |
| `records.mjs new adr\|pdr "<the decision as a sentence>" [--issue <link>]` | Creates the next numbered record from the template, status `Proposed`, and prints its path. |
| `records.mjs check` | Fails a bad name, a duplicate number, a bad or dangling status, and a non-`Proposed` record with an empty field or section. |

## Search

Search before you plan, design or change behaviour, and again when the work touches a limit, a check, an interface or a stored output. Use the words of the area, the file or the requirement.

- An `Accepted` record is settled. Do not reopen it without new evidence, and name the evidence if you do.
- A `Superseded by NNNN` record is history. Read the record that replaced it.
- A `Proposed` record is an open question for a human, not a rule.
- No match is a result, not a failure. Say that you searched, and what for.

## Record

Write the record in the PR that makes the change.

1. Decide the kind. A change to **what the system must do** is a PDR. A choice of **how it is built** is an ADR. A change that is both gets both, linked both ways.
2. Create it with `records.mjs new`. Fill every section from the evidence: quote the conflicting text with its path and line, and give each option that lost its specific reason.
3. Get the human. They decide, and the record names them, the date and the source. In an interactive session, ask with the `interview` skill and use its issue comment as the source. Under auto steering, leave the status `Proposed`, say in the PR what approval is missing, and do not change a requirement's text until the human accepts the PDR.
4. When the human accepts, set the status to `Accepted`, `Decided by`, `Source` and the date. An agent never accepts its own record.
5. To replace a decision, write a new record and set the old record's status to `Superseded by NNNN`. Change nothing else in the old record.
6. Link the record from the wiki page for its subject. Add the amendment to the requirements edit log if the project has one.
7. Run `records.mjs check`.

Do not write a record for a bug fix, a refactor that keeps the design, or a test fix.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each record with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. A decision that waits on a human goes to `mcp__ndev__blocked`, or to the interview. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
