# Writing for humans: the detail behind F2b and F2c

Read this when you write a plan, issue, PR, comment, wiki page or product documentation. The goal is
clear, useful text.

## Practical standard

Start with the problem, decision or requested action. Explain the change and its effect. Include the
evidence and scope that affect the decision. Define project terms on first use, link issue numbers,
and say exactly what you verified. Keep the text short enough to scan.

Issues, PRs, plans and comments need no fixed opening, no mandatory Vale pass and no cold-reader
step. Read the draft once and correct unclear or unsupported claims. Keep the required workflow
fields, such as `Test entry point:` and closing issue references.

Product documentation and interface copy keep the stricter standard of the `docs` and `copy` skills.
Run the relevant prose checks for changed product docs or copy (see [F2c](prose.md#f2c--the-readability-gate)
for `.mdx`). Do not change wording only to clear a warning when the result is less clear.

## The cold reader

A cold reader is optional for plans, issues, PRs and comments. Use one for new or much-rewritten
product documentation, to check that the intended reader can understand and follow it.

## The ratchet

If the same documentation or copy problem gets past the checks again, improve the guidance or the
lint rule through the normal review workflow.
