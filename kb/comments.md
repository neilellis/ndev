# Comments

[kb](README.md) › comments

**Do not write comments in code.** In 99 changes out of 100, the right number of new comments is zero. Names, structure and tests carry the meaning. The PR, the issue and git hold the reasoning and the history.

## The one exception

Write a comment only for a fact that took a lot of research or trial and error to find, and that the next editor would otherwise have to find again. For example:

- A vendor behaviour that no document states, found by experiment: "The API returns 200 with an error body, so we check the body."
- A trap that took a long debug to find: "The runner has a minimal PATH, so we call the absolute binary."
- A number found by measurement: "3 times the slowest healthy run, measured on a loaded machine."

Write it in one sentence. Add the issue number if there is one: `# #1234: the vendor returns duplicate rows.`

If you are not sure that a comment meets this bar, do not write it.

## A comment never holds

- Commentary that repeats the code ("increment the counter").
- The reasoning for a choice, rejected alternatives, or arguments for the design. Those go in the PR, the issue or the wiki.
- History ("previously this used X", "changed in March"). Git holds the history ([core belief 11](core-beliefs.md#11-forget-history)).
- A to-do with no issue number.
- A section banner or a label for a block of code. Extract a well-named function instead.
- A suppressed-rule reason on a different line from the suppression.

The same rule applies to docstrings. Write one only when the project requires it, for example for a published API.

## The deletion test

Delete the comment. If a competent reader loses nothing, the comment did not earn its place. Keep it only when the fact cost real research to find and the reader would make a mistake without it.

In the lines you change, delete the comments that fail this test. Do not rewrite comments in code you do not otherwise touch.

## Style

Write comments in [Simple English](writing.md), in the present tense.
