---
name: requirements-document
description: "Write the prose of the generated requirements document: an introduction for each section and the text that links its records, stored with a hash of the records so that a script can tell when it is stale. Use after requirements-find or requirements-retrospective, when narrative fails, when the records of a section changed, or when the user says write the requirements document, narrative or generate the document."
---

# Write the requirements document

The records, their format and their rules are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md` (read "The document"). Read it first.

The helper is `${CLAUDE_PLUGIN_ROOT}/scripts/requirements/requirements.mjs`. Run it with `node` from the project.

| Command | What it does |
|---|---|
| `requirements.mjs narrative` | Lists each section as current, stale or missing. Fails while one is stale or missing. |
| `requirements.mjs narrate "<section>"` | Prints the records of the section and the state of its narrative. |
| `requirements.mjs narrate "<section>" --from <file>` | Stores the prose with a hash of the records. Fails a normative sentence that cites no record. |

## The outline

A human owns `docs/formal/requirements/extra/outline.md`. If it does not exist, propose one to the human: a title and the sections in the order that a reader needs them. Do not write it without their agreement. When `render` says that a section is not in the outline, show the human the section and ask where it goes.

## Procedure

1. Run `requirements.mjs narrative`. Work on each section that is stale or missing.
2. Run `requirements.mjs narrate "<section>"` and read each record of the section. For a stale section, read the old narrative in `docs/formal/requirements/generated/narrative/` too.
3. Write the prose in a file outside the project, for example in your scratch folder:
   - Start with what the section is about and why it matters, in two or three sentences.
   - Then group the records and say how they relate: which one comes first, which one depends on another, and which ones a reader must take together.
   - Cite a record by its identifier, for example `(REQ-0012)`. Each sentence that states what the system must do cites the record that states it.
   - Never restate a requirement in other words. The record's Statement is the binding text; the prose points to it.
   - Use paragraphs and lists only. The heading comes from the outline.
4. Run `requirements.mjs narrate "<section>" --from <file>`. When it fails a sentence, cite the record, or reword the sentence so that it states no requirement. Never cite a record only to pass the check: the record must state the requirement.
5. Run `requirements.mjs narrative` again. Stop when it passes.

## Finish

1. Run `requirements.mjs render` and open the document. Read each section once from start to end.
2. Commit `docs/formal/requirements/generated/`.
3. Report to the human: the sections you wrote, the sections that were stale and why, and each place where the records of a section seemed to conflict or to leave a gap.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
