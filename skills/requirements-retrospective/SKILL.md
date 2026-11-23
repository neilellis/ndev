---
name: requirements-retrospective
description: "Trace each merged pull request to a requirement record: link it to the records it implements, or write a Proposed record with Origin PR when no record matches (an upsert), and link the issues it closes. Use after requirements-find, when a project starts requirement records, when untraced fails, or when the user says retrospective, trace the PRs, every PR to a requirement or PRs to requirements."
---

# Trace pull requests to requirements

The records, their format and their rules are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md`, and the `requirements` skill holds the commands that write them. Read both first. Run `requirements-find` before this skill: the records from the documents come first, so that a pull request links to them and does not make a second record.

The commands are `ndev requirements <command>`. Run them from the project.

| Command | What it does |
|---|---|
| `ndev requirements untraced --prs <file>` | Lists each merged pull request that no record names. Fails a record that names a pull request and does not link the issues that it closes. |
| `ndev requirements link <REQ-NNNN> <pull request link> --prs <file>` | Adds the pull request and the issues that it closes to the record's Trace. |

## Procedure

1. Write the list of merged pull requests to a file outside the project, for example in your scratch folder:
   `gh pr list --state merged --limit 1000 --json number,title,url,closingIssuesReferences > <file>`.
   If the project has more pull requests than the limit, raise the limit. Say how many pull requests the file holds.
2. Run `ndev requirements untraced --prs <file>`. It lists the oldest pull request first. Work down the list.
3. For each pull request, read its title, its body, the issues that it closes and its changed files (`gh pr view <n> --json title,body,files,closingIssuesReferences`). Then search the records (`ndev requirements search`) with the words of the behaviour that it changes. GitHub lists closing issues only for a pull request into the default branch: when the body says `Closes #N` and the list is empty, add the issue with `--issue <link>`.
4. Choose one:
   - **It implements one or more records.** Run `ndev requirements link <REQ-NNNN> <link> --prs <file>` for each record. Link only a record whose behaviour the pull request adds, changes or fixes. When it adds more than one requirement, link it to a record for each one.
   - **No record matches.** Write a record: `ndev requirements new "<title>" --origin PR --section <name>`. The Statement is the requirement that the pull request meets, in the words of the pull request or its issue where they state it. The Source text is `- <link to the pull request>` and its quoted words. The status stays `Proposed`. For the section, use a section that `ndev requirements list` shows, or the name of the application or package that the pull request changes. Then run `link` with `--prs` for the issues.
   - **It changes no behaviour** (a dependency update, a formatting change, a build or CI change, a fix to a test only). It still traces to a record: link it to the record that the change keeps working or that the test guards, or write a `Proposed` record of origin `PR` that states the constraint (for example, the build runs on the supported runtime). Do not skip it.
5. Never change the Statement or the Source text of a record that exists. When a pull request shows that a record is wrong or out of date, say so in `## Notes` and report it to the human.
6. Run `ndev requirements untraced --prs <file>` again. Stop when it passes.

## Finish

1. Run `ndev requirements check` and `ndev requirements render`.
2. Commit the records and the generated file.
3. Report to the human: the number of pull requests, how many link to records from documents, how many new records of origin `PR` you wrote, each record that a pull request showed to be wrong, and the pull requests you did not read.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
