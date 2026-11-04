# Planning (F2, F2a)

Part of the `work-heavy` skill. This file covers the plan in the PR body and the test entry point.

## F2 — Plan

**Read the project's glossary first, if it has one** (often `CONTEXT.md`). Name things the way it
names them, and check each decision in the issue against it. A request that uses a word the glossary
gives to a different thing will build the wrong thing. Read the architecture decision records for the
area too (often `docs/adr/`). Those decisions are settled: the plan does not reopen them.

Then list the files to create or change and what each one does. Break the work into small tasks.
Each task is a **vertical slice**: a narrow but complete path through each layer it touches, which
you can verify alone. Shape each task for TDD: **failing test → watch it fail → minimal code → run →
commit.** Name the tests each task adds and the [test entry point](#f2a--agree-the-test-entry-point)
each one uses. Record the goal, the approach and the risks. For non-trivial work, run a read-only
`plan-scout` agent first.

**The PR body is the plan of record.** Write the plan there, in place of the placeholder from F1, not
in a file in the repository. The body survives your context, a human reads it without a search, and
the next pass resumes from it. For a batched PR, write one section per member issue. The body holds:

- a short statement of what is wrong, what this changes and what you need from the reader;
- a **`Seam:`** line and a **`Test entry point:`** line ([F2a](#f2a--agree-the-test-entry-point));
- the tasks, and an **Assumptions** heading for each decision you made without the user;
- one `Closes #<k>` line per issue the PR closes.

While a workflow runs, call `mcp__ndev__finishedPlan` with the file instead: it writes the body, and `finishedDevelopment` runs `gates.sh`. With no workflow:

```bash
gh pr edit <pr> --repo "$REPO" --body-file <file>   # write a file; do not paste inline
```

⚠️ **This edit replaces the body from F1, and with it the `Closes #<n>` line.** The PR then names no
issue: the issue shows no linked work, nothing closes on merge, and the next survey reads the issue
as not started. **Run the `closingIssuesReferences` query from [F1](setup.md#f1--worktree-branch-and-draft-pr)
after each body edit**, and add the `Closes` line again if it is gone. Add one `Closes #<child>` per
sub-issue that your teammates carry, and run the query after each.

`${CLAUDE_PLUGIN_ROOT}/scripts/work/gates.sh <issue> <ref> <pr>` fails a non-trivial issue whose PR body
still holds the placeholder or names no test entry point. Copy the plan to the issue as a comment,
read it once for clarity, then move the card to *In progress* (`board.sh move <itemId> progress`, the `work-heavy-auto` skill). While a workflow runs, the plugin moves it. `finishedPlan` also runs `pre-push-check.sh` on the base, before the sign-off.

### F2a — Agree the test entry point

**The test entry point (the seam) is where a test calls the code and observes the result, without
reaching inside.** You can test the same change from several places. Choose **before you write a
test**, so that the tests survive a refactor.

| Kind of change | Usual seam |
|---|---|
| A command-line tool | Run the CLI with arguments; assert its output, exit code and side effects |
| An HTTP service | Call the route; assert the status and the body |
| A library or module | Call its public function or API; assert the return value |
| A web page | Drive the page in a real browser; assert what the user sees |
| A database change | Apply the migration, then run the query the application runs |

The project's `CLAUDE.md` or wiki may list its concrete seams and where each kind of test lives. Read
it, because CI often selects tests by package: a test in the wrong place runs on every change or on
none. The `testing` skill has the tier definitions and resource rules.

Three rules to choose one:

- **Prefer an entry point that exists.** A new one is a new thing to maintain.
- **Take the highest one that can still see your change.** A test on a private helper breaks on each
  rename while nothing a user sees has changed (most of `guards.md`). A test that drives the whole
  browser tells you that something broke, not what.
- **Use fewer entry points.** One piece of work wants one.

Write it in the PR body in plain words, with what a test there asserts:

```
Seam: the `export` CLI command
Test entry point: run `<tool> export --format csv` on a fixture file — assert the rows written
```

**Attended?** Give the entry point to the user in that plain form before you write the test, and
get agreement. **Unattended?** Choose it with the rules above and write it down. An entry point that
nobody wrote down is one that nobody can disagree with.
