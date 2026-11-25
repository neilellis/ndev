# Failure handling

[kb](README.md) › failure-handling

**A failure stops the work, and every failure leaves a record.** This page is the contract that [core belief 1](core-beliefs.md#1-fail-fast-and-record-every-failure) points to.

## The four rules

1. **A failure stops processing.** The code does not carry on with a value it knows is wrong.
2. **An unexpected state fails the run.** "This cannot happen" is an assertion, not a comment.
3. **Recovery is a design choice that the user verifies.** A retry, a default or a skip exists only when the specification names it.
4. **Every failure is logged, including a recovered one.** A specified skip is logged with its reason and the identifier, and the run summary counts it.

## A handler has three legal outcomes

A `catch` or `except` block must do one of these:

| Outcome | What it does |
|---|---|
| Record | Log the failure at the correct level, with the identifier and the consequence. |
| Re-raise | Let the failure go to a caller that can handle it. |
| Return it as a value | Return a typed error or result that the caller must inspect. |

A handler that does none of these is a silent failure. It is a defect even when the tests pass.

## The level a handler uses

| The handler | Level |
|---|---|
| caught something unexpected | ERROR |
| caught something recoverable that the specification allows | WARNING |
| let an expected exception pass as control flow (for example "not found" in a lookup) | INFO |
| re-raised with no other work | no log line |

A caught exception is never logged below WARNING unless it is control flow. The full ladder is in [logging.md](logging.md).

## What a failure message contains

- The identifier that failed (the file, the row id, the PR number).
- The useful detail: the exit code, the command's own output, the value that was wrong.
- The consequence: what did not happen because of the failure.
- The repair command, when a known repair exists. The next person must not have to dig.

"X failed" alone is not a failure message.

## Exit codes for scripts and checks

| Code | Meaning |
|---|---|
| 0 | Every check ran and passed. |
| 1 | A check ran and found a defect. |
| 2 | A check could not run or could not measure. The message names the fix. |

Code 2 is never a pass. A missing tool is code 2, not code 0.

## Partial results

- Never return a partial result that reads as success. An empty list reads as "nothing to do".
- Count what you skip. Name the first few skipped identifiers. Put the count in the run summary.
- A check that did not run is not a check that passed. Say that it did not run.

## Failures and work already done

- A failure does not undo work that a caller already committed. Know what was committed before the failure.
- Investigate before a retry. A retry that hides the cause turns a defect into an intermittent defect.

## In a web app

An error goes to the console with its detail, and the user sees a flag that something failed. A blank panel is a silent failure.

## Enforcement

- Use a structural rule (for example the ast-grep rules `no-silent-except` and `no-silent-catch`) to refuse an empty or log-free handler. See [guards.md](guards.md).
- A suppression carries its reason on the same line: `# ast-grep-ignore: <rule> — <reason>`. The guard refuses a bare ignore.
- Pipes lose exit statuses. Use `set -o pipefail` in shell, and check that `tee` or `grep` in a pipe does not replace the status that matters.
