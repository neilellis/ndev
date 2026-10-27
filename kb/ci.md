# CI

[kb](README.md) › ci

**CI on a pull request tests the merge result. No other gate sees it.** Each gate covers a different hole, so no gate replaces another. Read this page before you trust a green check.

## The gates are not substitutes

| Gate | What it tests | What it cannot see |
|---|---|---|
| Edited-file guards | One file, as the agent writes it | Everything else |
| Pre-push hook | The branch's committed tree | A base branch that moved after the branch was cut |
| PR checks (`pull_request`) | The merge ref: the branch merged into the current base | A base that moves after the run |
| Preview gate | Only a CI-green, non-draft PR gets a preview | Production |
| Deploy gate | The production build runs the type check and the tests, and fails closed | Nothing after the deploy |
| Main health | Whether the head of the main branch is green, and which merge broke it | Nothing before the merge |

### Why the merge ref matters

Two branches can each be valid while their merge is broken. Branch A renames a function. Branch B, cut before the rename, adds a new call to the old name. Each branch is green. The merge does not compile. Only a test of the merge result finds this.

### A green check goes stale

When the base branch moves after CI ran, the merge ref changes, but the workflow does not run again. Re-run CI before you merge a PR that has waited.

### Checks may not be required

On some plans (for example a private repository on a free plan) you cannot make a check required. Then every check is advice, and a red PR can be merged. A deploy gate is the only thing that stops a red tree from shipping.

## Diff scoping

Run each job only when its inputs changed, but never lose a check.

- A classifier job uses a paths filter and outputs one flag per area.
- A push to the main branch and a manual dispatch are never filtered. They run everything.
- A change under `.github/` runs everything.
- A chained job uses `if: ${{ !failure() && !cancelled() }}` so that a skipped parent does not skip it.
- A guard walks the real folders and fails on any path that matches no filter.
- An area must name every path that its jobs read, including generated inputs and wiki folders that a build copies.
- The workflow token needs `pull-requests: read` for the paths filter. Without it, every job skips silently.

## Test placement in CI

- Guards run on every PR, unfiltered.
- Unit and integration tests run in separate lanes through one lane script that the precheck also uses.
- A browser test never gates. A behaviour that must not regress needs a unit test.
- Zero tests collected must fail the job.
- A live test skips when its service is absent, except in the step that starts the service. That step sets the suite's "required" variable ([testing.md](testing.md#live-tests)).

## CI proves that each test ran

**CI finds tests by discovery, not by a list, and it proves that every known test executed.** A list of test files fails open: a new file that nobody adds to the list never runs, and CI stays green.

- Point each runner at a folder (a bare `pytest tests/`, a bare `jest`, `cargo test --test '*'`). Name a test only to select what a feature flag or a build condition limits to a few tests.
- Make a list of every known test from each runner's own listing mode (for example `--collect-only`, `--listTests`, `-- --list`). Name each listing, and fail when a required listing is absent or empty.
- After the test jobs finish, a coverage job reads the run's logs. It compares the tests that executed with all the known tests. A skipped, filtered or ignored test, or a test in a step that did not run, has not executed.
- A test that never runs in CI by design goes in an exceptions file, with a reason on each line.
- An exception that matches no test fails the check. A stale exception hides the next gap.
- Give the coverage script its own tests, with known-bad input that it must refuse.

A static check before push can approximate this from the source and the workflow files. It is faster, but the check of the run's own logs is the record.

## A local gate is not CI

A local precheck runs a subset of what CI runs. CI also runs jobs that need live services, other languages or a long time. Green locally is not green CI.

- After a push, read the CI result ([Reading a run](#reading-a-run)). Do not report "green" from the local gate.
- After a change to a shared contract (a key layout, a wire format, an encoding), search the whole workspace for other parsers of it. Another package can read the same format and have no test of the round trip ([verification-policy.md](verification-policy.md#shared-contracts)).

## Main health

A merge that breaks the main branch must produce a verdict.

- Do not cancel runs on the main branch. Use a condition:

  ```yaml
  concurrency:
    group: ci-${{ github.ref }}-${{ github.ref == 'refs/heads/main' && github.sha || '' }}
    cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
  ```

  A PR run can still be cancelled by a newer push, because the older run is obsolete.
- A script reads the newest finished run on the head commit of the main branch. A cancelled run carries no verdict. A run on an older commit carries no verdict for the head.
- The script traces a failure to the merge that caused it. Read the PR number from the merge subject. When the subject holds two numbers (the issue, then the PR), the PR is the last one.
- A red status that does not mean a failed build (for example a deploy bot that refuses commits by an author outside the team) is a separate field. A check that fires on healthy input is worse than no check.
- An agent loop checks main health at the start of each pass and repairs a red main first. Every PR built on a broken main gives results that mean nothing. The repair is a normal PR from the current main.

Test such a script against the live repository as well as fixtures. Fixtures hold only the shapes that you thought of.

## Cost

- Count the builds, not only their length. Volume is often the driver: several projects connected to one repository each build on every push.
- Drafts get no preview. Agents push many times per branch, and drafts are where most pushes land.
- A project that is not essential gets no PR previews, and its main-branch build is path-gated to its own inputs.
- Measure queue time as well as run time. Report the median and the 90th percentile. An unmeasured wait prints as `-`, never as `0s`.

## Preview gate

A preview builds only for a CI-green, non-draft PR.

- The hosting provider's git integration fires within seconds of a push, before CI has a verdict. It cannot be the thing that waits.
- The ignored-build step skips every automatic preview. A workflow that runs after CI completes creates the preview through the API and stamps it with a build variable. The ignored-build step builds only a stamped deployment.
- The Vercel ignored-build step has an inverted exit code: exit 0 skips the build, exit 1 builds. Both mistakes are silent. Pin the step with a test in both directions.
- `workflow_run` always runs the default branch's copy of the workflow, so a PR cannot test its trigger. Add a `workflow_dispatch` with a PR input, so that you can fire the real logic after the merge. The `workflows:` name must match the CI workflow's `name:` exactly, or it never fires.
- Verify the load-bearing assumption against a real deployment before you build the rest.

## Deploy gate

The production build re-runs the type check and the tests, and fails closed. See [deployment.md](deployment.md#a-build-that-fails-closed).

## Self-hosted runners

A self-hosted runner avoids a hosted-minutes limit, but it brings these lessons:

- **A label is the routing and the reservation.** A job that needs Docker must ask for a `docker` label, or it lands on a machine without a daemon. A label carried by exactly one runner serialises the jobs that need it. Keep that count at one: two reinstate the collision, zero queue the jobs for ever.
- **Every container name and host port is unique per run.** Put the run id and attempt in each container name. Let the kernel pick the host port (`-p 127.0.0.1::5432`), then read it back with `docker port`. Never search for a free port: search then bind is a race.
- **Runner availability and Docker health are separate.** An online runner does not prove that Docker responds. Check `docker info` succeeds. A restart of a shared daemon affects every runner on that host.
- **Tell infrastructure death from a regression.** When a database container dies mid-run, every database test fails with the same connection error. Classify the failure before the cleanup step removes the evidence. The classifier must err towards "real regression", never hide one behind a re-run banner.
- **Every job has a timeout,** set at about three times its slowest measured healthy run. Without one, a hung job holds a runner for hours.
- **A runner service has a minimal `PATH`.** Use setup actions rather than host tools.
- **`services:` containers are Linux-only.** On a macOS runner, start containers with explicit steps and remove them in an `if: always()` step.
- **The runner executes workflow code as a local user.** Never make such a repository public or accept fork PRs without a sandbox.
- **CI and production can run different operating systems.** A shell script that assumes BSD or GNU flags breaks on one of them.

## A PR with no run

A PR whose merge state is `CONFLICTING` has no merge ref, so it gets no `pull_request` run at all. Check `gh pr view --json mergeable,mergeStateStatus` first. Merge the base branch to resolve it.

## Reading a run

- `gh pr checks <pr>` for the state of each check.
- `gh run view <run-id> --log-failed` for the failed steps only.
- Wait with one blocking helper ([core belief 3](core-beliefs.md#3-wait-without-polling)). A detected change does not prove that CI passed.
- Neither restored infrastructure nor an accepted retry proves that CI passed. Read the final result.
