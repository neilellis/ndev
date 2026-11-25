# Requirement records

[kb](README.md) › requirements

**A requirement record states one requirement, with an identifier, the source text it comes from, and the links to what implements and verifies it.** The records are the governing text. Each other requirements document is generated from them.

A [PDR](pdr.md) records a change to a requirement: who decided, and why. An [ADR](adr.md) records how the system is built. The record holds what the system must do now.

## Layout

| Path | Holds | Written by |
|---|---|---|
| `docs/formal/requirements/NNNN-<title>.md` | One requirement record | An agent proposes; a human accepts |
| `docs/formal/deprecated/NNNN-<title>.md` | A record that is `Retired` or `Superseded by NNNN`. It keeps its number and its file name. | `ndev requirements deprecate`, after a human decides |
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
status: Proposed | Open | Accepted | Rejected | Retired | Superseded by NNNN
origin: explicit | implied | PR
level: soft | normal | hard
type: principle | product | ux | design | operational | architectural | implementation | process
section: <the section of the document that holds it>
date: YYYY-MM-DD
source: <the citation of the source text>    (a list when there is more than one)
author:
  - <name of a person who wrote the source text>
supersedes:    (only in a record that replaces older records)
  - docs/formal/deprecated/<NNNN-title>.md
superseded_by: docs/formal/requirements/<NNNN-title>.md    (only in a replaced record)
decided_by: <name>
verification: unassigned    (or a list: "  - test", "  - model")
model:    (only when a Quint model specifies the requirement)
  - models/<area>.qnt#<name>
issues: []    (or a list of the numbers of the issues in the Trace: "  - 5")
prs: []    (or a list of the numbers of the pull requests in the Trace and the Source text: "  - 12")
nfr: true    (only for a non-functional requirement)
agreed: <name>, YYYY-MM-DD, text <hash>    (only after a change that a human agreed to)
flagged: "<why the record looks wrong>"    (only while a reader suspects a fault)
---

## Statement

The requirement. This is the binding text.

## Explanation

What the requirement entails, in simple English. Define each glossary, technical or jargon term that it uses.

## Source text

- <full path>#L<first>-L<last>

> The cited lines, word for word.

- <https link>

> The quoted text.

## Trace

- PR: <link to a pull request that implements it>
- Issue: <link to an issue that the pull request closes>
- File: <path or pattern of a file that implements it>
- PDR: <path of a product decision record that shapes it>
- ADR: <path of an architecture decision record that shapes it>
- None: <why nothing implements it>    (only with nfr: true, and only when the Trace has no link)

## Notes

## Log

- YYYY-MM-DD: Created.
- YYYY-MM-DD: <what changed in the record, and why>
```

The fields are YAML front matter, in this order. A value with a colon, a quote or another special character is in double quotes. `ndev requirements check` fails a record that has its fields in a `- Name: value` list under a `# <title>` line.

These commands write the record:

- `ndev requirements new "<short title>" --author "<name>, <name>" --type <type>` creates the next numbered file from this template with the status `Proposed`. `new --base <git ref>` also counts the numbers at that ref, so a pull request that starts before the base moves on does not take a number the base already holds.
- `ndev requirements author <REQ-NNNN> "<name>"...` replaces the list of authors. It refuses a record that is committed with an author: after that, the authors are fixed.
- `ndev requirements deprecate <REQ-NNNN> --reason "<why>" --decided-by "<name>" [--by <REQ-NNNN>]` deprecates a record (see "Deprecation").
- `ndev requirements sync [<REQ-NNNN>...]` writes the `source`, `issues` and `prs` fields from the Source text and the Trace. With no id, it writes each record whose fields are different.
- `ndev requirements link` and `ndev requirements file` add to the Trace, and write `issues` and `prs`.
- `ndev requirements log <REQ-NNNN> "<what changed>"` adds an entry with the date of today to the Log.
- `ndev requirements level <REQ-NNNN> soft|normal|hard` sets the level and adds a Log entry. `new` writes `normal`, and `new --level <level>` writes another level.
- `ndev requirements type <REQ-NNNN> <type>` sets the type and adds a Log entry. `new` refuses a record with no `--type`.
- `ndev requirements flag <REQ-NNNN> "<why it looks wrong>"` sets or replaces the `flagged` field. `ndev requirements flag <REQ-NNNN> --clear` removes it.
- `ndev requirements quote <path> <first line> <last line>` prints a citation and its quote for the Source text.

## The fields

| Field | Values |
|---|---|
| status | `Proposed`: an agent wrote it and no human has accepted it. `Open`: like `Proposed`, but it needs feedback from a human before anyone can decide it. `Accepted`: in force. `Rejected`: a human turned the proposal down; keep it, so that nobody proposes it again. `Retired`: no longer a requirement. `Superseded by NNNN`: a newer record replaces it. |
| origin | `explicit`: a document states it. `implied`: a test, a schema constraint or a check enforces it, and no document states it. `PR`: no record covered a pull request, so the record was written from that pull request. |
| level | How strongly the record binds. `hard`: a cornerstone of the project, such as a rule of its north star. `normal`: a document, a decision record or an issue states it as a requirement. `soft`: it is derived from communications only, such as a message, a call or a post. `ndev requirements list --level <level>` lists the records of one level, and `render` and `publish` show it. |
| type | What kind of requirement the record is. One value from the list in [Types](#types). `ndev requirements list --type <type>` lists the records of one type, and `render` and `publish` show it. |
| section | The section of the generated document that holds the record. |
| source | The citations of the Source text, in the same order: a path with lines, or an https link to a pull request, an issue or a web document. One value when there is one citation, and a list when there are more. `ndev requirements check` fails a `source` that is different from the Source text. |
| author | The people who wrote the source text, one or more. When the source is a document, these are the people who wrote the document. When the source is only a pull request, this is the author of the pull request. An agent is never the author. |
| issues | The numbers of the issues in the Trace, in ascending order. A list, `[]` when there is none. `ndev requirements check` fails a list that is different from the Trace. |
| prs | The numbers of the pull requests in the Trace and the Source text, in ascending order. A list, `[]` when there is none. `ndev requirements check` fails a list that is different. |
| nfr | Optional. `true` for a non-functional requirement: a quality of the system, such as a limit on time, cost or size. Leave it out for a functional requirement. An NFR usually needs a link in the Trace too. Only an NFR with nothing to link gives `- None: <reason>`. |
| decided_by | The human who accepted, rejected or retired the record. |
| agreed | Optional. A human's agreement to the current Statement and Source text. The hash covers both parts, without the line numbers of the citations. Written by `ndev requirements agree`, which runs only in a terminal. |
| flagged | Optional, on a record of any status. The reason why a reader suspects that the record is wrong, for example a Statement that does not match the code. It keeps the doubt in the record until a human decides. It is not part of the requirement: it is not protected, and a change to it needs no Log entry. `ndev requirements list --flagged` lists the flagged records, and `render` and `publish` show the flag. |
| verification | How the requirement is shown to be met: a `test`, a static `check`, a formal `model`, an `eval`, or a `review` by a person. Give a list for one or more methods. `unassigned` until a method is chosen. |
| model | Optional. The Quint models that specify the requirement, as a list. Each entry is a `.qnt` path from the project root. Add `#<name>` for one part of the model: a `val`, `def`, `action`, `temporal` or `run`. See [Models](#models). |

## Types

Each record has one `type`. It says what kind of requirement the record is, so that a reader knows who decides it and what kind of evidence meets it.

| Type | What it is | Example |
|---|---|---|
| `principle` | A guiding principle of the client: moral, ethical, commercial or intellectual. Decisions are made from it. It does not say what the product does. | "Claims are tested against evidence, not authority." |
| `product` | A functional requirement of the product: what a user uses, and what the product does for them. A customer use case usually attaches to it. | "A user submits a claim and gets a report." |
| `ux` | A product requirement that is not a direct function: the experience of using the product, such as feedback, flow, wording, waiting and accessibility. | "A loading region shows a skeleton, never a waiting message." |
| `design` | A visual, audio or brand choice. | "The app uses Manrope and IBM Plex Mono." |
| `operational` | The operation of the product: hosting, infrastructure, deployment, backups, cost limits, monitoring and the browsers it supports. | "The web app is hosted on Vercel." |
| `architectural` | How the product is built, without the fine detail: the parts, where data lives, and how the parts talk. | "The product has a database." |
| `implementation` | How one specific piece of the product is implemented. | "A save is refused unless the graph revision is still the one read." |
| `process` | How the team builds, checks, records and releases the product: the development workflow, CI, reviews, tests, decision records and documentation. It does not change what the product does. | "Each pull request runs the affected tests." |

How to choose:

- Ask first what the record constrains. The client's reasoning is `principle`. What the user gets is `product`, or `ux` when it is how it feels, or `design` when it is how it looks or sounds. How it runs is `operational`. How it is built is `architectural`, or `implementation` when it names one piece and how that piece works. How the team works is `process`.
- When a record fits two types, choose the one that a change to the record would affect most. When it still fits two, it may hold two requirements: split it.
- A rule of a method that the product applies to the user's case is `product`. The reason why the method is right is `principle`.
- `nfr: true` is separate from the type. A non-functional requirement is usually `operational`, `architectural`, `implementation` or `ux`.
- The type is not protected: an agent sets it and changes it with `ndev requirements type`, which adds a Log entry. Say why in the Notes when the choice is not plain.

## Rules

- **The Statement and the Source text are protected.** An agent never changes them without a human's agreement. The only exception is the first creation of the record. When a source changes, or a statement looks wrong, the agent shows the human the old and the new text and waits. When the human agrees, the agent changes the text and the human runs `ndev requirements agree`. The status, the explanation, the trace and the notes are not protected.
- **Each record explains its Statement.** The `## Explanation` comes after the Statement. It tells what the requirement entails, in simple English, so that a reader who does not know the domain understands it. It defines each glossary, technical or jargon term that the Statement uses. It does not repeat the Statement. It is not binding: when the two disagree, the Statement wins, and the agent corrects the Explanation. A record written before this rule fails `check` until it has an Explanation.
- **A human accepts.** An agent writes `Proposed`. When a record needs feedback from a human, an agent sets `Open`, says in the Notes what feedback it needs, and adds a Log entry with `ndev requirements log`. An accepted record names the human in `decided_by`. An agent never marks its own record `Accepted`.
- **The level comes from the source.** Give `soft` when each source is a message, a call or a post. Give `normal` when a document, a decision record or an issue states the requirement. Give `hard` only to a cornerstone: a rule of the project's north star, or a rule that a human names a cornerstone. When the sources change, check the level again. An agent asks a human before it sets `hard` on a record whose source is not a cornerstone document.
- **Each record has a type.** Choose it from [Types](#types) when the record is written. When the Statement changes, check the type again.
- **One requirement for each record.** If a statement has two requirements that can pass or fail apart, it is two records.
- **The Source text is word for word.** Quote the lines; do not summarise them. A record of origin `PR` quotes the pull request and gives its link.
- **The Log records each change to the requirement.** `ndev requirements new` writes the first entry, `Created.`. When the title, the status, the level, the type, the Statement or the Source text changes, add an entry with `ndev requirements log`: what changed, and why. Never change or remove an entry.
- **Each requirement has an implementation or a plan.** The Trace of a record in force links the files that implement it, the pull request that implemented it, or an issue that plans to implement it. When nothing implements it yet, open an issue and link it. When nothing implements it and nothing will, it is not a requirement: reject or retire it. Only a non-functional requirement (`nfr: true`) with truly nothing to link can give the reason instead, as `- None: <reason>`.
- **Numbers are never reused, and a record is never deleted.** A requirement that ends is deprecated: it moves to `docs/formal/deprecated/` with the status `Retired`, or `Superseded by NNNN` when a newer record replaces it. A proposal that fails gets `Rejected`.
- **The id, the title, the author and the origin are fixed.** After the first creation of a record, they never change. To change what a requirement says, a human deprecates the record and a new record replaces it.
- **A change to an accepted Statement needs a PDR.** The PDR names the record in `Requirement changed`.
- **Name every file by its full path** from the repository root, and every issue and pull request by its link.

## Enforcement

`ndev requirements check` reads each record in `docs/formal/requirements/` and `docs/formal/deprecated/`. It ignores `README.md` and the folders. It fails:

- a bad file name, a duplicate number in the two folders, or an `ID` that does not match the file number;
- a `Retired` or `Superseded by NNNN` record outside `docs/formal/deprecated/`, and a record in that folder with another status;
- a `supersedes` or `superseded_by` path that names no record, a `superseded_by` record whose number is not in the status, and a `supersedes` record whose status is not `Superseded by` this record;
- a record with no `level`, or no `type`;
- a status, an origin, a level, a type or a verification value that is not in the lists above;
- a `Superseded by` that names no record, itself or an older record;
- a record that is not `Proposed` or `Open` and has no statement, source text, section or approver;
- a source that is not a path with lines or an https link, or that has no quote;
- a record of origin `PR` whose source text names no pull request;
- a record in force whose cited lines do not hold the quoted text;
- a `source`, `issues` or `prs` field that is different from the Source text and the Trace;
- an `nfr` value that is not `true`;
- a `flagged` field with no text;
- a `- None:` line in a record without `nfr: true`, with no reason, or in a Trace that has a link;
- a `- PDR:` line that is not a Markdown file in a `pdr` folder, an `- ADR:` line that is not a Markdown file in an `adr` or `decisions` folder, and, for a record in force, a decision record that does not exist;
- for a record in force, a `model` entry that is not a `.qnt` path, a model file that does not exist, a model that does not cite the record ID, and a `#<name>` that the model does not declare;
- a record with no `## Explanation`, an empty Explanation when the Statement has text, and an Explanation that repeats the Statement;
- a record with no `## Log`, with no entry in the Log, or with a Log line that is not `- YYYY-MM-DD: <what changed>`.

When the quoted text only moved in its file, the check names the new lines, and the agent corrects the line numbers. When the text changed, the check sends the change to a human.

`ndev requirements guard --base <git ref>` fails each record in force (`Proposed`, `Open` or `Accepted`) whose Trace has no `- File:`, `- Issue:` or `- PR:` line. A record with `nfr: true` and a `- None: <reason>` line passes. The guard also compares each record with the same number at the base. It fails:

- a Statement or a Source text that changed, with no `agreed` field, or with an `agreed` field for other text;
- a title, a status, a Statement or a Source text that changed, with no new entry in the Log;
- a Log entry of the base that is changed or removed;
- an id, a title, an author or an origin that changed;
- a record that is at the base and is not in the working tree;
- a record whose number the base holds for another record (another pull request took the number first): the message names both files and the `git mv` and `id` change that give the record the next free number.

The guard finds a record by its number in both folders, so a move to `docs/formal/deprecated/` is not a deletion.

`ndev requirements fixed --base <git ref>` does only the comparison of the fixed fields. The agent hook runs it with `--base HEAD`, or `--base MERGE_HEAD` during a merge, after a record changes, and refuses a commit until it passes. The hook also examines each Edit, MultiEdit or Write before it runs. It refuses an edit that changes a fixed field of a record that exists. It does not examine a Codex `apply_patch` or `patch` edit before it runs: for these, the note after the edit and the commit refusal are the guard.

A record that is new since the base passes the comparison: the first creation is the exception. A citation whose line numbers changed, with the same path and quote, passes: the text only moved. The check also fails an `agreed` field that does not have the form above.

The guard proves that the `agreed` field matches the text. It does not prove that a human wrote the field. In review, check that the human named in the field made the commit that adds it.

### Links that exist

`ndev requirements links <REQ-NNNN>...` reads each Trace link of the named records. `links --base <git ref>` reads the records that changed or are new since the ref. It fails:

- a `- File:` line, in a record in force, that matches no tracked file;
- an `- Issue:` or `- PR:` line that is not a GitHub issue or pull request link, or that GitHub cannot read;
- in a record in force, an issue that was closed as not planned or as a duplicate, and a pull request that was closed without a merge.

A record that is not in force can keep a closed link and a removed file, but not a link that does not exist.

`links` reads each GitHub link once in a run. For a repository with 10 or more different links, it lists all issues and pull requests in one read (`gh.sh issue-states`). Then it reads on its own each link that is not in the list. It does the same for a link whose kind (issue or pull request) is different in the list. It keeps GitHub answers in a cache for 10 minutes, and its output says when an answer came from the cache. To read each answer fresh, set `GH_CACHE_TTL=0`.

### Find the records of a file, an issue or a pull request

`ndev requirements for <target>...` lists the records that relate to each target. For a tracked file, these are the records that name it in a `- File:` pattern, the Source text, the `model` list, or an `- ADR:` or `- PDR:` line. An issue or a pull request is a GitHub link, or `#N` with `--repo <owner>/<repo>`. For it, these are the records that link it in the Trace or the Source text, and the records that its body cites. The default is the records in force. `--status <status>` gives one status, and `--all` gives each status. A target with no record is a result, and the command exits 0. A target that is not a tracked file or a GitHub link fails.

### Each record explains its Statement

`ndev requirements explained <REQ-NNNN>...` checks the Explanation of the named records, as `check` does. `explained --base <git ref>` checks the records that changed or are new since the ref.

### Each record has a level

`ndev requirements levels <REQ-NNNN>...` checks the `level` of the named records, as `check` does. `levels --base <git ref>` checks the records that changed or are new since the ref. `guard` fails a changed level with no new Log entry.

### Each record has a type

`ndev requirements types <REQ-NNNN>...` checks the `type` of the named records, as `check` does. `types --base <git ref>` checks the records that changed or are new since the ref. `guard` fails a changed type with no new Log entry.

### Each issue and pull request cites a record

In a project with records, each issue and pull request traces to a record in force (`Proposed`, `Open` or `Accepted`). `ndev requirements cites <body file> --kind issue|pr` passes a body that cites a record ID in force. A pull request also passes when an issue that it closes (`Closes #N`) cites one. When no record fits, create a `Proposed` record with `ndev requirements new` and cite it.

The gates:

- `ndev project issue-new` and `ndev project pr-new` run `cites` before the GitHub call, through `gh.sh`, and refuse with exit 1 before anything is posted. They check only when the target repository is the repository of the current folder.
- The agent hook refuses a raw `gh issue create` and `gh pr create`, and names the `ndev project` command.
- After a tool call changes a record, the agent hook runs `links --base HEAD`, `explained --base HEAD`, `levels --base HEAD` and `types --base HEAD`, and reports the problems once. During a merge it runs them with `--base MERGE_HEAD`, so the records that the merged branch brought in are not checked as changes of this commit. It refuses `git commit`, `ndev flow checkpoint` and `ndev flow finished-development` while a changed record has a link problem, no Explanation, no valid level or no valid type.
- Before the first edit of a tracked file in a session, the agent hook lists the records in force that name the file in a `- File:` Trace line. Before a commit, it lists them for the files of the commit: the staged files, the paths of a `git add` in the same command, the tracked changes for `git commit -a`, and the `--file` values of `ndev flow checkpoint` and `ndev flow finished-development`. The list stops at 20 records and names the `for` command that prints the rest. The hook does not refuse the commit.

A call through `gh api` is not gated.

`ndev requirements render` writes `docs/formal/requirements/generated/requirements.html`, one file with every record. `render --check` fails when that file is not current. Run `check`, `render --check` and `guard --base <the target branch>` in the project's checks.

## Finding the requirements in documents

The `requirements-find` skill reads the project's documents and writes the records. Each prose line of a source document is accounted for: a record cites it, or the ledger holds it with a reason.

`ndev requirements sources` lists the tracked Markdown documents by tier:

| Tier | Kind | Path |
|---|---|---|
| 1 | requirements | A folder named `requirements`, `spec`, `specification`, `pdr`, `adr` or `decisions`, or a file named `NORTH_STAR`, `REQUIREMENTS`, `SPEC` or `PRD` |
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

## Tracing decisions

A product decision record (PDR) or an architecture decision record (ADR) can be the source of a record. The Source text quotes it, as it quotes any tracked document. A record also lists the decisions that shape it, in `- PDR:` and `- ADR:` lines of its Trace. A PDR is in a folder named `pdr`. An ADR is in a folder named `adr` or `decisions`.

`ndev requirements decision <REQ-NNNN> <path>...` adds the lines. It takes the kind from the folder, and it refuses a file that is not tracked. A decision line is not an implementation or a plan: `guard` still needs a `- File:`, `- Issue:` or `- PR:` line.

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

`ndev requirements model <REQ-NNNN> <path.qnt[#name]>...` adds models to the `model` list of a record, and keeps the models it already lists. It refuses an entry that `check` fails. Each source file that cites the record also holds the path of its model, for example `// REQ-0007 models/migrations.qnt`. Then an agent that reads the code finds the specification.

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
| Start | The records come first: the work exists to fulfil them. `started` shows the Statement of each record that the issue cites. When the issue cites no record in force, find one, or propose a new record with the status `Proposed`, and cite it in the issue. Run `ndev requirements for` on the issue and on the files that you plan to change, and `ndev requirements search` with the words of the issue, and read each record that the change touches. A `Proposed` record is a question for the human. An `Open` record waits for their feedback. | Read the models in the `model` list of those records. |
| Interview | Ask about a conflict between the issue and a record. Show the Statement of each new record that you propose. | Ask the questions that the model shows to be open. |
| Plan (heavy) | Write a `Requirements:` line, and one `REQ-NNNN: <test, check or model>` line for each record on it. | Write a `Model:` line. Model a heavy change, or a change to state, concurrency, money, permissions or a protocol, in Quint first, and run `quint typecheck`, before `finished-plan`. Link the model with `ndev requirements model`. |
| Development | Add the `- File:` lines and the citations in the source. Propose a record for new behaviour. | Keep the model in step with the code. Prove the model (above). Cite the model in the source. |
| Review (heavy) | The specification reviewer compares the diff with the records in the plan. | The specification reviewer reads the mutants and the witnesses in the PR body. |
| Pull request | Add the `- PR:` and `- Issue:` lines with `ndev requirements link`, then run `check` and `guard`. `finished-development` and `done` refuse a record in force on the `Requirements:` line whose Trace does not link the PR. They do not run `ndev requirements links`: the agent hook runs it on the changed records. | Add to the `model` list with `ndev requirements model`. |

The plan lines have this form:

```
Requirements: REQ-0007, REQ-0012, and a new record for the lock
Model: docs/formal/models/migrations.qnt#neverTwoVersions
REQ-0007: the test tests/migrate.test.ts
REQ-0012: the model docs/formal/models/migrations.qnt#neverTwoVersions
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

The `requirements-document` skill writes the narrative. `ndev requirements narrate "<section>"` prints the records of the section and the state of its narrative. `narrate "<section>" --from <file>` stores the prose in `generated/narrative/` with a hash of the identifier and Statement of each record in force in the section. A change of status between `Proposed`, `Open` and `Accepted` does not make it stale. It fails:

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
| `meta` | Optional. `nextra` also writes `_meta.js`, which gives Nextra the order of the pages. With `groupBy`, each type folder gets its own `_meta.js` too. |
| `groupBy` | Optional. `type` puts the pages in one folder for each type (see Types), so that a reader can go through all the records of one type. Each folder has an index and one page for each section that has records of the type. Without it, there is one page for each section. |

It writes:

- in the front matter of each page, `title` and `description`. The description of a page is "N requirement records in the <section> section". The description of the index is "N requirement records in M sections";
- `index.<format>`: the title of the outline, the count of the records by status, and a link to each page;
- with `"groupBy": "type"`, a folder for each type that has records in force, in the order of the Types table: `<type>/index.<format>` with the meaning of the type, the count of its records and a link to each of its section pages. The index of the project then links to the type folders. The description of a type index is "N requirement records of the type <type> in M sections", and of a page in it "N requirement records of the type <type> in the <section> section";
- one page for each section (with `groupBy`, one for each section in each type folder, with only the records of that type), in the order of the outline: the narrative, then each record with an anchor `REQ-NNNN`, its fields, Statement, Explanation, Source text, Trace, Notes and Log. A bare `REQ-NNNN` links to the record on its page;
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

## Deprecation

A record that is obsolete, or that a newer record replaces, is deprecated. A human decides each deprecation. Deprecation is for records. The retirement above is for prose documents.

`ndev requirements deprecate <REQ-NNNN> --reason "<why>" --decided-by "<name>" [--by <REQ-NNNN>]`:

- moves the record to `docs/formal/deprecated/` with `git mv`, with the same file name;
- sets `status: Retired`, or `Superseded by NNNN` with `--by`, and writes the human's name in `decided_by`;
- adds a Log entry with the reason;
- with `--by`, writes `superseded_by` in the old record and adds the old record to `supersedes` in the new record. The new record must be newer and not deprecated;
- corrects the `supersedes` and `superseded_by` paths of the other records that name the moved record.

The `requirements-deprecate` skill gives the procedure.
