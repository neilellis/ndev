# Issues, sub-issues, milestones and the board

Run the commands below with `ndev github`. The repository comes from `GH_REPO`, else `.neil-dev.json`, else the current checkout.

## Write issues

- Put the real-world impact first, then the requested change and any decision needed.
- State scope and evidence. Define terms that a reader needs. Keep useful numbers. Keep it short.
- When an issue depends on code, link the file with a commit-pinned permalink. Quote only the relevant 5 to 15 lines, and say why they matter.
- For a visual defect, attach or link a screenshot with alt text, or say that a screenshot is still needed.
- Read the final body once. Fix unclear wording and claims that the evidence does not support.
- If the project marks unclear issues with a label, list them with `ndev github labelled <label>`. Rewrite the issue before work starts, then `ndev github unlabel <n> <label>`.
- If `GH_PROSE_CHECK` is set, `issue-new` and `issue-edit` run it on the body file and refuse the post when it fails.

## Issue commands

| Command | Does | Output |
|---|---|---|
| `ndev project issue-new --title <t> --body-file <f> [--label <l>]... [--assignee <login>]... [--milestone <n>] [--type <t>]` | File an issue. Checks the body file. `--milestone` takes the number from `milestones`; `--type` is an organisation issue type. | `{number,url}` |
| `issue-edit <n> [--title <t>] [--body-file <f>]` | Rewrite an issue with REST. | `{number,url}` |
| `unlabel <n> <label>` | Remove a label from an issue or PR. | confirmation line |
| `labelled <label>` | Open issues and PRs with the label. | `{number,title,kind,url}` per line |
| `milestones` | All milestones with exact titles. | `{title,state,open_issues,closed_issues,due_on,number}` |
| `issues-by-milestone "<title>"` | Issues in a milestone. | `{number,title,state,milestone,labels,url}` |
| `ndev github dump issue <n> [--out DIR]` | Issue, comments and images in one markdown file. | `MARKDOWN: <path>`, `IMAGES_DIR: <path>` |

## Sub-issues

```bash
ndev github subissues link <parent> <child>...
ndev github subissues list <parent>
```

The script finds the child database ids. Sub-issues show on the parent's checklist.

## Dependencies (blocked-by)

```bash
ndev github blocked-by add|remove <n> <blocker>...
ndev github blocked-by list <n>
ndev github blocked-by blocking <n>
```

GitHub clears a dependency when the blocker closes. Record a block only when the blocker is work that is not yours. A dependency between two issues that you do yourself is a commit order inside one PR.

## Project board (optional)

Set `GH_PROJECT_OWNER` (user or organisation login) and `GH_PROJECT_NUMBER`. Find them with `gh project list --owner <owner>`. Board calls need the `project` scope: run `gh auth refresh -s project`, or set `GH_USE_KEYRING=1` when the ambient token lacks it.

| Command | Does |
|---|---|
| `board items [<column>]` | Cards, optionally in one Status column. `{number,title,status,itemId,url}` per line. |
| `board move <itemId> <column>` | Set Status by its display name, for example `"In progress"`. |
| `board fields` | Each field: `{name,type,options}`. `options` lists single-select options or iteration titles. |
| `board set <itemId> <field> <value>` | Set a single-select option or iteration by name, or a number, text or date (`YYYY-MM-DD`) value. A wrong name or value lists the choices and edits nothing. |
| `board add <issue> [<column>]` | Add an issue. Prints `{number,itemId}`. |

Field and option ids are looked up by name at run time. Card moves need the item id (`PVTI_...`), not the issue number. Get it from `board items` or `board add`.
