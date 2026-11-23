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
| `docs/formal/requirements/extra/ledger.md` | The lines of the documents that hold no requirement, each with its reason and a hash of the lines | An agent proposes with `requirements.mjs ledger`; a human reviews |
| `docs/formal/requirements/generated/` | Generated documents. Do not edit them. | The script |
| `docs/formal/requirements/extra/publish.json` | Where and how `requirements.mjs publish` writes the pages for the documentation app | Humans |
| `docs/formal/requirements/generated/narrative/` | The prose of each section, with a hash of the records it describes | An agent, through `requirements.mjs narrate` |

## Template

```markdown
# <short title>

- ID: REQ-NNNN
- Status: Proposed | Accepted | Rejected | Retired | Superseded by NNNN
- Origin: explicit | implied | PR
- Section: <the section of the document that holds it>
- Date: YYYY-MM-DD
- Decided by: <name>
- Verification: unassigned | test | check | model | eval | review
- Agreed: <name>, YYYY-MM-DD, text <hash>    (only after a change that a human agreed to)

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

## Notes
```

`requirements.mjs new "<short title>"` creates the next numbered file from this template with the status `Proposed`. `requirements.mjs quote <path> <first line> <last line>` prints a citation and its quote for the Source text.

## The fields

| Field | Values |
|---|---|
| Status | `Proposed`: an agent wrote it and no human has accepted it. `Accepted`: in force. `Rejected`: a human turned the proposal down; keep it, so that nobody proposes it again. `Retired`: no longer a requirement. `Superseded by NNNN`: a newer record replaces it. |
| Origin | `explicit`: a document states it. `implied`: a test, a schema constraint or a check enforces it, and no document states it. `PR`: no record covered a pull request, so the record was written from that pull request. |
| Section | The section of the generated document that holds the record. |
| Agreed | Optional. A human's agreement to the current Statement and Source text. The hash covers both parts, without the line numbers of the citations. Written by `requirements.mjs agree`, which runs only in a terminal. |
| Verification | How the requirement is shown to be met: a `test`, a static `check`, a formal `model`, an `eval`, or a `review` by a person. More than one is allowed, with commas. `unassigned` until a method is chosen. |

## Rules

- **The Statement and the Source text are protected.** An agent never changes them without a human's agreement. The only exception is the first creation of the record. When a source changes, or a statement looks wrong, the agent shows the human the old and the new text and waits. When the human agrees, the agent changes the text and the human runs `requirements.mjs agree`. The status, the trace and the notes are not protected.
- **A human accepts.** An agent writes `Proposed`. An accepted record names the human in `Decided by`. An agent never marks its own record `Accepted`.
- **One requirement for each record.** If a statement has two requirements that can pass or fail apart, it is two records.
- **The Source text is word for word.** Quote the lines; do not summarise them. A record of origin `PR` quotes the pull request and gives its link.
- **Numbers are never reused, and a record is never deleted.** A requirement that ends gets the status `Retired`. A proposal that fails gets `Rejected`.
- **A change to an accepted Statement needs a PDR.** The PDR names the record in `Requirement changed`.
- **Name every file by its full path** from the repository root, and every issue and pull request by its link.

## Enforcement

`requirements.mjs check` reads each record in `docs/formal/requirements/`. It ignores `README.md` and the folders. It fails:

- a bad file name, a duplicate number, or an `ID` that does not match the file number;
- a status, an origin or a verification value that is not in the lists above;
- a `Superseded by` that names no record, itself or an older record;
- a record that is not `Proposed` and has no statement, source text, section or approver;
- a source that is not a path with lines or an https link, or that has no quote;
- a record of origin `PR` whose source text names no pull request;
- a record in force whose cited lines do not hold the quoted text.

When the quoted text only moved in its file, the check names the new lines, and the agent corrects the line numbers. When the text changed, the check sends the change to a human.

`requirements.mjs guard --base <git ref>` compares each record with the same number at the base. It fails:

- a Statement or a Source text that changed, with no `Agreed` line, or with an `Agreed` line for other text;
- a record that is at the base and is not in the working tree.

A record that is new since the base passes: the first creation is the exception. A citation whose line numbers changed, with the same path and quote, passes: the text only moved. The check also fails an `Agreed` line that does not have the form above.

The guard proves that the `Agreed` line matches the text. It does not prove that a human wrote the line. In review, check that the human named in the line made the commit that adds it.

`requirements.mjs render` writes `docs/formal/requirements/generated/requirements.html`, one file with every record. `render --check` fails when that file is not current. Run `check`, `render --check` and `guard --base <the target branch>` in the project's checks.

## Finding the requirements in documents

The `requirements-find` skill reads the project's documents and writes the records. Each prose line of a source document is accounted for: a record cites it, or the ledger holds it with a reason.

`requirements.mjs sources` lists the tracked Markdown documents by tier:

| Tier | Kind | Path |
|---|---|---|
| 1 | requirements | A folder named `requirements`, `spec` or `specification`, or a file named `NORTH_STAR`, `REQUIREMENTS`, `SPEC` or `PRD` |
| 2 | wiki | A folder named `wiki` |
| 3 | readme | `README.md` |
| 4 | other | Each other document |

`requirements.mjs uncovered [path...]` reads the named documents, or each tier 1 document. It skips front matter, headings, code blocks, comments, rules and table separators. It lists each other line that no record cites and no ledger entry holds, and marks a normative line (must, shall, should, never, always, only and the like). It fails while a line is not accounted for, and when the lines of a ledger entry changed after the entry was written. A record of any status accounts for the lines that it cites: a rejected record is a decision.

## Tracing pull requests

Each merged pull request traces to a record. The `requirements-retrospective` skill does this work for the pull requests merged before the records existed.

`requirements.mjs untraced --prs <file>` reads the output of `gh pr list --state merged --limit 1000 --json number,title,url,closingIssuesReferences`. A record names a pull request in a `- PR:` line of its Trace, or as a link in its Source text. The command lists each pull request that no record names, the oldest first. It also fails a record that names a pull request and does not link each issue that the pull request closes.

`requirements.mjs link <REQ-NNNN> <pull request link> [--prs <file>] [--issue <issue link>]` adds the `- PR:` line and the `- Issue:` lines to the Trace. With `--prs`, it adds the issues that the pull request closes. The Trace is not protected, so an agent can link. `check` fails a `- PR:` line that is not a link to a pull request, and an `- Issue:` line that is not a link to an issue.

## The document

`render` writes one HTML document from three parts:

- the records;
- the outline, `docs/formal/requirements/extra/outline.md`, which a human writes: `# <title>`, then one `## <section>` line for each section, in order;
- the narrative: for each section, prose that introduces it and links its records.

With an outline, `render` fails a record in force with no section or with a section that is not in the outline, an outline section with no record in force, a section named twice, a second title, and any line that is not a `#` or `##` heading. With no outline, the sections come in the order of the records.

The `requirements-document` skill writes the narrative. `requirements.mjs narrate "<section>"` prints the records of the section and the state of its narrative. `narrate "<section>" --from <file>` stores the prose in `generated/narrative/` with a hash of the identifier and Statement of each record in force in the section. A change of status between `Proposed` and `Accepted` does not make it stale. It fails:

- a sentence with a normative word (must, shall, should, never, cannot, only and the like) that cites no `REQ-NNNN`: the records state the requirements, and the narrative only points to them. Each list item is a sentence. A citation can come after the full stop, as in `... sources. (REQ-0001)`. An identifier in a code span is not a citation;
- an identifier that is not a record in force in the section;
- a heading.

`requirements.mjs narrative` lists each section as `current`, `stale` or `missing`. It fails while a narrative is stale or missing, when a narrative names a section that no record in force has, when a record in force has no section, and when two sections give the same file name. `render` marks a stale narrative in the document, and `render --check` does not fail it: only `narrative` does. Run `narrative` in the project's checks with `check` and `render --check`.

## Publication

`requirements.mjs publish` writes the records into the project's documentation app. `docs/formal/requirements/extra/publish.json` sets it:

| Key | Value |
|---|---|
| `to` | The folder for the pages, inside the project. Give it a folder of its own. It cannot be the records folder or a folder in `.git`. |
| `format` | `md` or `mdx`. The script escapes `<` outside code, and in `mdx` also `{` and `}`. Fenced blocks, code spans and bare web addresses stay as written. In `mdx`, the links between the pages are routes under `route`. |
| `route` | The path at which the app serves the folder, for example `/requirements/formal`. It is necessary with `mdx`, because the app serves the index one level above the other pages. With `md`, the links between the pages are relative and the script ignores it. |
| `source` | Optional. The web address under which the project's files show, for example `https://github.com/<owner>/<repo>/blob/main/`. The links to the records and to the cited lines start with it. Without it, those links are relative paths. |
| `frontMatter` | Optional. Keys to add to the front matter of each page, after `title`. A value is text or a list of text. In a list, `{records}` becomes the paths of the records on the page. |
| `meta` | Optional. `nextra` also writes `_meta.js`, which gives Nextra the order of the pages. |

It writes:

- `index.<format>`: the title of the outline, the count of the records by status, and a link to each page;
- one page for each section, in the order of the outline: the narrative, then each record with an anchor `REQ-NNNN`, its fields, Statement, Source text, Trace and Notes. A bare `REQ-NNNN` links to the record on its page;
- `not-in-force.<format>` for the records that are not in force;
- `requirements.json`: the title and each record, with its page;
- `.published`: the files that this publish wrote.

It removes the files of the last publish that it no longer writes. It fails a file in the folder that the last publish did not write, and it does not change that file. `publish --check` writes nothing. It fails a file that is missing, that is not current or that is left from the last publish. A stale narrative shows with a note, as in `render`. Run `publish --check` in the project's checks with `check`, `render --check` and `narrative`.

The `requirements-publish` skill sets up `publish.json` and publishes.
