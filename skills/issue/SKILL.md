---
name: issue
description: "Create a GitHub issue from a short description, add it to the project board in Backlog, and fill in the issue and board fields that the description supports. Use when the user types /issue or /i, or asks to file or raise an issue. Also invoked as /i. With --orca, also opens the issue in a new Orca workspace."
argument-hint: "[--orca] <description of the issue>"
---

# Create an issue in Backlog

The description is: $ARGUMENTS

## The workflow

After you file an issue that this session will work on, call `mcp__ndev__started(issue, shortName)`. While a workflow runs, file other work with `mcp__ndev__followUp(mode, message)`, which also links it. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

If the arguments contain `--orca`, remove it from the description. After the issue is created and on the board (steps 1 to 5), do step 6. Never open the workspace before the issue exists, because the workspace needs the issue number.

If the description is empty, ask what the issue is, in one question, and stop.

Create the issue directly. The command is the request, so do not ask for approval of the draft.

## 1. Read the project's choices

`G=${CLAUDE_PLUGIN_ROOT}/scripts/github/gh.sh`. It reads the repository and board from `.neil-dev.json`.

Run these reads in parallel:

```bash
$G board fields                                             # {name,type,options} per field
gh label list --repo <repo> --limit 200 --json name,description
$G milestones                                               # use only "open" ones
gh api graphql -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){issueTypes(first:25){nodes{name description}}}}' -f o=<owner> -f n=<name>
```

- If the project has no repository in `.neil-dev.json` (`"repo": null`) or `gh.sh` cannot find one, stop. Say: "Run /dev-setup to set the GitHub repository and board."
- If the board is `null`, create the issue and skip steps 3 and 4. Say that the project has no board.
- If the board is not set yet, or `board fields` fails, stop and show the error. `gh.sh` names the fix (`gh auth refresh -s project`, or `/dev-setup`).
- `issueTypes` is `null` for a repository that does not belong to an organisation that uses issue types. In that case, set no type.

## 2. Write the issue

Follow "Write issues" in `${CLAUDE_PLUGIN_ROOT}/skills/github/references/issues.md`. In short:

- **Title:** at most 70 characters, specific, in the imperative for a change ("Show the export date in the table header") or as the symptom for a defect ("Export fails for files over 2 GB").
- **Body:** first the impact, then the requested change, then the acceptance criteria as a checklist. Add open questions only if the description leaves a decision open.
- Use only what the description says, plus facts you checked. If the description names code, find it with one bounded search and link it with a commit-pinned permalink. Do not invent steps to reproduce it, numbers or scope.
- Write the body to a file in the scratchpad or `$TMPDIR`, not in the repository.

## 3. Choose the fields

Set a field only when the description supports the value. Leave a field empty rather than guess, and report each field you left empty.

| Field | Rule |
|---|---|
| Labels | Only labels that exist. Match on name and description. Never create a label. |
| Type | Only a type from `issueTypes`, for example `Bug` for a defect or `Feature` for new behaviour. |
| Milestone | Only an open milestone that the description clearly belongs to. Give its number. |
| Assignees | Only people the description names, given as their GitHub login. Otherwise leave it unassigned. |
| Status (board) | Always `Backlog`. |
| Single-select fields (Priority, Size, Area and others) | The option that the description supports. Base a priority on the impact that the description states: data loss, a security problem or an outage is the highest, and a cosmetic change is the lowest. |
| Number fields (Estimate, Points) | Only when the size is clear from the description, on the scale that the field's name implies. |
| Iteration and date fields | Only when the description names a sprint or a date. |
| Text fields | Only when the description gives the value. |

## 4. Create the issue and fill in the board

```bash
$G issue-new --title "<title>" --body-file <file> [--label <l>]... [--type <t>] [--milestone <n>] [--assignee <login>]...   # prints {number,url}
$G board add <number> Backlog                                                                                             # prints {number,itemId}
$G board set <itemId> "<field>" "<value>"                                                                                 # once for each chosen field
```

- If `board add` reports that `Status` has no option `Backlog`, do not choose another column. Leave the card where it is, and report the options that the error lists.
- A `board set` that fails prints the valid choices and changes nothing. Correct the value once from those choices, or leave the field empty and report it.
- If `issue-new` succeeds and a later step fails, do not create the issue again. Report the issue URL and the step that failed.

## 5. Report

Give the result in at most five lines:

- the issue URL and title;
- the fields you set, as `field: value`;
- the fields you left empty, each with a reason of a few words;
- any step that failed, with its error.

## 6. Open the issue in a new Orca workspace (`--orca` only)

Load the `orca-cli` skill for the Orca executable and the guide. Then create a top-level workspace, linked to the issue, from the repository's default base, with a Claude agent in it that starts on the issue:

```bash
ORCA worktree create --name issue-<number>-<slug> --no-parent --issue <number> --agent claude --prompt "Use the ndev plugin to work on issue #<number>" --activate --json
```

- `<slug>` is two to four words from the title, in kebab case.
- Do not pass `--base-branch`.
- Check that `result.launch.prompt.outcome` is `journaled` or `handed-to-terminal`. Otherwise report that the prompt did not arrive.
- Report the agent handle from `result.launch.outcome.handle`. If the launch reports a terminal instead of a chat, or a fallback, report `receipt.detail`.
- If Orca is not running or the command fails, show the error. The issue still exists, so do not create it again.
- Add the workspace path and branch to the report.
