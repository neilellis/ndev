# Requirement records

[kb](README.md) › requirements

**A requirement record states one requirement, with an identifier, the source text it comes from, and the links to what implements and verifies it.** The records are the governing text. Each other requirements document is generated from them.

A [PDR](pdr.md) records a change to a requirement: who decided, and why. An [ADR](adr.md) records how the system is built. The record holds what the system must do now.

## Layout

| Path | Holds | Written by |
|---|---|---|
| `docs/formal/requirements/NNNN-<title>.md` | One requirement record | An agent proposes; a human accepts |
| `docs/formal/requirements/extra/` | Material that is not a requirement: glossary, copies of sources, samples, open questions | Humans |
| `docs/formal/requirements/extra/outline.md` | The title of the document and the order of its sections | Humans |
| `docs/formal/requirements/extra/ledger.md` | The lines of the documents that hold no requirement, each with its reason and a hash of the lines | An agent proposes with `ndev requirements ledger`; a human reviews |
| `docs/formal/requirements/generated/` | Generated documents. Do not edit them. | The script |
| `docs/formal/requirements/extra/retired.md` | The retired documents, each with a hash of its frozen copy and its decision record | `ndev requirements retire`, after a human agrees |
| `docs/formal/requirements/extra/sources/` | The frozen copies of the retired documents, at their old paths. Do not edit them. | `ndev requirements retire` |
| `docs/formal/requirements/extra/publish.json` | Where and how `ndev requirements publish` writes the pages for the documentation app | Humans |
| `docs/formal/requirements/generated/narrative/` | The prose of each section, with a hash of the records it describes | An agent, through `ndev requirements narrate` |

## Template

```markdown
---
id: REQ-NNNN
title: <short title>
status: Proposed | Accepted | Rejected | Retired | Superseded by NNNN
origin: explicit | implied | PR
section: <the section of the document that holds it>
date: YYYY-MM-DD
source: <the citation of the source text>    (a list when there is more than one)
author:
  - <name of a person who wrote the source text>
decided_by: <name>
verification: unassigned    (or a list: "  - test", "  - model")
issues: []    (or a list of the numbers of the issues in the Trace: "  - 5")
prs: []    (or a list of the numbers of the pull requests in the Trace and the Source text: "  - 12")
agreed: <name>, YYYY-MM-DD, text <hash>    (only after a change that a human agreed to)
---

## Statement

The requirement. This is the binding text.

## Source text

- <full path>#L<first>-L<last>

> The cited lines, word for word.

- <https link>

> The quoted text.

## Trace

- PR: <link to a pull request that implements it>
- Issue: <link to an issue that the pull request closes>
- File: <path or pattern of a file that implements it>

## Notes

## Log

- YYYY-MM-DD: Created.
- YYYY-MM-DD: <what changed in the record, and why>
```

The fields are YAML front matter, in this order. A value with a colon, a quote or another special character is in double quotes. `ndev requirements check` fails a record that has its fields in a `- Name: value` list under a `# <title>` line.

`ndev requirements new "<short title>" --author "<name>, <name>"` creates the next numbered file from this template with the status `Proposed`. `ndev requirements author <REQ-NNNN> "<name>"...` replaces the list of authors. `ndev requirements sync [<REQ-NNNN>...]` writes the `source`, `issues` and `prs` fields from the Source text and the Trace. With no id, it writes each record whose fields are different. `ndev requirements link` and `ndev requirements file` write `issues` and `prs` when they add to the Trace. `ndev requirements log <REQ-NNNN> "<what changed>"` adds an entry with the date of today to the Log. `ndev requirements quote <path> <first line> <last line>` prints a citation and its quote for the Source text.

## The fields

| Field | Values |
|---|---|
| status | `Proposed`: an agent wrote it and no human has accepted it. `Accepted`: in force. `Rejected`: a human turned the proposal down; keep it, so that nobody proposes it again. `Retired`: no longer a requirement. `Superseded by NNNN`: a newer record replaces it. |
| origin | `explicit`: a document states it. `implied`: a test, a schema constraint or a check enforces it, and no document states it. `PR`: no record covered a pull request, so the record was written from that pull request. |
| section | The section of the generated document that holds the record. |
| source | The citations of the Source text, in the same order: a path with lines, or an https link to a pull request, an issue or a web document. One value when there is one citation, and a list when there are more. `ndev requirements check` fails a `source` that is different from the Source text. |
| author | The people who wrote the source text, one or more. When the source is a document, these are the people who wrote the document. When the source is only a pull request, this is the author of the pull request. An agent is never the author. |
| issues | The numbers of the issues in the Trace, in ascending order. A list, `[]` when there is none. `ndev requirements check` fails a list that is different from the Trace. |
| prs | The numbers of the pull requests in the Trace and the Source text, in ascending order. A list, `[]` when there is none. `ndev requirements check` fails a list that is different. |
| decided_by | The human who accepted, rejected or retired the record. |
| agreed | Optional. A human's agreement to the current Statement and Source text. The hash covers both parts, without the line numbers of the citations. Written by `ndev requirements agree`, which runs only in a terminal. |
| verification | How the requirement is shown to be met: a `test`, a static `check`, a formal `model`, an `eval`, or a `review` by a person. Give a list for one or more methods. `unassigned` until a method is chosen. |

## Rules

- **The Statement and the Source text are protected.** An agent never changes them without a human's agreement. The only exception is the first creation of the record. When a source changes, or a statement looks wrong, the agent shows the human the old and the new text and waits. When the human agrees, the agent changes the text and the human runs `ndev requirements agree`. The status, the trace and the notes are not protected.
- **A human accepts.** An agent writes `Proposed`. An accepted record names the human in `decided_by`. An agent never marks its own record `Accepted`.
- **One requirement for each record.** If a statement has two requirements that can pass or fail apart, it is two records.
- **The Source text is word for word.** Quote the lines; do not summarise them. A record of origin `PR` quotes the pull request and gives its link.
- **The Log records each change to the requirement.** `ndev requirements new` writes the first entry, `Created.`. When the title, the status, the Statement or the Source text changes, add an entry with `ndev requirements log`: what changed, and why. Never change or remove an entry.
- **Numbers are never reused, and a record is never deleted.** A requirement that ends gets the status `Retired`. A proposal that fails gets `Rejected`.
- **A change to an accepted Statement needs a PDR.** The PDR names the record in `Requirement changed`.
- **Name every file by its full path** from the repository root, and every issue and pull request by its link.

## Enforcement

`ndev requirements check` reads each record in `docs/formal/requirements/`. It ignores `README.md` and the folders. It fails:

- a bad file name, a duplicate number, or an `ID` that does not match the file number;
- a status, an origin or a verification value that is not in the lists above;
- a `Superseded by` that names no record, itself or an older record;
- a record that is not `Proposed` and has no statement, source text, section or approver;
- a source that is not a path with lines or an https link, or that has no quote;
- a record of origin `PR` whose source text names no pull request;
- a record in force whose cited lines do not hold the quoted text;
- a `source`, `issues` or `prs` field that is different from the Source text and the Trace;
- a record with no `## Log`, with no entry in the Log, or with a Log line that is not `- YYYY-MM-DD: <what changed>`.

When the quoted text only moved in its file, the check names the new lines, and the agent corrects the line numbers. When the text changed, the check sends the change to a human.

`ndev requirements guard --base <git ref>` compares each record with the same number at the base. It fails:

- a Statement or a Source text that changed, with no `agreed` field, or with an `agreed` field for other text;
- a title, a status, a Statement or a Source text that changed, with no new entry in the Log;
- a Log entry of the base that is changed or removed;
- a record that is at the base and is not in the working tree.

A record that is new since the base passes: the first creation is the exception. A citation whose line numbers changed, with the same path and quote, passes: the text only moved. The check also fails an `agreed` field that does not have the form above.

The guard proves that the `agreed` field matches the text. It does not prove that a human wrote the field. In review, check that the human named in the field made the commit that adds it.

`ndev requirements render` writes `docs/formal/requirements/generated/requirements.html`, one file with every record. `render --check` fails when that file is not current. Run `check`, `render --check` and `guard --base <the target branch>` in the project's checks.

## Finding the requirements in documents

The `requirements-find` skill reads the project's documents and writes the records. Each prose line of a source document is accounted for: a record cites it, or the ledger holds it with a reason.

`ndev requirements sources` lists the tracked Markdown documents by tier:

| Tier | Kind | Path |
|---|---|---|
| 1 | requirements | A folder named `requirements`, `spec` or `specification`, or a file named `NORTH_STAR`, `REQUIREMENTS`, `SPEC` or `PRD` |
| 2 | wiki | A folder named `wiki` |
| 3 | readme | `README.md` |
| 4 | other | Each other document |

`ndev requirements uncovered [path...]` reads the named documents, or each tier 1 document. It skips front matter, headings, code blocks, comments, rules and table separators. It lists each other line that no record cites and no ledger entry holds, and marks a normative line (must, shall, should, never, always, only and the like). It fails while a line is not accounted for, and when the lines of a ledger entry changed after the entry was written. A record of any status accounts for the lines that it cites: a rejected record is a decision.

## Tracing pull requests

Each merged pull request traces to a record. The `requirements-retrospective` skill does this work for the pull requests merged before the records existed.

`ndev requirements untraced --prs <file>` reads the output of `gh pr list --state merged --limit 1000 --json number,title,url,closingIssuesReferences`. A record names a pull request in a `- PR:` line of its Trace, or as a link in its Source text. The command lists each pull request that no record names, the oldest first. It also fails a record that names a pull request and does not link each issue that the pull request closes.

`ndev requirements link <REQ-NNNN> <pull request link> [--prs <file>] [--issue <issue link>]` adds the `- PR:` line and the `- Issue:` lines to the Trace. With `--prs`, it adds the issues that the pull request closes. The Trace is not protected, so an agent can link. `check` fails a `- PR:` line that is not a link to a pull request, and an `- Issue:` line that is not a link to an issue.

## Tracing files

A record lists each file that implements it, in `- File:` lines of its Trace. A line holds a path from the project root, or a pattern: `*` matches inside one folder, `**` matches any number of folders, and `?` matches one character. A leading `/` is the project root. For example, `- File: src/report/**` or `- File: /docs/*.md`. Each source file that implements a record cites its ID (`REQ-NNNN`), for example in the name of a test or in a line of the file.

`ndev requirements file <REQ-NNNN> <path or pattern>...` adds the `- File:` lines. It refuses a pattern that matches no tracked file. `check` fails a `- File:` line that is not a path or pattern inside the project.

`ndev requirements trace --prs <file> --issues <file>` checks the links in both directions. Make the issues file with `gh issue list --state all --limit 10000 --json url,state`. It fails:

- each merged pull request that no record names, as `untraced` does;
- each `- PR:` link that is not a merged pull request in the file, and each `- Issue:` link that is not a closed issue in the file;
- each Accepted record with no `- File:` line, and each `- File:` line of a record in force that matches no tracked file;
- each `REQ-NNNN` in a tracked file that names no record, names a record that is not in force, or names a record whose `- File:` lines do not match that file.

The scan of the files skips the records folder and the publish folder.

## The document

`render` writes one HTML document from three parts:

- the records;
- the outline, `docs/formal/requirements/extra/outline.md`, which a human writes: `# <title>`, then one `## <section>` line for each section, in order;
- the narrative: for each section, prose that introduces it and links its records.

With an outline, `render` fails a record in force with no section or with a section that is not in the outline, an outline section with no record in force, a section named twice, a second title, and any line that is not a `#` or `##` heading. With no outline, the sections come in the order of the records.

The `requirements-document` skill writes the narrative. `ndev requirements narrate "<section>"` prints the records of the section and the state of its narrative. `narrate "<section>" --from <file>` stores the prose in `generated/narrative/` with a hash of the identifier and Statement of each record in force in the section. A change of status between `Proposed` and `Accepted` does not make it stale. It fails:

- a sentence with a normative word (must, shall, should, never, cannot, only and the like) that cites no `REQ-NNNN`: the records state the requirements, and the narrative only points to them. Each list item is a sentence. A citation can come after the full stop, as in `... sources. (REQ-0001)`. An identifier in a code span is not a citation;
- an identifier that is not a record in force in the section;
- a heading.

`ndev requirements narrative` lists each section as `current`, `stale` or `missing`. It fails while a narrative is stale or missing, when a narrative names a section that no record in force has, when a record in force has no section, and when two sections give the same file name. `render` marks a stale narrative in the document, and `render --check` does not fail it: only `narrative` does. Run `narrative` in the project's checks with `check` and `render --check`.

## Publication

`ndev requirements publish` writes the records into the project's documentation app. `docs/formal/requirements/extra/publish.json` sets it:

| Key | Value |
|---|---|
| `to` | The folder for the pages, inside the project. Give it a folder of its own. It cannot be the records folder or a folder in `.git`. |
| `format` | `md` or `mdx`. The script escapes `<` outside code, and in `mdx` also `{` and `}`. Fenced blocks, code spans and bare web addresses stay as written. In `mdx`, the links between the pages are routes under `route`. |
| `route` | The path at which the app serves the folder, for example `/requirements/formal`. It is necessary with `mdx`, because the app serves the index one level above the other pages. With `md`, the links between the pages are relative and the script ignores it. |
| `source` | Optional. The web address under which the project's files show, for example `https://github.com/<owner>/<repo>/blob/main/`. The links to the records and to the cited lines start with it. Without it, those links are relative paths. |
| `frontMatter` | Optional. Keys to add to the front matter of each page, after `title` and `description`. A value is text or a list of text. In a list, `{records}` becomes the paths of the records on the page. The script makes `description` from the count of the records, so `frontMatter` cannot set it. |
| `meta` | Optional. `nextra` also writes `_meta.js`, which gives Nextra the order of the pages. |

It writes:

- in the front matter of each page, `title` and `description`. The description of a page is "N requirement records in the <section> section". The description of the index is "N requirement records in M sections";
- `index.<format>`: the title of the outline, the count of the records by status, and a link to each page;
- one page for each section, in the order of the outline: the narrative, then each record with an anchor `REQ-NNNN`, its fields, Statement, Source text, Trace, Notes and Log. A bare `REQ-NNNN` links to the record on its page;
- `not-in-force.<format>` for the records that are not in force;
- `requirements.json`: the title and each record, with its page;
- `.published`: the files that this publish wrote.

It removes the files of the last publish that it no longer writes. It fails a file in the folder that the last publish did not write, and it does not change that file. `publish --check` writes nothing. It fails a file that is missing, that is not current or that is left from the last publish. A stale narrative shows with a note, as in `render`. Run `publish --check` in the project's checks with `check`, `render --check` and `narrative`.

The `requirements-publish` skill sets up `publish.json` and publishes.

## Retirement

When the records hold each requirement of a prose document, the document can go. Two copies of a requirement drift apart. Retirement does not change a Statement or a Source text, because only a human agrees to that change.

`ndev requirements references <path>` lists each line of a tracked file that names the path, or that has a Markdown link to it (inline or reference style). It does not find the bare file name. It leaves out the document, the records folder and the folder of the published pages.

`ndev requirements retire <path>... --pdr <file>` retires one or more documents together. A reference from one of them to another does not count. It changes nothing when one of them fails, and it fails when:

- the path or the decision record is not a plain path from the repository root;
- a frozen copy of the path is already there;

- the decision record does not exist, or does not name each path;
- a line of the document is not accounted for (as `uncovered`);
- a line of another tracked file references the document. The decision record is not counted, and neither is a file named in `--keep <file>,<file>`. Use `--keep` only for history that does not change, such as an applied migration. A file in `--keep` must reference the document.

Then it copies the document to `docs/formal/requirements/extra/sources/<path>`, deletes the document, and adds `- <path> <hash> <decision record>`, then `keep <file>,<file>` when there are kept files, to `docs/formal/requirements/extra/retired.md`.

After that, the citations of the records and the ledger entries read the cited lines from the frozen copy. `render` and `publish` link to the frozen copy. `check` fails when:

- a line of `retired.md` does not have the form;
- the frozen copy is missing, or its hash changed;
- the decision record is missing;
- a kept file is missing;
- the retired document exists again.

The `requirements-retire` skill does the retirement with the human.
