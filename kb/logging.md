# Logging

[kb](README.md) › logging

**Each log level answers one question about the reader. A healthy run logs more DEBUG than INFO, and more INFO than WARNING.** If the count inverts, a quiet log carries no information.

## The ladder

| Level | Use it for | The test |
|---|---|---|
| ERROR | The operation failed and nothing recovered it. | Somebody must act. |
| WARNING | Something was wrong and the run carried on. | The result is usable, and the reason it is degraded must be visible. |
| INFO | Every stage boundary and every skip. | A person who watches a live run needs this line. |
| DEBUG | Finding a fault once you know there is one. | Nobody needs it on a healthy run. |

Handler levels are in [failure-handling.md](failure-handling.md#the-level-a-handler-uses).

## Write rules

- Use a named logger per module (`logging.getLogger(__name__)` in Python).
- Use the logger's placeholders (`logger.info("loaded %d rows from %s", n, path)`), not f-strings. The logger then formats only the lines that it emits.
- Name the subject and a number: "skipped 3 of 120 rows in orders.csv: missing id", not "some rows skipped".
- Name the consequence: what did not happen.
- Never log a secret, a token or personal data. Test the redaction with negative cases.
- A loop that runs for a long time reports progress on a terminal.

## Structure

- A JSON formatter carries the run id and other context fields, so that you can filter one run.
- On a crash, write the traceback with the local variables to a temporary file in mode `0600`, and print its path on the last console line. The console stays short, and the detail stays on disk.

## The logging guard

- A module over a size threshold (for example 150 lines) must log. A frozen baseline lists the modules that do not yet log. The baseline may only shrink.
- A second test fails when a baseline entry starts to log, so that the baseline does not keep stale entries.
- The scan roots come from globs. The scan raises on an empty match. See [guards.md](guards.md#a-guard-reads-the-tree-as-it-was-written).

## Retrofit order

Add logging to an existing codebase in this order:

1. Boundaries (input read, output written, external calls) and every skip.
2. One area per PR after that.
