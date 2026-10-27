# Implement (F3, F3b, F3b1, F3b2, F3c, F3d)

Part of the `work-heavy` skill. This file covers TDD, code comments, naming, logging, the two-axis review
and the dead-code sweep.

## F3 — Implement and test (TDD)

Do the plan one task at a time, with strict TDD (`mattpocock-skills:tdd`): **write the failing test,
run it, watch it fail, then write the minimal code to pass.** After each task, do a quick spec and
quality check, and fix Critical and Important findings before the next task. Independent tasks that
touch different files can run in parallel workers. Tasks that share files stay sequential.

**A good test describes what the code does for a caller, at the test entry point that
[F2a](planning.md#f2a--agree-the-test-entry-point) names, not how it does it.** You can rewrite the
implementation and the test still passes. Three ways this goes wrong:

- **Coupled to the implementation.** The test mocks a collaborator inside the module, calls a private
  function, counts calls, or checks the result through a side channel (it queries the database
  instead of the interface). The sign: a refactor that changes no behaviour makes it red.
- **Tautological.** The expected value is calculated the same way as the code calculates it, so the
  test cannot disagree with the code: `expect(total(items)).toBe(items.reduce((s, i) => s + i.price, 0))`.
  Write the answer as an independent literal (`toBe(15)`) from a worked example or the specification.
  Review does not see this failure, because the code looks careful.
- **Written in bulk before the code.** All tests first, then all code, tests behaviour that you only
  imagined. Write one test, then its code, then the next.

**Mock only at the edges of the system**: a third-party API, the clock, the network. A mock of
something inside the module under test is the first anti-pattern in a different form.

Run the project's typecheck and lint **first** (golden rule 14), then its unit and integration
suites, then its build. The commands are in the project's `CLAUDE.md`. Zero findings is the bar.
Before you trust a single-file or filtered test command, read `verify-traps.md`: some runners ignore
a path argument and run everything.

**Issue-pinned regression tests** (skip for trivial work): put the issue's acceptance criteria in a
pinned unit test named for the issue (for example `issue_<n>_<slug>.test.ts` or
`test_issue_<n>_<slug>.py`, in the project's test tree), and for UI work a pinned E2E spec. These are
in addition to the TDD tests. Check all three artefacts (plan, pinned unit, pinned E2E) with the
`${CLAUDE_PLUGIN_ROOT}/scripts/work/gates.sh <issue> <ref> <pr>`, and repeat until it passes. **Exit 2
means it could not measure. That is never a pass.**

⚠️ **The unit slot and the E2E slot are different directories.** A pinned test in an `integration/`
directory fills only the integration slot. Schema work reaches for a database by reflex, so all
pinned tests land there and the unit slot is empty. Write at least one pinned test that needs no
database: the model, the migration module or a pure function usually holds the invariant.

**Writing a guard** (a test that constrains the whole tree) has its own rules: read the `testing`
skill and `guards.md` before you write one.

**Expensive evaluation gates are a decision, not a reflex.** If the project has a quality or
regression evaluation that costs hours, its `CLAUDE.md` says when it is necessary. Run it only when
the change can move it. "Not scored" is a fact to state, never to hide.

### F3b — Code comments

**A comment must say something that the code and `git log` cannot.** Usually there is nothing. The
default is no comment.

**Write a comment only for:**

- **Why the code exists**: the constraint, failure mode or external fact that is not obvious.
- **A trap in the system around it**: a foreign API's behaviour, an order requirement, a value that
  must not change and why.

**Leave out:**

- **Commentary**: the reasoning for a choice, rejected alternatives, arguments for the design. Those
  go in the PR, the issue or the wiki.
- **History, in any form**: what the code did before, what was deleted, what changed and when. Git
  holds that.

**Issue and PR numbers are markers, not narrative.** A bare `(#123)` after a constraint is
acceptable. A sentence that explains what #123 changed is history: remove it.

The same rules apply to docstrings. A module docstring says what the module is for and what a caller
must know. It is not a design record or a changelog.

**The test:** delete the comment. If the code is still correct and the next editor cannot break
something they could not see, the comment was commentary. If a fact was lost (usually a *why*), keep
it in one sentence. Apply this to code you touch, not only code you add.

### F3b1 — Naming

**Name a thing with the usual word for it.** A name is read many times and written once. A name that
the reader must learn costs each future reader that lesson.

**The test:** say the name to a person who knows the domain but not this codebase. If they must ask
what it means, it is the wrong name.

- **Use the English word when one exists.** A coined word (`leaf`, `anchor`, `gardener`) needs a
  paragraph before a reader understands it.
- **Make sure the word is free.** A word that already means something else in the project is worse
  than a coined one, because the reader gets no signal that two meanings exist.
- **A term of art from the domain is acceptable. A term you invented is not.**
- **When a coined name exists and a rename is too wide**, say the plain words once in the docstring.
- **At review, a name that needs a glossary is a finding.**

**A bare number in a comparison is also an unnamed thing.** Use a named constant (for example
`HTTPStatus.OK`) or a module-level `UPPER_SNAKE` constant named for what the number **measures**.

⚠️ **Do not share one constant between two sites that only hold the same number today.** They then
change together, and nothing warns you. Same number, different concepts, separate names.

**Tests are exempt.** In a test the bare number is often the thing under assertion. Put the
exemption in a per-file ignore, never a global ignore: a per-file ignore has a boundary that a reader
can check.

**For a closed vocabulary, use a type, not a constant** (`Literal[...]`, a union of string literals,
an enum). Use a branded or `NewType` type where a function takes several string arguments, because a
swapped argument is silent there. Where a function takes many parameters, pass one object.

### F3b2 — Logging

**A comment is read once. A log line is read while the code runs.** The level mix is more important
than the total: an application that logs more warnings than info lines speaks only when something is
wrong, so a stalled run and a healthy run look the same.

Bind a named logger per module, never the root logger. Use the logger's placeholders, not an
interpolated string.

| Level | For | Test |
|---|---|---|
| ERROR | It failed and nothing recovered it. | Somebody must act. |
| WARNING | Wrong, and the run continued. | The result is usable; the reason it degraded must be visible. |
| INFO | A major decision and each stage boundary. | A person who watches a live run needs this line. |
| DEBUG | Help to find a known fault. | Unwanted on a healthy run, wanted on a broken one. |

**Two places always get an INFO line.** A **boundary**: what starts, over how many items. A
**skip**: what the run decided not to do, and why. A skip is the most usual cause of "it ran and
nothing happened".

Make a long TTY run easy to scan in the formatter, not in each message (see `SKILL.md`, TTY log
visibility).

### F3c — The two-axis review

Before the final push, review the diff on **two axes, with two independent reviewers, and keep the
two reports apart.** A change can pass one axis and fail the other. One reviewer who holds both
questions lets each hide the other. Use `mattpocock-skills:code-review` or two `diff-reviewer`
agents, both over `git diff origin/$BASE...HEAD` (three dots: against the merge base). Make sure the
diff is not empty first.

**Axis 1 — standards.** "Where does this diff break a rule that this repository wrote down? Cite the
file and the rule." Give it `AGENTS.md` / `CLAUDE.md`, these golden rules, `guards.md` if the diff
adds a guard, and the `copy` skill if it changes user-visible words. Also look for these, unless the
repository approves them:

> a name that does not say what the thing does · the same logic in two hunks · a function that uses
> another object's data more than its own · the same parameters that travel together and want to be
> one type · a string in place of a concept the glossary names · the same `if`/`switch` cascade again
> · one change that forces edits in many places · one file changed for unrelated reasons · an
> abstraction for a need the issue does not have · a long `a.b().c().d()` chain · a function that only
> passes the call on

**Axis 2 — specification.** "Read the issue. What did it ask for that is missing or incomplete? What
is in the diff that nobody asked for? What looks done but wrong?" Give it the issue body and comments
and the plan in the PR body. Quote the line it judges against for each finding. No issue and no plan
means "nothing to check against", which is useful to know.

**When the PR quotes a measurement, tell the reviewer to RUN it again, not to read the script.** Give
it the command and the artefact the PR names, and ask for the number. That catches an instrument that
cannot see the defect and a documented command that reports a false zero.

**Report under two headings and do not re-rank across them.** Resolve each Critical and Important
finding on both. Then run all suites again (a fresh run, not a remembered one) with 0 failures. Then
do the dead-code sweep ([F3d](#f3d--the-dead-code-sweep)). Commit (body `Closes #<n>` for issue work)
and push.

**An agent that reviews its own code argues for its own solution.** That is why both reviewers are
independent, without authorship context, and get the diff and the sources, not your account of them.

### F3d — The dead-code sweep

**Before the final push, find the unused code this branch introduced.** A refactor that changes a
call path leaves the old helper behind. The typechecker passes, the suites pass, and the reviewers
see what was added, not what stopped being called.

Use the **`deadcode`** skill. Its `sweep.sh` (or `sweep-ts.sh` for TypeScript) compares your head
with the merge base and prints only the difference. Exit 0 is clean, 1 is findings, **2 is could not
measure, never a pass**.

Then:

1. **Triage each finding** against the causes in the `deadcode` skill. A decorator registration, a
   `getattr` or a name that another package imports is invisible to it. A finding is a question, not
   a verdict.
2. **Remove the true positives and run the sweep again** until it exits 0. Removing one function
   exposes the helper that only it called. **Then use the `forget` skill.** A dead function is inert.
   A wiki page that still describes it is active: the next agent reads it and builds it again (golden
   rule 13).
3. **Run the typechecker and all suites again after the removal.** A string-keyed call is invisible to
   the sweep and the typechecker. A red test means the name was not dead: restore it and add it to the
   tool's ignore list.
4. **Put the report in two places**: the PR body, under the plan (names removed and names kept), and
   the commit message of the deletion, so `git log` says which names went and why.

A clean sweep also gets one line in the PR body. "No dead code introduced" is a measurement. A silent
sweep looks the same as one that nobody ran. If no sweep exists for a language in the project, say so
in the PR body.
