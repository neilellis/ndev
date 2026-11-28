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
| `ndev requirements for <path \| link \| #N --repo <owner>/<repo>>... [--status <status> \| --all]` | Lists the records in force that relate to each file, issue or pull request, with the matching Trace, Source text or `model` line. For an issue or a pull request, it also lists the records that its body cites. `--all` includes each status. Run it on the files that you plan to change. The agent hook lists these records before the first edit of a file and before a commit. |
| `ndev requirements list [--status <status>] [--section <name>] [--level <level>] [--type <type>] [--flagged]` | Lists each record. |
| `ndev requirements level <REQ-NNNN> soft\|normal\|hard` | Sets the level of a record and adds a Log entry. |
| `ndev requirements type <REQ-NNNN> <type>` | Sets the type of a record and adds a Log entry. The types are `principle`, `product`, `ux`, `design`, `operational`, `architectural`, `implementation` and `process`. |
| `ndev requirements new "<short title>" --author "<name>, <name>" --type <type> [--origin explicit\|implied\|PR] [--level soft\|normal\|hard] [--section <name>] [--base <git ref>]` | Creates the next numbered record from the template, status `Proposed`, level `normal` unless `--level` gives another, with the type that `--type` gives, and prints its path. It refuses a record with no `--type`. The authors are the people who wrote the source text. With `--base <git ref>`, such as `origin/main`, the number is also above the numbers at that ref. |
| `ndev requirements author <REQ-NNNN> "<name>"...` | Replaces the list of authors of a record. It refuses a record that is committed with an author: after that, the authors are fixed. |
| `ndev requirements deprecate <REQ-NNNN> --reason "<why>" --decided-by "<name>" [--by <REQ-NNNN>]` | Moves a record to `docs/formal/deprecated/` as `Retired`, or `Superseded by NNNN` with `--by`, and writes the links between the old and the new record. Only after a human decides: the `requirements-deprecate` skill. |
| `ndev requirements fixed --base <git ref>` | Fails a record whose id, title, author or origin changed since the base. The agent hook runs it with `--base HEAD`, or `--base MERGE_HEAD` during a merge, after a record changes, and refuses a commit until it passes. |
| `ndev requirements model <REQ-NNNN> <path.qnt[#name]>...` | Adds Quint models that specify a record, and keeps the models it already lists. Refuses a model that does not exist, does not cite the record, or does not declare the name. |
| `ndev requirements model-check [<manifest>...]` | Runs Quint on each model that has a manifest. Fails drift between a model and the cited code, a violated invariant, a mutant that survives and a witness that is not reached. The `requirements-model` skill has the procedure. |
| `ndev requirements model-pin <manifest>...` | Writes the pin of each code reference in a manifest. Only after you read the cited code against each action. |
| `ndev requirements verify-brief <REQ-NNNN>` | Prints what a fresh judge gets: the Statement, the commit, the linked files and the checks. The `requirements-verify` skill has the procedure. |
| `ndev requirements verify-judge <REQ-NNNN> --commit <sha> --verdict <v> --by "<who>" --evidence <file>` | Records the verdict of the judge in the verification file. Never judge your own work with it. |
| `ndev requirements verify (<REQ-NNNN>... \| --all \| --base <git ref>) [--report <file>]` | Runs the linked checks and models, and gives each requirement one state at the last commit: `violated`, `stale`, `unverified` or `verified`. |
| `ndev requirements sync [<REQ-NNNN>...]` | Writes the `source`, `issues` and `prs` fields from the Source text and the Trace. Run it after you change a citation, or a PR or Issue line of the Trace by hand. |
| `ndev requirements log <REQ-NNNN> "<what changed>"` | Adds an entry with the date of today to the `## Log`. Run it each time the title, the status, the level, the type, the Statement or the Source text changes. |
| `ndev requirements quote <path> <first line> <last line>` | Prints a citation and the lines as a quote, ready for the Source text. |
| `ndev requirements check [<REQ-NNNN>... \| --base <git ref>]` | Fails a record that breaks the format, and a record whose cited lines do not hold its quoted source text. With record IDs or `--base`, it also lists the related records of those records when the check passes. The list does not change the exit status. |
| `ndev requirements related <REQ-NNNN>... \| --base <git ref>` | Lists, for each record, the records to compare it with before you commit: the records that cite it or that it cites, the records that share a file or a link with it (the rarest shared files first), and the 5 records closest in meaning. Read each one, and report a conflict to the human. The agent hook shows this list after a record changes, when the changed records pass their checks. |
| `ndev requirements index` | Writes the semantic index of the records, `docs/formal/requirements/generated/embeddings.json`, for `related`. It sends only the changed text to OpenRouter, and needs `OPENROUTER_API_KEY`. Commit the index with the records. |
| `ndev requirements render [--check]` | Writes `docs/formal/requirements/generated/requirements.html`. With `--check`, fails when that file is not current. |
| `ndev requirements guard --base <git ref>` | Fails a record in force whose Trace has no File, Issue or PR link. Fails a record whose Statement or Source text changed since the base with no human agreement, a change to the title, the status, the level, the type, the Statement or the Source text with no new Log entry, a change to the id, the title, the author or the origin, a changed Log entry, a deleted record, and a record whose number the base holds for another record. Shows the old and the new text. |
| `ndev requirements explained <REQ-NNNN>... \| --base <git ref>` | Fails a record with no `## Explanation`, an empty Explanation under a Statement, and an Explanation that repeats the Statement. The agent hook runs it with `--base HEAD`, or `--base MERGE_HEAD` during a merge, after a record changes, and refuses a commit until it passes. |
| `ndev requirements levels <REQ-NNNN>... \| --base <git ref>` | Fails a record with no `level`, or a level that is not `soft`, `normal` or `hard`. The agent hook runs it with `--base HEAD`, or `--base MERGE_HEAD` during a merge, after a record changes, and refuses a commit until it passes. |
| `ndev requirements types <REQ-NNNN>... \| --base <git ref>` | Fails a record with no `type`, or a type that is not in the list. The agent hook runs it with `--base HEAD`, or `--base MERGE_HEAD` during a merge, after a record changes, and refuses a commit until it passes. |
| `ndev requirements links <REQ-NNNN>... \| --base <git ref>` | Fails a Trace link that does not exist: a File line that matches no tracked file, and an issue or pull request that GitHub cannot read. In a record in force, it also fails an issue closed as not planned or as a duplicate, and a pull request closed without a merge. |
| `ndev requirements cites <body file> --kind issue\|pr` | Passes a body that cites a record in force, or a pull request that closes an issue that cites one. Otherwise it fails and says how to find or create the record. `ndev project issue-new` and `pr-new` run it first. |
| `ndev requirements flag <REQ-NNNN> "<why it looks wrong>"` | Sets the `flagged` field: the reason why you suspect the record is wrong. `--clear` removes it. Use it when you cannot change the text, so that the doubt is not lost. `list --flagged` lists the flagged records. |
| `ndev requirements agree <REQ-NNNN> --by "<name>"` | Records a human's agreement to the current Statement and Source text. **Only a human runs it.** It refuses to run without a terminal. |

## The protected parts

**Never change the `## Statement` or the `## Source text` of a record that exists, unless a human agrees to that change.** The first creation of a record is the only exception.

- When `check` says that the cited lines no longer hold the source text, do not copy the new lines into the record. Show the human the old text and the new text, and wait for the answer.
- When the human agrees, change the text, then ask the human to run `ndev requirements agree <REQ-NNNN> --by "<name>"`. Never run `agree` yourself, and never write the `agreed` field.
- When `guard` fails, show the human its old and new text. Do not restore or change the text without an answer.
- When `check` says that the text is now at other lines, the text did not change. Correct the line numbers in the citation.
- When a statement looks wrong, incomplete or in conflict with another record, say so with the evidence, and record it with `ndev requirements flag`. Clear the flag when the human decides. A change to an accepted statement needs a PDR (the `adr-pdr` skill).
- Never change the `id`, the `title`, the `author` or the `origin` of a record that exists. The agent hook refuses that edit. To change a requirement, ask the human to deprecate the record, and write a new one (the `requirements-deprecate` skill).
- You can change the status links, `## Explanation`, `## Trace` and `## Notes`.
- Each record in force needs a link in the Trace: the files that implement it, the pull request that implemented it, or an issue that plans it. When nothing implements it yet, open an issue and link it. When nothing implements it and nothing will, ask the human whether it is a requirement. A non-functional requirement has `nfr: true` and still needs a link; only when it has truly nothing to link, give the reason as `- None: <reason>`.
- Add a `## Log` entry for each change to the title, the status, the level, the type, the Statement or the Source text. Never change or remove an entry.

## Search

Search before you plan, design or change behaviour. Use the words of the area, the file or the behaviour.

- An `Accepted` record is a requirement. The change must meet it.
- A `Proposed` record is a question for a human, not a rule.
- An `Open` record is like a `Proposed` record, but it waits for feedback from a human. Ask for that feedback. Do not decide it.
- A `Rejected` record is a proposal that a human turned down. Do not propose it again without new evidence.
- A `Retired` or `Superseded by NNNN` record is history. It is in `docs/formal/deprecated/`. Its `superseded_by` field names the record that replaces it.
- The level gives the weight of a record. A `hard` record is a cornerstone: stop and ask the human before a change that conflicts with it. A `normal` record is a stated requirement. A `soft` record comes only from communications: when it conflicts with a `normal` or `hard` record, report the conflict and do not choose.
- The type says what kind of requirement a record is. A `principle` record guides decisions: a change that conflicts with it is a question for the human, even when no `product` record forbids it. A `process` record binds the team's work, not the product.
- No match is a result. Say that you searched, and what for.

## Write a record

1. Search first. If a record covers the requirement, link to it. Do not write a second record.
2. Create the record with `ndev requirements new`. Give one requirement only.
3. Write the Statement. When a document states the requirement, use its words.
4. Write the Explanation: what the requirement entails, in simple English. Define each glossary, technical or jargon term that the Statement uses (the project glossary has the definitions). Do not repeat the Statement.
5. Set the level from the source (the format page has the rule). `soft`: each source is a message, a call or a post. `normal`: a document, a decision record or an issue states it. `hard`: a cornerstone, such as a rule of the north star. Ask the human before you set `hard` on any other record.
6. Set the type with `new --type`, or later with `ndev requirements type`. The format page, section Types, defines each type and says how to choose: `principle` (the client's reasoning), `product` (what the user gets), `ux` (how it feels), `design` (how it looks or sounds), `operational` (how it runs), `architectural` (how it is built), `implementation` (how one piece works), `process` (how the team works).
7. Add the Source text with `ndev requirements quote`. For a link (an issue, a pull request, a message), write `- <https link>` and then the quoted text. A record of origin `PR` names its pull request.
8. When the requirement is about state, order or concurrency, write a Quint model with the `quint-modeling` skill and add it with `ndev requirements model`. The section "In the workflow" of the format page tells when a model is needed, and "Prove the model" tells how to prove it with mutants and witnesses. Each source file that cites the record also cites the model path.
9. Leave the status `Proposed`. If the record needs feedback from a human, set `Open`, say in the Notes what feedback it needs, and add a Log entry. A human accepts: then set `status: Accepted`, `decided_by` and the `date`, and add a Log entry. Never accept your own record.
10. Run `ndev requirements check <REQ-NNNN>`, and read each related record that it lists. Report a conflict to the human. Then run `ndev requirements render` and, when you have the key, `ndev requirements index`, and commit the record with the generated files.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
