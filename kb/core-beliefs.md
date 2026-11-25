# Core beliefs

These rules apply in every repository that adopts this plugin. You must not break them. Each rule has its reason and how to apply it. A project can add rules. A project must not remove one of these.

## 1. Fail fast, and record every failure

**Rule.** Stop at the first bad state. Use no fallback, no default and no silent skip unless the specification names that recovery.

**Why.** A silent fallback turns a defect into a wrong result that looks correct. Nobody looks for a failure that nobody can see.

**Apply it.**

- A refusal names the failed identifier, the useful detail (exit code, the command's own output) and the repair command. It exits non-zero.
- Never return a partial result that reads as success. A check that did not run is not a check that passed.
- Every `except` or `catch` records the failure or lets it raise.
- Recovery from a failure is a design choice. The user verifies it.

Detail: [failure-handling.md](failure-handling.md), [logging.md](logging.md).

## 2. Test first, and prove guards in both directions

**Rule.** Write the test. Watch it fail for the intended reason. Write the smallest code that makes it pass. Run it again. Commit.

**Why.** A test that you never saw fail has never proved anything. An import error, a `NameError` or a collection error is not a failure for the intended reason.

**Apply it.**

- Test through a public interface. Mock only external boundaries.
- For a guard, prove both directions: it fails with the defect, and it passes without it.
- Keep the regression test as the permanent guard.

Detail: [testing.md](testing.md), [guards.md](guards.md).

## 3. Wait without polling

**Rule.** Never poll a process, a check or a deployment by hand. Run one blocking wait helper in the foreground, then read its result.

**Why.** Manual polling costs tokens on every loop and invites a guess about the result. A blocking helper costs one call.

**Apply it.**

- For a local process: [`wait-for-process-end.sh <pid>`](hooks/wait-for-process-end.sh), then read the log.
- For a PR: a helper that blocks until the checks change state, for example `gh pr checks <pr> --watch`.
- A process that ends has not proved success. Read the exit status and the final log.
- A state change is not a pass. Confirm the commit the result is for.

## 4. Pull and pass the guards before a push. Never use `--no-verify`

**Rule.** Pull the base branch, then push through the pre-push hook. The hook runs every check that the CI guards job runs.

**Why.** CI on a pull request tests the merge result. A local push that skips the guards sends work to CI that the developer can find in seconds. A skipped hook teaches the next person that the gate is optional.

**Apply it.**

- Use [`push-checked.sh`](hooks/push-checked.sh): it pulls the base branch, then pushes.
- The hook needs a clean, committed worktree, and the base branch must be an ancestor of `HEAD`.
- A missing tool blocks the push. It never passes it.
- Never use `--no-verify`, a hooks-path override or a skip flag.

Detail: [precheck-and-push.md](precheck-and-push.md).

## 5. Never silence a rule

**Rule.** Fix the code, or add a narrow inline ignore with the reason on the same line.

**Why.** A whole-rule suppression or a wider config hides every future instance. An inline ignore hides only the case that you looked at, and it carries the reason for the next reader.

**Apply it.**

- Never widen a config, lower a level or add a file to an exclude list to get a green check.
- A suppression without a reason is a defect. A guard can refuse it.
- Never autofix a rule that deletes code you have not read (for example an unused-import autofix on re-export modules).

## 6. Make a repeated script permanent

**Rule.** The second time that you write a script, put it in the repository's `scripts/` folder with a test.

**Why.** A scratchpad script has no test and no reviewer. The third copy differs from the first, and nobody knows which one is correct.

**Apply it.**

- A skill's helper goes in `scripts/<skill>/`.
- A skill holds instructions only, so that every harness (Claude, Codex) shares one copy of the code.
- A one-off investigation script can stay in the scratchpad. A script that you run twice cannot.

## 7. Never spend the subscription through `claude -p` without permission

**Rule.** Do not start a non-interactive `claude -p` run, or anything that wraps one, unless the user gave permission for that run.

**Why.** Each headless run uses the user's paid quota. A loop of them can use a week of quota in an hour, and nobody sees it until the limit stops work.

**Apply it.**

- Put the call behind a gate that refuses unless an environment variable is set. Only the user sets that variable.
- Ask first. Say what will run, how many times, and why.
- The hook [`warn-subscription-cli.sh`](hooks/warn-subscription-cli.sh) warns when a command touches the gate variable.

## 8. Never overclaim

**Rule.** Say exactly what you ran, what passed, what failed, what you skipped and what you did not run.

**Why.** An overclaim moves the cost of a defect to the person who trusts the report. A correct small claim is worth more than a large wrong one.

**Apply it.**

- A number carries its scope: "62 of 391 files", not "most files".
- Report passed, failed, skipped (with the reason) and not run as separate states, in a comment on the PR. With no PR, put them in the commit message.
- A speed number needs the run count and the noise floor.
- A rate claim needs a rate: "19 of 20 runs", not "it works now".
- When you find that an earlier claim was wrong, correct it where you made it.

## 9. Work only in a worktree, with a PR, one PR per unit of work

**Rule.** Never commit to the main branch. Each unit of work has its own worktree, its own branch and one PR. A human merges.

**Why.** A worktree isolates the work from other agents. One PR per unit keeps the review small and the revert clean.

**Apply it.**

- A related find becomes a sub-issue. Fix it on the same PR only when it is in the same unit of work.
- A dependency is a commit order on one branch, not a second PR.
- Open the PR as a draft while work remains.
- Never delete another worktree, unpushed work or unknown files to make a task pass.

Detail: [git-and-worktrees.md](git-and-worktrees.md), [issue-tracking.md](issue-tracking.md).

## 10. Write in Simple English

**Rule.** Write every document, comment, issue, PR body and message to the user in ASD-STE100 Simple English, with British spelling.

**Why.** Many readers are not native speakers, and many readers are agents. A short, literal sentence has one meaning.

**Apply it.**

- Put the answer first.
- One idea per sentence. "Must", not "should". No contractions. No coined jargon.
- Refer to an issue or PR by bare number (#1000), not by its title.
- Run the readability check before you post.

Detail: [writing.md](writing.md).

## 11. Forget history

**Rule.** Documents and code describe the present state. Git holds the past.

**Why.** A page that tells its own history makes the reader work out which part is still true. An old statement next to a new one is a contradiction.

**Apply it.**

- When a fact stops being true, remove it or replace it. Do not add "previously" or "was changed on".
- A comment never records what the code used to do.
- Use the `forget` skill to remove a fact from every place that holds it.
