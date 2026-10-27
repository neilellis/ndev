# Comments

[kb](README.md) › comments

**The default is no comment.** Names and structure carry the meaning. A comment earns its place only when the code cannot say it.

## A comment earns its place when it says

- **Why the code exists,** when the reason is not visible in the code. For example: "The API returns 200 with an error body, so we check the body."
- **A trap in the system around the code.** For example: "The runner has a minimal PATH, so we call the absolute binary."
- **A measured number that a constant depends on.** For example: "3 times the slowest healthy run, measured on a loaded machine."

## A comment never holds

- Commentary that repeats the code ("increment the counter").
- History ("previously this used X", "changed in March"). Git holds the history ([core belief 11](core-beliefs.md#11-forget-history)).
- A to-do with no issue number.
- A suppressed-rule reason on a different line from the suppression.

A bare issue number is fine: `# #1234: the vendor returns duplicate rows.`

## The deletion test

Delete the comment. If a competent reader loses nothing, the comment did not earn its place. If the reader would make a mistake, keep it.

## Style

Write comments in [Simple English](writing.md), in the present tense.
