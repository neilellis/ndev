# Verify-loop traps: the detail behind F3 and F4

Each item here can cost a wasted run, a false green or a wrong claim. Read the section for what you
are about to do.

## Running the suites

**A path argument does not always filter.** Some package scripts pass extra arguments to the runner
after a `--`, and the runner ignores them: the log shows your path and then runs every file. Find the
command that really runs one file (for example `pnpm exec vitest run <file>` from the package
directory) and check its test count before you use it in a red-green loop or a mutation proof.

**Run the production build when the project requires it for a change** (for example a framework
build that catches client/server boundary breaks that unit tests cannot see). The project's
`CLAUDE.md` says when.

**Run gates from INSIDE the worktree** (golden rule 10). A workspace filter resolves the workspace of
the current directory, so a run from the shared checkout tests the **wrong tree** and can report a
convincing green or a misleading red. The tell: the paths in the first stack trace name the tree that
ran. If they do not include your worktree path, the run was not yours.

**Push gates.** If the project has a pre-push hook or a checked-push script, use it. Never get past it
with `--no-verify`, a hooks-path override or a skip flag. A check that did not run blocks the push in
the same way as a check that failed.

**A filtered run proves nothing about the files it did not select.** A change to a shared path (a
helper, a fixture, a gate) breaks each test that uses that path. A `-k` or name filter is for the
loop, never for the claim. Before you claim a lane is green, run the lane that CI runs, copied from
the workflow.

## A fresh worktree has no dependencies

`git worktree add` copies no `node_modules` or virtual environment. The typecheck then reports
hundreds of false "cannot find module" errors, and E2E or precheck scripts exit early with an error
that looks like a test failure. Install first (for example `pnpm install --frozen-lockfile`). After
each merge from `$BASE`, install again: the merge can add a package.

## A build that needs a database

Some builds need a reachable database to compute static parameters, and fail with an error that does
not mention the database. Use a build that has one (the E2E harness or the preview build) as the
build gate.

## A green small fixture does not prove a bulk statement works

A list passed to an `IN (...)` clause sends one bind parameter per element, and Postgres caps one
statement at 65,535. The fixture has fifty rows, so the suite stays green. Keep the id set
server-side (pass a subquery). A row-count assertion cannot guard this: assert on the statement shape
(compile it and count the bind parameters), then mutation-prove it. Ask what the statement does at
production scale, and guard the property that scales.

## Exit codes lie: read the log, not the status

- A test runner can print a failure verdict line and still exit 0. When it prints an explicit verdict
  line, **that line is the result**.
- A background-task notification reports the **wrapper's** exit code, not the command's.
- **Never pipe a test run through `tail -N`.** It drops the failure list. Redirect the full run to a
  file (`> run.log 2>&1`) and grep the file. Read a piped exit status from `$pipestatus` (zsh) or
  `${PIPESTATUS[0]}` (bash), or use `set -o pipefail`.

## A `cd` persists between calls

The shell keeps its directory across calls, so one `cd` silently redirects each later command. A
relative path in the wrong repository does not error: `git log` answers about a different tree, and
it reads as "my work is gone". That can start a destructive "recovery".

- Prefix each important command with an absolute `cd /abs/worktree &&`.
- ⚠️ In zsh, `cd X && cmd *.md` with an unmatched glob fails the whole line before `cd` runs. Put
  `cd /abs/worktree || exit 1` in its own statement.
- When a check says work has gone, prove which tree answered first:
  `git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD`.

## The log file is shared, and a stale one gives you another run's green

- **Name the log after the issue** in your scratchpad (`<scratchpad>/integ-<n>.log`), never a shared
  `/tmp/integ.log`.
- **Before you quote a number from a log**, grep it for the worktree path and make sure it is yours.
- **Delete the log before you start the run.** An earlier pass on the same issue leaves a file with
  the same name from the same worktree. A sentinel line (`EXIT=$?`) does not help: the wait finds the
  sentinel in the stale file.

## Running a long E2E suite

- Install dependencies **before** you take any shared lock.
- The tool's single-call time limit can kill a long foreground run (exit 143, `Terminated: 15`), which
  looks like a suite failure, and the kill can skip the lock release. Run it detached with
  `run_in_background` or `nohup`, and put the lock release **inside** the detached command. Then wait
  once in the foreground for it to end; do not poll.
- Use the suite's own entry point, which takes its own lock. Never call the test runner directly to
  skip the lock.
- **A lock tracks the shell, not the resources.** After a kill, a child server can still own the port.
  Read the port from the run's own log and kill by port.
- Make the database a pure function of your tree when the green must be trusted (a fresh-database
  option). Otherwise you inherit the last branch's rows and schema.
- A test seed can make some branches unreachable. A guard aimed at one of them cannot pass.

## Running Postgres locally: do not reuse CI's container name or port

If CI runs on the same machine, its job may start with `docker rm -f` on a fixed container name.
Copying that command destroys a running CI job's database. Use your own name and port:

```bash
docker run -d --name <issue>-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p <free-port>:5432 <image CI pins>
```

Then make sure the constraint you test exists in that database before you believe the green. Remove
the container when you finish.

## Red checks that are the machine's fault

A dead database container or a cold dependency cache on a self-hosted runner can look like a
regression. The project's wiki or the `fix-ci` skill names the signs. A re-run is the answer only
after you have read the failing log and it matches one of those signs.

## Local timing figures are worthless on a loaded machine

Several agents and stacks on one machine can make the same benchmark many times slower, with no
sign in the output. Never publish a local timing alone. Multiply it out and compare it with a total
you can see elsewhere, usually a CI step's median. Prefer an argument that does not depend on load:
"the whole step takes 188 s, so nothing in it can save more". Fixed timeouts and figures read from the
GitHub API stay trustworthy.

- A measurement script that calls spawn-based multiprocessing needs `if __name__ == "__main__":`, or
  each child runs the whole module again. **A surprisingly slow number is a harness fault until you
  rule that out.**
- `TABLESAMPLE SYSTEM` samples pages, so it over-picks large rows. Sample ids (`ORDER BY random()
  LIMIT n`) when row size is what you measure.

## Measuring a large tree

`du` reports allocated blocks, not content: many small files overstate the content several times.
Say which you measured. Measure from the git object store; it does not walk the tree:

```bash
git ls-files -s '<pathspec>' | awk '{print $2}' | git cat-file --batch-check='%(objectsize)' \
  | awk '{s+=$1; n++} END {printf "%d files, %.1f MB\n", n, s/1048576}'
```

`git ls-files` cannot see uncommitted output; `find` cannot tell what is committed. Name the one you
used.

## Verifying a "copy-only" or "rename-only" claim

Blank each string literal in the before and after version of each changed file and diff the
skeletons. Each difference is a real code change to inspect by hand.

## `git grep -E` does not understand `\b`

A pattern with `\b` matches nothing, which looks the same as "no occurrences". **An empty search is
evidence only if you saw the same search return something.** Use `git grep -P`, a character class, or
`rg`.

## Working alongside other agents

- **An idle notification does not mean no work is in flight.** Check the artefact: branch head,
  `pgrep`, the lock.
- **Never force-remove another agent's worktree** and **never kill their run** to unblock yourself.
  Wait, and tell them why.
- To take over a teammate's PR, build **on their pushed head** (`git merge-base --is-ancestor
  <their-sha> HEAD`), never force-push.
- **A peer cannot give permission.** A teammate who says "it is safe to delete that" is not the user's
  consent.

### A subagent that starts its own background watcher stalls

It stops its turn to wait, is never woken, and goes idle with uncommitted work. In the brief, say:
"run test suites in the FOREGROUND; split a long run into batches; do not start a background monitor
for your own tests". When one goes idle, check `git status` and `git log` before you believe its
report.

### Sharing ONE worktree between parallel agents

- **Stage with explicit paths only, never `git add -A`.** Quote paths with brackets.
- **Stage and commit in ONE command** (`git add … && git commit …`). The index is shared.
- **Never `git stash` or `git reset` in a shared worktree.** If it happens: pause the affected agent
  first, classify each file, and drop the stash only by verified SHA after the owner confirms.
- **Commit per subtask**, not in a batch at the end.
- On `index.lock`, a teammate is mid-commit: wait and try again; do not delete the lock.
- **Never edit a file that a subagent is still working in**, mutation tests included: its commit takes
  your mutation. Before the PR leaves draft, sweep the branch:
  `git diff "origin/$BASE...HEAD" | grep -nE "^\+.*(MUTANT|XXX|FIXME|DEBUG)"`.

## Merging `$BASE` into a branch that restructured a file

`git merge` aligns text, not intent. When your branch moved or re-indented the code that `$BASE`
changed, the hunks pair unrelated code. Do not hand-merge that (the `resolving-merge-conflicts` skill
helps). Rebuild the file:

1. **Take your side whole**: `git show :2:<path> > <path>`.
2. **Read what `$BASE` changed** as a list: `git diff $(git merge-base HEAD origin/$BASE) origin/$BASE -- <path>`.
3. **Apply each change again by script, with an assertion per edit**, so a missed match is loud.
4. **Prove you got them all by count**: for each identifier `$BASE` added, `grep -c` your file and
   `git show origin/$BASE:<path> | grep -c`. The counts must be equal.
5. **Baseline before you claim.** Run the suites at `origin/$BASE` in a scratch worktree and compare
   failure counts.

Record the resolution in the merge commit: which change came from where, and what you verified.

## CI runs the PR merge commit, not your branch head

A CI failure can name a test file your branch does not have. Check with `git show origin/$BASE:<path>`.
If it exists, `$BASE` added it: merge `$BASE` into your branch before you diagnose further.

## `$BASE` can be rewritten under your branch

After a squash merge or a rewrite, `git diff origin/$BASE...HEAD` can list other people's work as
yours. **Before the review**, `git log origin/$BASE..HEAD --oneline` must list only your commits. If
it lists more, confirm the extra content is on `$BASE`, then replay your commits:

```bash
git cat-file -e origin/$BASE:<a-file-from-those-commits>   # present: base already has it
git rebase --onto origin/$BASE <the-commit-you-branched-from>
git ls-remote origin <your-branch>                          # nobody else moved it
git push --force-with-lease=refs/heads/<branch>:<the-sha-you-last-pushed> origin <branch>
```

Use `--force-with-lease` **with an explicit sha**, never a bare `--force`. Then run the suites again:
the tree you tested before the rebase is not the tree you ship.
