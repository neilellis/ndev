---
name: multi-epic-triage
description: "Triage ALL open GitHub issues of a repository into area epics, and own the triage above one Orca epic coordinator per epic. Use when the user asks to triage every issue, regroup the backlog into epics, or start a coordinator per epic."
---

# Triage all issues into epics, then coordinate the coordinators

You are the **triage owner**. You decide what is open, which epic owns it, and in what order the epics run. Coordinators deliver the epics; you rule on what they cannot, and the human decides the rest. Hand off: per-PR grouping is `triage`, writing one epic's spec is `epic-plan`, delivering one epic is `epic-coordinate`, Orca commands are `orchestration`. Do not repeat their work.

Keep all working files in `<worktree>/.triage/` and add it to `.git/info/exclude`. Every step writes a file; the next step reads it. Worked example: fcc-proto, 182 issues → 38 closed, 11 epics.

## Phase 1: triage (steps 1–9)

1. **Inventory.** Dump every open issue: `gh issue list -R <o/r> --state open --limit 1000 --json number,createdAt,title,labels,body > .triage/issues.json`, plus parents and sub-issues (GraphQL `parent`, `subIssues`). Write `index.tsv` (number, created, parent, sub-issues, labels, title). Group by topic in `step1-groups.md`, one table per topic, oldest first.
2. **Check against the default branch.** Start one read-only subagent per area (about 40 issues each) with the issue list, the area's paths and this return format: a table `issue | verdict | type | related | evidence` with verdict `DONE`, `NEEDED`, `IN_PR`, `DUPLICATE`, `SUPERSEDED` or `CANNOT_OCCUR`, and evidence as `file:line` or a commit SHA. Save each as `verdicts-<area>.md`. Rules: newer issues win; a bug in code that is or will be rewritten is won't-fix with the reason; verify that the default branch still needs the change (the bug still happens, or the feature is still missing); never plan a change that regresses an improvement on main.
3. **Lists to close.** Write `step2-4-lists.md`: Completed, Won't fix, Superseded, Duplicate, each with a one-line evidence reason. Put the same data in `plan.py` dicts (`COMPLETED`, `WONTFIX`, `SUPERSEDED`, `DUPLICATE`, type map `T`). Partly done issues stay open with a narrowing note in `notes.py` `NOTES`.
4. **Ask the human once.** Collect every conflict (two issues with opposing effects, an open PR that a newer issue makes obsolete, a stale epic) into one numbered decision list, each with options and your recommendation. Record the answers at the top of `step2-4-lists.md`.
5. **Close and comment.** `python3 scripts/apply_triage.py close --repo <o/r> --dir .triage` closes each listed issue with its reason and logs to `close-log.txt`; `... notes` posts each narrowing note. Run with `--dry-run` first and show the counts.
6. **Group by the code a change touches.** Write `step5-groups.md`: one group per set of files and systems a change touches, oldest first. Every remaining issue lands in exactly one group unless it truly stands alone. Put them in `epics.json` (`{letter: {num|null, name, radius, kids}}`, where `radius` names the files and systems of the group), reusing an existing epic number where one fits.
7. **Create epics and links.** `apply_triage.py epics` creates missing epic issues, attaches sub-issues (`POST /repos/<o/r>/issues/<epic>/sub_issues -F sub_issue_id=<id> -F replace_parent=true`) and writes the numbers back. Add blocked-by links (`POST .../issues/<n>/dependencies/blocked_by -F issue_id=<id>`; "already been taken" means it exists). Then `apply_triage.py labels` labels every open issue with its type and every closed one with its fate.
8. **Order.** Write `orders.json` per epic (oldest first, moved after its blockers) and the order between epics: CI/test reliability and database operations first (every later PR needs them), independent radii in parallel, epics that change what others read last.
9. **Report.** `step9-report.md`: counts, the human's decisions, findings that matter (regressions, stranded commits, stale proofs), the epic order table with links, and what was not checked. Publish or post it; give a link per issue.

## Phase 2: one coordinator per epic

1. **Briefs.** Write `briefs/common.md` once with placeholders `{EPIC} {NAME} {SPECIFIC} {ORDER}` and render one `briefs/epic-<n>-<slug>.md` per epic. The brief says: work the sub-issues in order, one branch per PR from current main in the same worktree, ndev mode and steering (for example heavy + auto, set per worktree with `ndev project mode` / `ndev project steering`), helpers only inside its own workspace, take each PR to green, review independently, merge with `ndev-merge`, change only the files and systems of its group, respect blocked-by links, comment and tick the epic after each merge, fix ndev itself if ndev blocks it. Add the **hard limits** (below) verbatim.
2. **Launch.** Per epic: `orca worktree create --repo path:<repo> --name <slug> --no-parent --issue <epic> --base-branch origin/main --json`, then `orca agent launch --agent claude --worktree id:<worktreeId> --prompt "$(cat brief)" --json`. Record worktree and session ids in `briefs/launched.json`. If a remote host is unavailable, create locally and say so.
3. **Supervise without polling.** End the turn; read what arrived with `orca orchestration check --all --json` and state with `orca worktree ps --json`. Message a coordinator with `orca orchestration send --to orca_session_id:<id> --subject <s> --body <b> --json`.
4. **Rule.** A coordinator reports what it needs. Decide what you can (scope splits between epics, order, which epic owns a shared file). Batch the rest into **one numbered decision list** for the human with options and a recommendation; send each answer back to the coordinator that asked.
5. **Relay standing authorisations.** When the human grants a standing rule (for example "migrations and ontology publishing are authorised", "push migrations as you merge"), send it to every coordinator, append it to `briefs/common.md`, and save it to memory. An authorisation for one PR is not standing.
6. **Red main.** When main's checks fail, start one priority agent to fix main, commit to main and merge main into the open PRs. When its fix is green on main, tell all coordinators.
7. **Baseline failures.** A coordinator may merge past a check that also fails on main only if: main is merged in first; its failing tests are a subset of main's; the diff does not touch the failing packages; the independent review is done; the close-out records "merged with baseline failure #<issue>" and counts the check as failed.
8. **CI load.** Many coordinators saturate shared runners. Watch the queue (`gh run list --status queued`); use the `ci-runner` skill to restart or relabel runners, and serialise migration-carrying merges across epics.
9. **Finish.** An epic is done when its coordinator closes it with a summary. Report per epic: state, PRs with links, decisions pending, what was not run.

## Hard limits (always ask the human)

- Paid hosted runs and frontier-model calls beyond cheap smoke tests.
- Replacing eval baselines.
- Edits to the north-star or requirement documents.
- New billed vendors; history repair, force pushes or flags that weaken a check.

## Scripts

`scripts/apply_triage.py` reads `.triage/plan.py`, `notes.py` and `epics.json` and runs the `gh` writes (`close`, `notes`, `epics`, `labels`), with `--dry-run`. It stops at the first failure and prints the issue and gh's stderr.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
