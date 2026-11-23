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
model:    (only when a Quint model specifies the requirement)
  - models/<area>.qnt#<name>
issues: []    (or a list of the numbers of the issues in the Trace: "  - 5")
prs: []    (or a list of the numbers of the pull requests in the Trace and the Source text: "  - 12")
nfr: true    (only for a non-functional requirement)
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
- None: <why nothing implements it>    (only with nfr: true, and only when the Trace has no link)

## Notes

## Log

- YYYY-MM-DD: Created.
- YYYY-MM-DD: <what changed in the record, and why>
```

The fields are YAML front matter, in this order. A value with a colon, a quote or another special character is in double quotes. `ndev requirements check` fails a record that has its fields in a `- Name: value` list under a `# <title>` line.

These commands write the record:

- `ndev requirements new "<short title>" --author "<name>, <name>"` creates the next numbered file from this template with the status `Proposed`.
- `ndev requirements author <REQ-NNNN> "<name>"...` replaces the list of authors.
- `ndev requirements sync [<REQ-NNNN>...]` writes the `source`, `issues` and `prs` fields from the Source text and the Trace. With no id, it writes each record whose fields are different.
- `ndev requirements link` and `ndev requirements file` add to the Trace, and write `issues` and `prs`.
- `ndev requirements log <REQ-NNNN> "<what changed>"` adds an entry with the date of today to the Log.
- `ndev requirements quote <path> <first line> <last line>` prints a citation and its quote for the Source text.

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
| nfr | Optional. `true` for a non-functional requirement: a quality of the system, such as a limit on time, cost or size. Leave it out for a functional requirement. An NFR usually needs a link in the Trace too. Only an NFR with nothing to link gives `- None: <reason>`. |
| decided_by | The human who accepted, rejected or retired the record. |
| agreed | Optional. A human's agreement to the current Statement and Source text. The hash covers both parts, without the line numbers of the citations. Written by `ndev requirements agree`, which runs only in a terminal. |
| verification | How the requirement is shown to be met: a `test`, a static `check`, a formal `model`, an `eval`, or a `review` by a person. Give a list for one or more methods. `unassigned` until a method is chosen. |
| model | Optional. The Quint models that specify the requirement, as a list. Each entry is a `.qnt` path from the project root. Add `#<name>` for one part of the model: a `val`, `def`, `action`, `temporal` or `run`. See [Models](#models). |

## Rules

- **The Statement and the Source text are protected.** An agent never changes them without a human's agreement. The only exception is the first creation of the record. When a source changes, or a statement looks wrong, the agent shows the human the old and the new text and waits. When the human agrees, the agent changes the text and the human runs `ndev requirements agree`. The status, the trace and the notes are not protected.
- **A human accepts.** An agent writes `Proposed`. An accepted record names the human in `decided_by`. An agent never marks its own record `Accepted`.
- **One requirement for each record.** If a statement has two requirements that can pass or fail apart, it is two records.
- **The Source text is word for word.** Quote the lines; do not summarise them. A record of origin `PR` quotes the pull request and gives its link.
- **The Log records each change to the requirement.** `ndev requirements new` writes the first entry, `Created.`. When the title, the status, the Statement or the Source text changes, add an entry with `ndev requirements log`: what changed, and why. Never change or remove an entry.
- **Each requirement has an implementation or a plan.** The Trace of a record in force links the files that implement it, the pull request that implemented it, or an issue that plans to implement it. When nothing implements it yet, open an issue and link it. When nothing implements it and nothing will, it is not a requirement: reject or retire it. Only a non-functional requirement (`nfr: true`) with truly nothing to link can give the reason instead, as `- None: <reason>`.
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
- an `nfr` value that is not `true`;
- a `- None:` line in a record without `nfr: true`, with no reason, or in a Trace that has a link;
- for a record in force, a `model` entry that is not a `.qnt` path, a model file that does not exist, a model that does not cite the record ID, and a `#<name>` that the model does not declare;
- a record with no `## Log`, with no entry in the Log, or with a Log line that is not `- YYYY-MM-DD: <what changed>`.

When the quoted text only moved in its file, the check names the new lines, and the agent corrects the line numbers. When the text changed, the check sends the change to a human.

`ndev requirements guard --base <git ref>` fails each record in force (`Proposed` or `Accepted`) whose Trace has no `- File:`, `- Issue:` or `- PR:` line. A record with `nfr: true` and a `- None: <reason>` line passes. The guard also compares each record with the same number at the base. It fails:

- a Statement or a Source text that changed, with no `agreed` field, or with an `agreed` field for other text;
- a title, a status, a Statement or a Source text that changed, with no new entry in the Log;
- a Log entry of the base that is changed or removed;
- a record that is at the base and is not in the working tree.

A record that is new since the base passes the comparison: the first creation is the exception. A citation whose line numbers changed, with the same path and quote, passes: the text only moved. The check also fails an `agreed` field that does not have the form above.

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
- each `- PR:` link that is not a merged pull request in the file, and each `- Issue:` link that is not in the file;
- each Accepted record with no `- File:` line, unless an open issue in its Trace plans the work or it is a non-functional requirement with a `- None:` reason;
- each `- File:` line of a record in force that matches no tracked file;
- each `REQ-NNNN` in a tracked file that names no record, names a record that is not in force, or names a record whose `- File:` lines do not match that file. A model that the record lists in `model` needs no `- File:` line;
- each file that cites a record with a model, and does not hold the path of one of its models.

The scan of the files skips the records folder and the publish folder.

## Models

A Quint model is a formal specification of a part of the system. Write one when the requirement is about state, order or concurrency, and a test cannot show all the cases. Examples: two migrations never share a version, and an accepted proposal never goes back to proposed. A record that is a fixed fact, such as a word on a page, needs no model.

Write the model with the `quint-modeling` skill (https://github.com/quint-co/quint/tree/main/skills). Its `from-requirements` guide starts from records like these. Put a comment that names the record ID at each part of the model that specifies it, for example `// REQ-0007` above `temporal neverTwoVersions`.

`ndev requirements model <REQ-NNNN> <path.qnt[#name]>...` sets the `model` list of a record. It refuses an entry that `check` fails. Each source file that cites the record also holds the path of its model, for example `// REQ-0007 models/migrations.qnt`. Then an agent that reads the code finds the specification.

`check` does not run Quint. Run `quint typecheck` and `quint test` on the models in the project's own checks.

### Install the Quint skills

The `quint-modeling` and `quint-lang` skills come from the Quint project. ndev refers to them and does not copy them, because the Quint team keeps them current with the language. Install them once for each harness:

```sh
npx skills add quint-co/quint --skill quint-modeling quint-lang
```

When the skills are not installed, say so, and read them from the link above.

### Prove the model

A model that passes says nothing until you prove that it can fail. For each model that you write or change:

1. Run `quint typecheck <model>`.
2. **Prove each invariant with a mutant.** Change the model so that it breaks the property that the invariant names, for example a save that ignores its base. Run the model and see the invariant fail. Then remove the mutant. An invariant that no mutant breaks is true by construction: rewrite it. Give the model each path that the code has, not only the usual path.
3. **Prove each witness is reachable.** A witness is a state that the model must be able to reach. Run `quint run --invariant "not(<witness>)" <model>`. The run must fail, and its trace shows the state. A witness that never fails is not reachable.
4. Write the tests in `<model>_test.qnt`, as runs with names that end in `Test`. `quint test` runs only those names.
5. Record the mutants and the witnesses in the PR body, with the command and the result of each.

Traps:

- `next` is a reserved word. Do not use it as a name.
- Write `x' = (a or b)` with the parentheses.
- An invariant that fails by design records a known bug. Keep it out of the formal check, and link the issue that fixes the bug.

### Add a formal check to a project

When a project has models and no formal check, add `scripts/ci/formal-check.sh`, and run it from `scripts/ndev/workflow/pre-commit-check.sh` and from CI. The script:

- installs Quint as a project dependency, so that each run uses the same version;
- runs `quint typecheck` on each `.qnt` file in the models folder;
- runs `quint test --main <module> --match 'Test$'` on each `*_test.qnt` file;
- fails when Quint is missing, with the install command;
- fails when the models folder has no `.qnt` file;
- fails a run in a test file whose name does not end in `Test`, because `quint test` skips it;
- fails a test file in which no test ran;
- prints the model and Quint's own output for each failure;
- prints the count of the models and of the tests that passed.

The workflow runs the base version of each check script, so a branch cannot remove its own formal check.

## In the workflow

The records and the models enter the work at each stage. The agent:

| Stage | Records | Models |
|---|---|---|
| Start | Run `ndev requirements search` with the words of the issue, and read each record that the change touches. A `Proposed` record is a question for the human. | Read the models in the `model` list of those records. |
| Interview | Ask about a conflict between the issue and a record. Show the Statement of each new record that you propose. | Ask the questions that the model shows to be open. |
| Plan (heavy) | Write a `Requirements:` line. | Write a `Model:` line. Write or change the model, and run `quint typecheck`, before `finished-plan`. |
| Development | Add the `- File:` lines and the citations in the source. Propose a record for new behaviour. | Keep the model in step with the code. Prove the model (above). Cite the model in the source. |
| Review (heavy) | The specification reviewer compares the diff with the records in the plan. | The specification reviewer reads the mutants and the witnesses in the PR body. |
| Pull request | Add the `- PR:` and `- Issue:` lines with `ndev requirements link`, then run `check` and `guard`. | Set the `model` list with `ndev requirements model`. |

The plan lines have this form:

```
Requirements: REQ-0007, REQ-0012, and a new record for the lock
Model: docs/formal/models/migrations.qnt#neverTwoVersions
```

When nothing applies, give the reason: `Requirements: none, <reason>` or `Model: none, <reason>`.

### When a model is necessary

| The change | Model |
|---|---|
| It changes behaviour that a record in force specifies with a `model` | Necessary, in each mode. Change the model first. |
| Heavy mode: it touches state, order, concurrency or a protocol | Necessary. Write the model before the code. |
| Light mode: it adds state, order or concurrency | Optional. When the behaviour has more cases than the tests can show, change to heavy mode. |
| A fixed fact, a pure function that the tests cover, text, layout, configuration or documentation | Not necessary. Write `Model: none, <reason>`. |

`ndev flow finished-plan` enforces the plan lines in a project with `docs/formal/requirements/`. It refuses a plan:

- with no `Requirements:` line, or with an empty one;
- that names a `REQ-NNNN` with no record;
- with no `Model:` line;
- that names a `.qnt` file that does not exist, or a file outside the worktree;
- with `Model: none` and no reason.

Write each value on the same line as its label. The label can be bold or a list item.

Only heavy mode has a plan, so only heavy mode has this gate. Light mode depends on the skill, on `ndev requirements check` and on the project's formal check.

The gate is at the plan because the plan is the last point before the code. A model written there checks the design while a change costs little. The gate checks only that the lines are present and that the files exist. It does not run Quint. The version of Quint and the folder of the models belong to the project. Thus the project's formal check runs Quint at each commit, and a second run in the workflow adds nothing.

### The protected text

The work changes the Trace, the `model` list and the Notes of a record. It never changes a Statement or a Source text without a human's agreement. The first creation of a record is the only exception. See [Rules](#rules).

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
