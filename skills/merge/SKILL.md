---
name: merge
description: "Merge a pull request and run its Supabase migrations. Use for /ndev:merge, or when the workflow's done tool says to load this skill."
---

# Merge a pull request and run its migrations

The `addMigration` workflow tool lists each migration in a marked section of the PR body. This skill merges the PR, then applies those migrations.

## The workflow

`mcp__ndev__addMigration(name)` lists the migrations that this skill runs. When the project level lets the agent merge, `mcp__ndev__done` tells you to load this skill or merges for you. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Who may merge

- A human who runs `/ndev:merge` allows this merge.
- An agent that a human did not ask may merge only when `projectLevel` in `.neil-dev.json` is `straw_man` or `poc`. At any other level, stop and tell the human.

## Steps

1. Find the pull request. Use the number in the arguments, else the PR of the current branch. If you find no single PR, ask.

2. Merge it. This reads the PR through REST and is safe to run twice:

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/workflow/merge.sh <pr> --repo <owner/name>
   ```

   It prints JSON with `sha`, `base` and `migrations`. If it exits non-zero, report its message and stop. Nothing has merged.

3. If `migrations` is empty, report the merge and stop.

4. Run each migration from the merged code, not from the branch. In the main checkout, stop if the tree is not clean. Then `git switch <base>` and `git pull --ff-only`. Check that each listed file exists.

5. Load the `supabase` skill. Find the linked project with `supabase projects list` and the `supabase/.temp/project-ref` file in the folder that holds `supabase/`. If the target project is not clear, ask the human.

6. Run `supabase migration list`, and read which listed files are not applied on the remote. Then run `supabase db push`. It applies all pending files, so if the list shows a pending file that this PR does not list, stop and ask. If the list shows a listed file as pending and it was already applied by hand, `supabase db push` fails on it, for example on duplicate keys. Ask the human to confirm that it was applied, then run `supabase migration repair <timestamp of the file> --status applied`, and do not run its SQL again.

7. Run `supabase migration list` again, and confirm that each listed file is now applied.

## If a migration fails

The merge stays: do not revert it. Report the migration file, the exit code and the command's own output. Report which migrations were applied and which were not. A later run of this skill does not merge again and goes on from step 4.

## Report

Give the PR link, the merge sha, and each migration as applied, failed or not run.
