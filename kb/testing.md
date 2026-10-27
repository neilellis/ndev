# Testing

[kb](README.md) › testing

**A test is evidence only when it can fail with the defect and pass without it.** Write it first, see it fail for the intended reason, then write the code ([core belief 2](core-beliefs.md#2-test-first-and-prove-guards-in-both-directions)). Guard design has its own page: [guards.md](guards.md).

## The cycle

1. Write a regression test through a public interface.
2. Run it. It must fail, and the failure must name the defect. An import error, a `NameError` or a collection error is not proof.
3. Write the smallest change that makes it pass.
4. Run it again. Run the neighbouring tests.
5. Commit. The test stays as the permanent guard.

Mock only external boundaries (the network, the clock, a paid API). A mock of your own code tests the mock.

## The taxonomy

| Kind | What it does | Where it runs |
|---|---|---|
| Unit test | Calls one unit in process. No network, no database, no subprocess. | Every PR, fast lane. |
| Integration test | Spawns a real tool (git, bash, a database, a build) or crosses a process boundary. | Every PR, slower lane. |
| Guard | Reads the whole tree and asserts a property of it. | Every PR, unfiltered by diff. |
| Structural rule | A pattern over the syntax tree (ast-grep), with valid and invalid proof cases. | Every PR, and on each edited file. |
| Browser test | Drives a real browser. | Never a gate. A behaviour that must not regress needs a unit test too. |

**A test that spawns a tool is an integration test,** even when it is short. It does not go in the unit lane.

## Where a test lives

- A test lives with the code that it tests.
- A guard reads the tree, so it lives in a root `guards/` folder and runs on every PR without a diff filter.
- A pattern over the tree is a structural rule with its proof tests. See [guards.md](guards.md#which-home-a-guard-belongs-in).
- A guard that crosses languages lives in the root `guards/` folder.
- Test basenames are unique across the repository. Two files with the same name collide in some runners.
- A test in a folder that CI does not collect skips for ever. Prove that CI collects it ([ci.md](ci.md#ci-proves-that-each-test-ran)).
- A `tsconfig.json` `include` must list the test folder, or the type checker never reads the tests.

## How a test lies

Ask one question of every test: **could this pass with the feature removed?**

### It does not execute the thing

- Registered is not working. Named is not running. A fixture is not the pipeline.
- A test case must cross the place that the change altered.
- Default wiring may never reach the injected branch. Assert that the arm was taken.
- A signature is not a wire. A function that accepts a parameter may ignore it.

### It reads absence as a pass

- An empty or partial list reads as "settled". Assert the expected count.
- An absent verdict is not a passing verdict. "Health unknown" is not "healthy".
- A negative assertion ("X does not appear") needs a positive control that shows X can appear.
- Count what the code skips, name the first few, and put the count in the run summary. A silent empty result is the signature of a broken input.

### It agrees with itself

- A fixture copied from the code under test agrees with that code.
- Assert an independent literal, never the production constant.
- A fixture written from issue prose tests the prose. Check the fixture's shape against real data.
- The two ends of a route share one fixture, verbatim.

### Its environment differs from production

- SQLite `LIKE` ignores case. Postgres `LIKE` does not. NULL ordering and integer division also differ. Test against the production engine.
- A fixture-sized test is not evidence at scale. A query with more than 65,535 bind parameters fails in Postgres.
- Determinism needs separate processes. Two calls in one process share caches and seeds.
- A suite that ran only on one laptop is not portable until proven so. Run it with production environment variables and under CPU load.

### Its failure is swallowed

- A broad `except` swallows the test's own `AssertionError`. Raise a `BaseException` subclass from the probe, and assert that the guard saw the event.
- An early return above an exit-code assignment hides the code that must win.
- `result.output` can merge stderr into stdout. Assert on the stream that matters.
- `JSON.stringify(error)` gives `{}`. Log the message and the stack.

### Smaller traps

- Resolve paths from the test file (`__file__`, `import.meta.url`), not from the working directory.
- Eager arguments raise before the function can decide.
- A cache can answer before the code under test runs. Clear it.
- A non-unique key is not a key.
- A re-render is not a remount.
- A CommonJS spy cannot see an ESM import.
- Main-module self-detection fails through a symlink.
- Base64 tests need a character outside Latin-1.
- Redaction tests need negative cases: a real path, a URL, a long id, an `@` inside a secret.
- A timing guard can fail to fail. Prove that it goes red.
- Test that the exception happens before you write the code that prevents it.
- Search the whole repository for call sites before you change a signature.

## Mutation proof

To prove a test, break the code and watch the test fail.

1. Copy the file to a backup.
2. Apply the mutation. Assert that it landed: `assert source.count(old) == 1` before the replacement.
3. Run the test. It must fail for the intended reason.
4. Restore with `cp` from the backup, not `git checkout`.
5. Clear `__pycache__` or the build cache, so that a stale artefact does not answer.
6. Never stage while a mutation is applied.

A killed mutation is the evidence. A test that passed the first time and never failed is not yet evidence.

## Live tests

A live test needs a real service (a database, a node, a paid API).

- When the service is absent, the test skips.
- Each live suite reads a "required" variable (for example `<SUITE>_LIVE_REQUIRED=1`). When the variable is set and the service is absent, the test fails.
- The CI step that starts the service sets the variable. Without it, a service that fails to start makes every test skip, and the step stays green.
- A static check proves that each live suite runs in a step that sets its variable.

## Browser checks

A browser check is never a gate ([the taxonomy](#the-taxonomy)), but its report must be true.

- If no browser tool is available, or a size cannot be set, report the check as incomplete. Never report it as passed.
- Check each changed page at three device sizes, for example laptop 1440 × 900, tablet 820 × 1180 and phone 390 × 844.
- After each resize, confirm that the page's `window.innerWidth` matches the size. Some windows have a minimum width, or ignore the resize. If the width is wrong, the screenshot is not evidence.
- At each size, check that the changed content is visible, that nothing overlaps, is cut off or scrolls sideways, and that the console shows no errors.
- Look at each screenshot yourself before you share it.

## Flaky tests

- A flaky test can be telling the truth. Find the race before you add a retry.
- Pin a transient state instead of racing it. Avoid check-then-act.
- A timeout that fires on a healthy run under load teaches people to press re-run. Measure the slowest healthy run and set the limit with headroom.
- A readiness check must test the exact round trip that the test asserts. "The service answers" is not "a write is visible to the reader". If the test writes on one node and reads on another, wait until a write is readable on the other node.
- If a correct change makes a timing-sensitive test or demo flaky, fix its readiness check. Do not change the correct code.

## Writers

A writer must not truncate a file before it can refuse. Write to a temporary file in the same folder, then rename it over the target (`os.replace`).
