---
name: requirements
description: "Search, write and check the project's requirement records in docs/formal/requirements: one file for each requirement, with an identifier (REQ-NNNN), its binding statement, its quoted source text and its trace links. Use before you change behaviour, when you must know what the system is required to do, when you write or check a requirement record, or when the user says requirement, REQ, traceability or \"is this a requirement\"."
---

# Requirement records

`docs/formal/requirements/` holds one file for each requirement. The records are the governing text: the generated requirements document comes from them.

The format, the fields and the rules are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md`. Read that page before you write a record.

The commands are `ndev requirements <command>`; `ndev requirements --help` lists them. Run them from the project. They read the git top level, or `--root <dir>`. Put options first and `--` before arguments that start with `-`, for example `ndev requirements ledger --root . -- docs/guide.md 4 6 "-h is the help flag"`: `ndev` reads `-h`, `--help` and `--json` before `--` as its own flags. `--json` gives `{"ok": true, "result": {"text": <output>}}`.

| Command | What it does |
|---|---|
| `ndev requirements search <term>...` | Lists the records that hold every term, with identifier, status, title and path. Says how many records it searched when none match. |
| `ndev requirements list [--status <status>] [--section <name>]` | Lists each record. |
| `ndev requirements new "<short title>" --author "<name>, <name>" [--origin explicit\|implied\|PR] [--section <name>]` | Creates the next numbered record from the template, status `Proposed`, and prints its path. The authors are the people who wrote the source text. |
| `ndev requirements author <REQ-NNNN> "<name>"...` | Replaces the list of authors of a record. |
| `ndev requirements sync [<REQ-NNNN>...]` | Writes the `source`, `issues` and `prs` fields from the Source text and the Trace. Run it after you change a citation, or a PR or Issue line of the Trace by hand. |
| `ndev requirements log <REQ-NNNN> "<what changed>"` | Adds an entry with the date of today to the `## Log`. Run it each time the title, the status, the Statement or the Source text changes. |
| `ndev requirements quote <path> <first line> <last line>` | Prints a citation and the lines as a quote, ready for the Source text. |
| `ndev requirements check` | Fails a record that breaks the format, and a record whose cited lines do not hold its quoted source text. |
| `ndev requirements render [--check]` | Writes `docs/formal/requirements/generated/requirements.html`. With `--check`, fails when that file is not current. |
| `ndev requirements guard --base <git ref>` | Fails a record in force whose Trace has no File, Issue or PR link. Fails a record whose Statement or Source text changed since the base with no human agreement, a change to the title, the status, the Statement or the Source text with no new Log entry, a changed Log entry, and a deleted record. Shows the old and the new text. |
| `ndev requirements agree <REQ-NNNN> --by "<name>"` | Records a human's agreement to the current Statement and Source text. **Only a human runs it.** It refuses to run without a terminal. |

## The protected parts

**Never change the `## Statement` or the `## Source text` of a record that exists, unless a human agrees to that change.** The first creation of a record is the only exception.

- When `check` says that the cited lines no longer hold the source text, do not copy the new lines into the record. Show the human the old text and the new text, and wait for the answer.
- When the human agrees, change the text, then ask the human to run `ndev requirements agree <REQ-NNNN> --by "<name>"`. Never run `agree` yourself, and never write the `agreed` field.
- When `guard` fails, show the human its old and new text. Do not restore or change the text without an answer.
- When `check` says that the text is now at other lines, the text did not change. Correct the line numbers in the citation.
- When a statement looks wrong, incomplete or in conflict with another record, say so with the evidence. A change to an accepted statement needs a PDR (the `adr-pdr` skill).
- You can change the status links, `## Trace` and `## Notes`.
- Each record in force needs a link in the Trace: the files that implement it, the pull request that implemented it, or an issue that plans it. When nothing implements it yet, open an issue and link it. When nothing implements it and nothing will, ask the human whether it is a requirement. A non-functional requirement has `nfr: true` and still needs a link; only when it has truly nothing to link, give the reason as `- None: <reason>`.
- Add a `## Log` entry for each change to the title, the status, the Statement or the Source text. Never change or remove an entry.

## Search

Search before you plan, design or change behaviour. Use the words of the area, the file or the behaviour.

- An `Accepted` record is a requirement. The change must meet it.
- A `Proposed` record is a question for a human, not a rule.
- A `Rejected` record is a proposal that a human turned down. Do not propose it again without new evidence.
- A `Retired` or `Superseded by NNNN` record is history.
- No match is a result. Say that you searched, and what for.

## Write a record

1. Search first. If a record covers the requirement, link to it. Do not write a second record.
2. Create the record with `ndev requirements new`. Give one requirement only.
3. Write the Statement. When a document states the requirement, use its words.
4. Add the Source text with `ndev requirements quote`. For a link (an issue, a pull request, a message), write `- <https link>` and then the quoted text. A record of origin `PR` names its pull request.
5. Leave the status `Proposed`. A human accepts: then set `status: Accepted`, `decided_by` and the `date`, and add a Log entry. Never accept your own record.
6. Run `ndev requirements check`, then `ndev requirements render`, and commit the record with the generated file.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
