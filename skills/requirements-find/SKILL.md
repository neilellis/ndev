---
name: requirements-find
description: "Find the requirements in a project's documents (the requirement documents, the wiki, the README files and the other documents) and write them as requirement records, so that each prose line is cited by a record or held in the ledger with a reason. Use when a project starts requirement records, when a source document changed, or when the user says find requirements, extract requirements, requirements from the docs or account for each line."
---

# Find the requirements in documents

The records, their format and their rules are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md`, and the `requirements` skill holds the commands that write them. Read both first.

The commands are `ndev requirements <command>`. Run them from the project.

| Command | What it does |
|---|---|
| `ndev requirements sources [--tier N]` | Lists the tracked documents by tier: 1 requirements, 2 wiki, 3 readme, 4 other. |
| `ndev requirements uncovered [path...]` | Lists each prose line that no record cites and no ledger entry holds, and marks the normative lines. With no path, it reads the tier 1 documents. It fails while a line remains. |
| `ndev requirements ledger <path> <first> <last> "<reason>"` | Records lines that hold no requirement, with the reason and a hash of the lines. |

## Order

Work tier by tier: tier 1 first, then the wiki, then the README files, then the others. A statement in a lower tier that a higher tier already states is a duplicate: cite it in the same record only when the words are the same, and note it in `## Notes`.

## Procedure

For each document in the tier:

1. Run `ndev requirements uncovered <path>`. Read the document from start to end, not only the lines in the list.
2. For each requirement, search the records first (`ndev requirements search`). If a record covers it, do not write a second one.
3. Write one record for each requirement that can pass or fail by itself:
   - Give the people who wrote the document with `new --author "<name>, <name>"`. Git does not show who wrote a document. Ask the human once for each document, and use the answer for each record from it.
   - Use the document's words for the Statement. Write the Explanation in simple English, and define each glossary, technical or jargon term. Make the Source text with `ndev requirements quote <path> <first> <last>`. Then run `ndev requirements sync <REQ-NNNN>` to write the `source` field.
   - Set the type with `new --type`: `principle`, `product`, `ux`, `design`, `operational`, `architectural`, `implementation` or `process`. The format page, section Types, defines each one.
   - Set the level from the source with `new --level`, or later with `ndev requirements level`: `soft` for a source that is only a message, a call or a post; `normal` for a document that states the requirement; `hard` only for a cornerstone, such as a rule of the north star.
   - A statement that is the document's text word for word, in a document that a human approved, can start `Accepted` with that human in `decided_by` and the evidence of the approval in `## Notes`. Each other statement starts `Proposed`: a reworded, split or merged statement, and a requirement that you inferred.
   - Add a Trace link with `ndev requirements file` or `ndev requirements link`. When nothing implements the requirement yet, open an issue for it and link that. Give a non-functional requirement `nfr: true` in the front matter.
   - An implied requirement (enforced by a test, a schema constraint or a check, but stated in no document) has the origin `implied`, the status `Proposed`, and its evidence in `## Notes`.
4. For each line that holds no requirement, write a ledger entry. Give a reason that a human can check in one look: `background`, `definition of <term>`, `example`, `history`, `navigation`, `lead-in to the list at L<a>-L<b>`, `source line for the list at L<a>-L<b>`, `source register row`, `edit log row`. Give one entry for a range of lines with the same reason. Never use the ledger for a requirement that is hard to write.
5. Run `ndev requirements uncovered <path>` again. Stop when it passes.

## Conflicts

When two sources disagree, or a source disagrees with the code, write each side as its own `Proposed` record, and say in `## Notes` of each which record it conflicts with. Do not choose. Report the conflict to the human with both citations.

## Finish

1. Run `ndev requirements check`, `ndev requirements render` and `ndev requirements uncovered`.
2. Commit the records, `docs/formal/requirements/extra/ledger.md` and the generated file.
3. Report to the human: the documents you read, the number of records (Accepted, Proposed and Open), the number of ledger entries by reason, each conflict, and each document you did not read.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
