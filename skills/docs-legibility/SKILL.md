---
name: docs-legibility
description: "Check and fix user-facing docs pages so a new reader understands them: plain English, short sentences, no unnecessary jargon, each necessary technical term explained once. Use when writing or changing docs-site pages, captions or glossary terms, or when a docs legibility check fails."
---

# docs-legibility: plain English for docs pages

Before you write or review documentation, read the project's writing rules and its legibility standard if `CLAUDE.md` or `AGENTS.md` names them. They take precedence over this skill.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## The standard

Write for a capable reader who is new to the project.

- Keep a sentence to 25 words or fewer. Use one idea per sentence. Split a longer sentence when that makes it clearer. Do not split a list or a command that must stay whole.
- Use common words. Replace management and team jargon ("leverage", "utilise", "holistic", "seamless", "deep dive", "going forward") with a plain word.
- Keep a technical term only when the reader needs it to use the product, for example a command name, a setting or a status. Explain it in plain words where it first appears, or link it to the glossary.
- Give one meaning to one word. Do not use two names for one thing.
- Put the condition before the instruction: "If the build fails, run X."
- Use the active voice and the present tense for facts.
- Keep code, paths, flags and identifiers in inline code. Do not explain them in prose that a reader must parse.
- Captions, alt text and labels follow the same rules.

## Branding

If `<project root>/.neil-dev.json` has a `branding` key with a `guide`, read that guide's writing rules too. Where they conflict with the standard above, the project rules win. Find the root with `git rev-parse --show-toplevel`. Otherwise skip this section.

## Precheck

If the project has its own legibility check (a docs test or a lint script), run it. If not, use `scripts/precheck.py` in this skill's folder. It needs only Python 3.9.

```bash
python3 <skill>/scripts/precheck.py PAGE ...
python3 <skill>/scripts/precheck.py --content <docs-content-dir> --base origin/main   # changed pages only
python3 <skill>/scripts/precheck.py --glossary <glossary.json> PAGE ...               # optional glossary rules
```

It reads titles, descriptions, headings, paragraphs, list items, table cells and the `alt`, `caption`, `title`, `label` and `note` attributes. It skips code blocks, imports, exports and JSX expressions.

- **Error** (exit 1): unnecessary jargon, or a glossary entry that breaks a rule. Fix it.
- **Warning**: a sentence over the limit. Read it in context. Split it if that makes it clearer.
- **Exit 2**: the check could not run, for example front matter that does not close. Fix the input. This is not a pass.

A glossary entry needs a unique kebab-case `id`, a `term`, a list of `match` phrases that no other entry uses, a `reason` that says why readers need the term, and a one-sentence plain `definition` that passes the same checks.

A pass does not prove that a page is legible. The precheck finds only the mechanical faults.

## Steps

1. **Find the pages.** Use the pages you changed, or the list from `--content`. For a full audit, pass every page.
2. **Run the precheck.** Fix every error. Decide on each warning.
3. **Read each page as a new reader.** For each section, ask: can a reader who is new to the project say what it does, when to use it and what to do next? Find undefined terms, steps in the wrong order, missing conditions and claims the page does not support.
4. **Get an independent read** for a new page or a large rewrite. Give a fresh reviewer only the page and the standard above, not your reasoning. The `clean-reader` skill does this in a confined process with no access to the repository. Treat its findings as evidence: check each one against the page, then fix it or record why not.
5. **Keep the facts.** A legibility edit must not change what the page claims. If a fact looks wrong, check it against the code (see the `docs-sync` skill). Do not guess.
6. **Run the precheck again** and the project's docs build or tests. Report errors fixed, warnings kept with the reason, and reviewer findings accepted or rejected.
