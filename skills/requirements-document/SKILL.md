---
name: requirements-document
description: "Write the prose of the generated requirements document: an introduction for each section and the text that links its records, stored with a hash of the records so that a script can tell when it is stale. Use after requirements-find or requirements-retrospective, when narrative fails, when the records of a section changed, or when the user says write the requirements document, narrative or generate the document."
---

# Write the requirements document

The records, their format and their rules are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md` (read "The document"). Read it first.

The commands are `ndev requirements <command>`. Run them from the project.

| Command | What it does |
|---|---|
| `ndev requirements narrative` | Lists each section as current, stale or missing. Fails while one is stale or missing. |
| `ndev requirements narrate "<section>"` | Prints the records of the section and the state of its narrative. |
| `ndev requirements narrate "<section>" --from <file>` | Stores the prose with a hash of the records. Fails a normative sentence that cites no record. |

## The outline

A human owns `docs/formal/requirements/extra/outline.md`. If it does not exist, propose one to the human: a title and the sections in the order that a reader needs them. Do not write it without their agreement. When `render` says that a section is not in the outline, show the human the section and ask where it goes.

## Procedure

1. Run `ndev requirements narrative`. Work on each section that is stale or missing.
2. Run `ndev requirements narrate "<section>"` and read each record of the section. For a stale section, read the old narrative in `docs/formal/requirements/generated/narrative/` too.
3. Write the prose in a file outside the project, for example in your scratch folder:
   - Start with what the section is about and why it matters, in two or three sentences.
   - Then group the records and say how they relate: which one comes first, which one depends on another, and which ones go together.
   - Cite a record by its identifier, for example `(REQ-0012)`. Each sentence that states what the system must do cites the record that states it.
   - Never restate a requirement in other words. The record's Statement is the binding text; the prose points to it. Name what a group of records is about, not what each one requires.
   - When a record's Statement does not stand alone (for example, it starts with "It" or "That"), say what it refers to in the prose, and report the record to the human.
   - Use paragraphs and lists only. The heading comes from the outline.
4. Run `ndev requirements narrate "<section>" --from <file>`. The check reads words, not meaning: it fails each sentence with a normative word, even one that describes a reader or a user. When it fails a sentence, cite the record that states it, or reword the sentence so that it states no requirement. Never cite a record only to pass the check: the record must state the requirement.
5. Run `ndev requirements narrative` again. Stop when it passes.

## Finish

1. Run `ndev requirements render` and open the document. Read each section once from start to end.
2. Commit `docs/formal/requirements/generated/`.
3. Report to the human: the sections you wrote, the sections that were stale and why, and each place where the records of a section seemed to conflict or to leave a gap.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
