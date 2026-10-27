# Prose for humans (F2b, F2c)

This reference covers text for plans, issues, PRs, comments, wiki pages and product documentation.
`writing.md` has the detail.

## F2b — Writing for humans

Write for a reader with little context and little time. Give the problem or decision first, then the
change, the evidence, and what you need from the reader. Use short, direct sentences. Define a project
term when it first appears. Keep a technical name when it helps the reader find or verify the change.
Do not use coined jargon, unexplained abbreviations, or claims that go past the checks you ran.

For plans, issues, PRs and comments, a short structure is sufficient: what is wrong, what changes,
what action is necessary, and how it was or will be verified. Keep the required `Seam:`,
`Test entry point:` and `Closes #<n>` lines.

Product documentation and interface copy follow the stricter `docs` and `copy` skills, which include
the project's voice and accessibility rules. Use the spelling convention the project's `CLAUDE.md`
names.

## F2c — The readability gate

Issues, PRs, plans and comments do not need a mandatory linter or cold-reader loop. Read the text once
before you post it, and correct anything unclear, unsupported or without the requested action.

For changed product documentation and interface copy, run `${CLAUDE_PLUGIN_ROOT}/scripts/docs/readability.sh` (it
runs Vale with the house style). Use an independent reader for new or much-rewritten product
documentation. Vale skips `.mdx` silently: copy the page to a `.md` file in a temporary directory and
check that copy.

When a document must keep a quotation or code-specific wording, use a named, narrow Vale suppression
with a reason, and turn the rule on again after it. Resolve warnings in context. Do not force an
awkward rewrite to clear a warning.
