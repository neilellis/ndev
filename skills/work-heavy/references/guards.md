# How tests lie: read before you write a guard

A **guard** is a test that constrains the whole tree (an architecture rule, a coverage check, an
accessibility rule). Guards are the most useful tests and the ones most often wrong. Each rule here
comes from a guard that passed CI while the defect was present.

## Writing one

1. **A guard is not a guard until you saw it FAIL on the real defect, in the real tree.** Put the real
   regression in (for example with `sed`), run the guard, see it go red *for the right reason*, then
   revert. A guard that you only saw pass is decoration.
2. **Mutate → assert → restore in one synchronous step.** Never leave the tree mutated across a wait.
   Subagents share your working directory: a helper's `git add -A` during the mutation commits your
   broken code. If a mutation must last longer, mutate a **copy** and point the scanner at the copy.
3. **A guard that cannot fail and a guard that cannot pass are the same bug.** The second makes you
   "fix" working code. Prove both directions.
4. **Assert the thing, not a proxy.** Grep for the assertion, not the topic. Read the computed style,
   not the class string.
5. **A guard that fails OPEN is worse than no guard.** It makes false confidence. Look for spans that
   run to end of file, patterns that match nothing real, and allowlist entries that excuse a violation
   no rule can make.
6. **Prove it on real generated output**, not on a hand-written mock. Commit the real output as a
   fixture if necessary.
7. **Say the consequence, not the mechanism**, in the failure message.
8. **A lookup whose branches agree is a bug or a commitment; only the prose tells you which.** Do not
   "simplify" identical branches before you read why they are identical.

**Mutation proofs need a fast single-file run.** Find the command that runs one test file and check
that it really filters (`verify-traps.md`). A slow full suite in that loop makes agents skip the proof.

## The pathology: a proxy in place of the thing

| The lie | Example |
|---|---|
| **It counts instead of reading.** | An accessibility guard counts row headers. When the row header is the rank, a screen reader never says the row's name. A count is satisfied by the wrong element. |
| **It greps source, and a comment satisfies it.** | A guard matches `preventDefault()` in the source and passes on the broken component, because the fix's docblock names the call. **Strip comments; assert only on code that runs.** |
| **A fuzzy selector matches the wrong element.** | `getByRole("link", {name: /account/i}).last()` matches a different link when the real one does not render. **Use exact names.** |
| **It points at the wrong tree.** | A guard scans only `components/ui/**` while most defects live outside it. **A guard's scope is part of the guard.** |
| **It cannot pass.** | The guard targets a branch that the test seed makes unreachable. |
| **It asserts an invariant by example.** | A loop over an empty map passes. Assert the map is **not empty** first. |
| **The fixture never reaches the branch under test.** | A negative guard feeds input that exits the rule before the branch it is about. **For each negative assertion, first assert the precondition that makes execution reach the branch**, then mutate the branch and see it go red. |
| **Its premise expired.** | A spec asserts a component that was deleted. It can fail; it can never pass. |
| **It proves the DOM, not the CSS.** | A readiness check counts elements; the page can render them unstyled. Check styles separately. |
| **It is pinned to copy.** | A focus check that finds its target by button text breaks when the copy improves. **When the claim is about focus, colour, geometry or mechanism, select by identity (`data-*`, role), never by text.** |

## A guard's scan root is a path, and the tree moves

A guard with a fixed root stops covering code, one restructure at a time: fewer files, no findings,
exit 0. **Derive the roots from the repository root** with a glob that follows a restructure. **Refuse
a glob that matched nothing**: exit with the "could not measure" code. **Assert a minimum count of
files scanned**: a count is the only difference between "read all, found nothing" and "read nothing".

## Removing a default: the guard that reads source cannot see callers

Making an optional argument required changes each caller, and text-reading guards cannot see a
broken caller.

1. **Grep for callers that RUN it, not callers that mention it**: scripts, workflows, git hooks, other
   skills, and the test suite. A test is a caller.
2. **Write one test that RUNS the command** (a CLI test runner, `subprocess.run`). A signature guard
   proves the declaration; only a run proves the refusal.
3. **Pin the exit code.** "Could not measure" (2) and "measured a failure" (1) mean opposite things to
   the caller.

**A grep for the literal default fails open on an indirect one.** `DEFAULT=x; VAR="${ENV:-$DEFAULT}"`
restores the default and satisfies a guard that looks for `x` on the assignment line. A guard that
takes the first regex match in a file is also wrong as soon as the value appears in a comment or a
second job. Parse the structure, take each match inside it, and **fail when there is more than one**.

## ⚠️ `git checkout -- <file>` during a mutation proof destroys your uncommitted work

It reverts the whole file to the index, including your uncommitted fix in the same file.

- **Commit first, then mutate** (golden rule 9).
- If you must mutate over uncommitted work, back up with `cp` and restore with `cp`.
- **Verify the restore by content**: `grep -c` the mutation marker and expect 0.

## Pinning a generated file to its source

A recorded hash of the source cannot do it, because the person who edits the source also refreshes
the hash. Any check over a recorded value fails this way. The guard must read the generated file.
When you compare text extracted from a rendered format (PDF, HTML), normalise it first (for example
Unicode NFKD, which expands ligatures such as `ﬂ`), and compare words and digits in order. After you
loosen a comparison, prove again that it fails on the real defect.

## An assertion over the caller's command string cannot see the called script

A guard that reads a workflow's `run:` lines passes when the behaviour lives in the script that the
line calls. Name the layer that decides the outcome and assert there. Follow each invocation one hop.

## A path-gated job cannot guard what it never runs on

A test that asserts a file exists guards only diffs that trigger its job. A docs-only diff can
delete the file, pass, and break `$BASE` after merge. The failure then appears on unrelated branches.

1. When a change deletes or renames something outside the gated tree, grep the tests for its path.
2. When a check goes red and your diff cannot reach it, suspect `$BASE` first (F0b).

## Two checks over one shared helper still disagree about what they do not share

A shared helper makes two checks agree only about the shared part. Read what each caller asserts
after the helper returns. A comment that says the two "can never diverge" is the real hazard: fix it in
the same commit.

## The tests passed and the documented command failed

A default computed from the script's own location stops being true under `git worktree`, a
submodule or a symlink. Tests pass explicit paths, so nothing tests the default. **Run each command
that you document before you ship the document.**

## What jsdom cannot see

Layout and sizes, whether an animation runs, `:focus-visible` (a programmatic `.focus()` does not
trigger it), cascade layers, the client/server module boundary, and opacity (Playwright's
`toBeVisible()` ignores it). Test these in a real browser against the deployed build.

## An unscoped query cannot tell an active panel from a hidden sibling

jsdom renders `<div hidden>` in full. When inactive tabs stay mounted, `queryByText(...)` finds text in
the hidden sibling. Scope each query to the visible surface:

```ts
const visible = (el: HTMLElement) => el.closest('[hidden]') === null;
expect(screen.queryAllByText(/…/).some(visible)).toBe(false);
```

## A guard that pins an accepted defect must name its exit condition

When a guard pins a known defect, fixing the defect turns it red, and red reads as "your change is
wrong". Write two sentences in its docstring: what will be true on the day it fails, and which other
guards move at the same time.

## A red test may be telling the truth

A flaky test trains you to run again instead of look. Before you run a red test again, ask what must
be true for it to be right.

## `git ls-files` reports the index, not HEAD

To prove that something was **committed**, assert on `git ls-tree -r HEAD --name-only`. The index and
HEAD differ by one operation: the operation under test. When a guard reads state, ask which of two
adjacent states it reads.

## `ast.parse()` does not catch duplicate keyword arguments; `compile()` does

After a scripted edit to Python, use `compile(src, path, "exec")` or import the module.

## The evaluator in a guard can be wrong

A guard that evaluates a foreign language (a workflow expression, a glob, a cron string, a query) is an
interpreter between the assertion and the truth. GitHub's `a && b || c` is not a ternary: the
operators return operands. Test the interpreter against the specification, and **feed it the
plausible but wrong variant** and assert that the guard rejects it.

## An instrument built from its own output cannot see what the work dropped

Generate test cases from the **input** of a conversion, not from its output: a case built from the
output cannot show a dropped alternative. A comparison over terms that match nothing proves nothing.
Take the comparison base as an argument, and make **zero rows measured exit non-zero**.

## A suite that passes from one directory and fails from another

A data path relative to the working directory gives an error that names data, not the directory.
Copy the invocation from the CI workflow before you conclude anything about CI. When results differ
on the same commit, the difference is in the environment, and the working directory is part of it.

## A proposed fail-open is a hypothesis: test it before you "fix" it

When a review says "X would defeat this guard", do X and look. A fix that is better for other reasons
may ship, but it must not claim to close a hole that did not exist.

## A fixture the real producer never emits

Read the **producer**, not the consumer. Use one real item of each kind. A pattern that ends in `.+`
cannot tell populated from empty. Generate the artefact from real inputs once, and read it.

## An assertion over raw markup also reads the class names

`expect(html).not.toMatch(/\d/)` fails on `class="mb-8"`. Strip the markup and assert on the text the
reader gets. Use the raw string only when the claim is about the markup.
