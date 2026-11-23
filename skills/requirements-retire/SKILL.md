---
name: requirements-retire
description: "Retire a prose document whose requirements are now in the records: freeze a copy for the citations, delete the document, and point the references at the records. Use after requirements-find, requirements-document and requirements-publish, or when the user says retire the guide, the records replace this document, or remove the old requirements document."
---

# Retire a document

The records, their format and their rules are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md` (read "Retirement"). Read it first.

The commands are `ndev requirements <command>`. Run them from the project.

| Command | What it does |
|---|---|
| `ndev requirements references <path>` | Lists each line of a tracked file that names the document or links to it. It leaves out the document, the records folder and the published pages. |
| `ndev requirements retire <path>... --pdr <file> [--keep <file>,<file>]` | Fails while a line of the document is not accounted for, while another tracked file references it, or when the decision record does not name it. Then it freezes a copy, deletes the document and adds a line to `docs/formal/requirements/extra/retired.md`. |

Retirement does not change a Statement or a Source text. The citations keep the path of the document, and the script reads the cited lines from the frozen copy.

## Procedure

1. Make sure that the records hold the document. Run these commands, and fix each failure with the `requirements-find`, `requirements-document` and `requirements-publish` skills:
   - `ndev requirements uncovered <path>`;
   - `ndev requirements narrative`;
   - `ndev requirements render --check`;
   - `ndev requirements publish --check`, when the project has `publish.json`.
2. Ask the human to agree to the retirement. Show them the document, the sections that hold its requirements and the published pages.
3. Write a PDR with the `adr-pdr` skill. It names the document by its path, says that the records replace it, and names the human who decided.
4. Run `ndev requirements references <path>`. Change each line that it lists:
   - a link to the document goes to the published page of the section, or to the records folder;
   - a sentence that names the document names the records instead.
   The command finds the full path and Markdown links, inline and reference style. It does not find the bare file name: also run `git grep -n "<file name>"` and change each line that means the document.
   Do not change a file that is history, such as an applied migration. Name it in `--keep`, and tell the human.
   Do not change the frozen copy, the records or the ledger. When a generator writes the line, change the generator and run it again.
5. Run `ndev requirements retire <path>... --pdr <file>`, with `--keep` when needed. Retire documents that link to each other in one command: the references between them do not count, and their quoted lines do not change. When it fails, do the step that it names and run it again.
6. Run `ndev requirements check`, `render` and `publish`. The links to the cited lines now go to the frozen copy.
7. Run the project's own checks and build. A check that reads the document now fails: change the check to read the records.

## Finish

1. Commit the deletion, the frozen copy, `retired.md`, the PDR, the changed references and the generated pages together.
2. Report to the human: the document, the PDR, the number of references that you changed, and the checks that you ran with their result.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
