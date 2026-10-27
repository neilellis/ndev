# Verify and ingest (F4, F5)

Part of the `work-heavy` skill. This file covers the loop commit → push → checks → deploy → smoke, and the
knowledge ingest.

## F4 — Verify loop

Repeat **commit → push → checks → deploy → smoke** until all gates are green. Do not stop on a red
gate that you can fix.

**1. E2E**, if the project has an E2E suite (its `CLAUDE.md` names the command). If the suite does
not exist, log a skip.

**Skip it only when your diff provably cannot reach it.** An E2E stack is often a machine-wide
singleton, and a run blocks other agents for minutes. Prove the skip with a command:

```bash
git diff --name-only "origin/$BASE...HEAD" | grep -E '<paths the E2E suite covers>' || echo none
```

Then **say in the PR that you skipped it and why**. A silent skip looks the same as a suite you ran
and ignored. A change to the UI, the test harness or a migration the suite applies still runs it.
Running it has traps (no dependencies in a fresh worktree, the tool's time limit, a shared lock,
orphan servers on a port): read `verify-traps.md`.

**1b. Record what you learned, before the PR leaves draft.** Use the **`r`** skill: collect the
durable, non-obvious facts this work taught you, put each in its **one** home from that skill's
table, and **commit them on the branch you have**. Never open a second PR for them.

**In the same pass, use `forget`** if the work made something false: you deleted, renamed or retired
something, or you found a doc or memory note that the code contradicts. Erase it; do not annotate it
(golden rule 13).

Do it here: draft-to-ready is the last moment the knowledge exists. The diff records what changed,
not what you now know. This step **includes** F5; do one or the other, not both. "Nothing durable
was learned" is a correct answer for cosmetic work. Say it; do not pad the wiki.

**2. Mark ready, then wait for checks.**

```bash
gh pr ready <n> --repo "$REPO"
${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-pr-change.sh <n>      # one foreground wait, no polling
gh pr view <n> --repo "$REPO" --json mergeable,mergeStateStatus,statusCheckRollup
```

`gh pr ready` is necessary, not bookkeeping, when previews start only on ready PRs.

**3. Preview deployment**, if the project has one. Its `CLAUDE.md` says what creates the preview
and in what order (for example push → CI → preview). Budget for the real time the chain takes. If you
will stop before the preview exists, say so in the state comment
(`- next: resume: smoke the preview for <sha>`).

If **no preview appears**, read it as a signal, not a hang. In order: is the PR still a draft? Did CI
go red? Is the deploy token set? Read the log of the workflow that creates previews.

**⚠️ A green status is not proof that a preview exists.** A deploy provider can post `success` on a
build it skipped (read the status `description`, not only `state`). A workflow named "Deploy
preview" can pass when it decided to skip your PR. Get the real preview URL from the thing that
created it (its log or the provider's API).

**4. Browser smoke.** Open the preview with a real browser (the Chrome MCP tools: load them with
ToolSearch in one batched call). Visit the pages the change touched and a few core pages, and read
the console. **If the change adds animation, make sure it actually runs**: trigger it at a mobile
viewport, because a static screenshot looks clean on an inert animation. If no browser is available,
do an HTTP 200 check and record that interactive smoke is pending. The E2E suite is an addition to
this smoke, not a replacement.

**5. Record the smoke ON the PR as a review**, not a plain comment, so that it is in the review
timeline:

```bash
# <tmp> line 1 is the marker; line 2 onward is the report:
#   <!-- work-heavy-auto:smoke -->
#   **Smoke tested** — <head-sha>, preview <url> … what you drove, what you saw
gh pr review <n> --repo "$REPO" --comment --body-file <tmp>
gh api -X POST "repos/$REPO/issues/<n>/labels" -f 'labels[]=smoke-tested' --jq '[.[].name]'
```

Four rules:

- **The body MUST start with `<!-- work-heavy-auto:smoke -->`.** The `work-heavy-auto` skill's
  `pr_feedback.sh` reads review bodies for human feedback, and an agent often posts as the **same
  GitHub user as the human**. The marker is the only difference. An unmarked smoke review is read as
  new human feedback on the next pass.
- **Name the commit sha in the first line.** A smoke review is a claim about one commit. Smoke again
  and post again after each later push that changes behaviour. If the project removes the
  `smoke-tested` label on push, adding it again is part of the new smoke.
- **Add the label with `gh api`, and print the resulting label list.** `gh pr edit --add-label` can
  fail on some repositories with output that looks like a warning, and leave the PR unchanged.
- **Use `--comment`, never `--approve`.** GitHub does not let you approve your own PR.

Never post the review before the smoke, and never claim more than you did. If you only did an HTTP
200 check, **say so**. A false "smoke tested" is worse than none, because it removes a reviewer's
doubt without earning it.

**6. Gate:** `mergeable == MERGEABLE`, a clean `mergeStateStatus`, all checks SUCCESS, the preview
ready (if any), E2E green or skipped with a reason, smoke clean and recorded. On any failure, find
the cause (`gh run view <run-id> --log-failed`, the deploy logs, the console errors), fix, commit,
push and repeat. Claim green only on fresh evidence. The `fix-ci` skill helps with a red check.

**Before you debug a red check, ask whether the fault is yours.** A branch cut from a broken `$BASE`
fails on another person's bug (F0b). CI checks out the merge of your branch with the current `$BASE`,
so a failure can name a test your branch does not hold (`verify-traps.md`).

**⚠️ Exit codes can lie, logs collide between agents and passes, and local timings on a loaded
machine can be very wrong.** Read `verify-traps.md` before you quote a number or believe a status.

## F5 — Knowledge ingest

> **Timing:** this runs as the `r` skill's sweep at F4 step 1b, before the PR leaves draft, on the
> branch you have. `r` owns the routing table (wiki, product docs, a skill, `AGENTS.md`, memory). The
> rest of this fragment is the wiki mechanics that `r` delegates to.
>
> **An ingest that only adds is half an ingest.** A wiki page states **current state**. Where your
> change replaced what a page says, the old claim is false and somebody will act on it. Use `forget`
> in the same pass. Present tense only: no "previously", no note about what changed.

After non-cosmetic work, update the project's wiki, if it has one (the `docs` skill has the map):
the developer pages for system changes, domain pages only for new real-world domain knowledge, and
visual pages for house-style decisions. Follow the wiki's own conventions file for index pages and
logs. If a human reader will benefit, refresh the curated product documentation as well, and run its
parity test if one exists. Commit on the branch.

**Documentation needs a clarity check.** Each page you add or change must make sense without hidden
context. Run `${CLAUDE_PLUGIN_ROOT}/scripts/docs/readability.sh` on changed product docs and copy (F2c), and use an
independent reader for new or much-rewritten product documentation.
