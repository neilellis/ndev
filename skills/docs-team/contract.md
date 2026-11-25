# Writer contract

Every agent that writes a page reads this whole file first. A page that breaks it gets rewritten.

## 0. Project facts (the coordinator fills this in)

Copy this file into the work folder and replace each `{{…}}` value from the project's instructions (`CLAUDE.md`, `AGENTS.md`) and internal docs. Delete a line that does not apply. Never guess a value; ask the user.

- **Site:** `{{docs project path}}`, built with `{{site generator}}`. Pages live in `{{content folder}}`.
- **Readers, in priority order:** `{{for example: the customer's own team, integrators, engineers}}`.
- **Names:** `{{the product name, the company name, framework names, and how each is written}}`.
- **Terms to expand on first use on every page:** `{{acronyms}}`.
- **Boundary:** `{{what the product does and never does, and words that must not appear as a verdict}}`.
- **Status:** `{{what is shipped, built or planned; whether dates may appear}}`.
- **Demonstration data:** `{{fictional organisations or simulated data, and how to label them}}`.
- **Copy rules:** `{{the project's writing rules and Vale settings, or "use the copy skill"}}`.
- **Page components:** `{{the site's callout, screenshot and diagram components, and any import rules}}`.
- **Tests:** `{{the command that checks sources exist and tripwire words}}`.

## 1. Who reads these pages

Write for the readers in §0, in that order. Write for someone intelligent who has not read the internal docs. Explain before you name. Expand each term in §0 on first use on every page.

## 2. Truth rules

- **The code is canon.** Every factual claim about behaviour must come from a file you opened: a command, a port, a flag, a table, an endpoint, an environment variable, a default. Where a doc (wiki, manual, guide) disagrees with the code, the code wins. Record the disagreement in your ledger.
- **Never invent.** If you cannot find something in the code, leave it out of the page and list it under *Gaps* in your ledger. No placeholder text, no "TBD", no guessed flags.
- **Naming.** Use the names in §0 exactly as written there.
- **Boundary.** Describe only what the product does, as §0 says. Never use a verdict word that §0 forbids.
- **Measure, not forecast.** Never write "predict", "forecast" or "guaranteed" unless the code does that. Label scenarios as illustrative.
- **Status.** Never claim more than §0 allows. Avoid dates and ship claims unless the code or the manual states them.
- **Demonstration data.** Label fictional and simulated data wherever it appears.

## 3. Voice

Follow the copy rules in §0. Use the documentation register for user pages and the technical documentation register for developer pages. If the project names no rules, use the `copy` skill and ASD-STE100 Simple English.

- **Spelling and case.** The project's spelling variety (British English unless it says otherwise). Sentence case for every heading.
- **Tone.** No hype, no exclamation marks, no emoji. Short declarative sentences.
- **Dates.** Written like "12 October 2026".
- **Lists.** Prefer prose. Use lists for steps and real enumerations.
- **Headings.** Name the task or topic.

## 4. Page shape

Write each page in the site's format, in `{{content folder}}/<section>/.../<slug>` (kebab-case). Give every new folder the site's navigation file. Give each page front matter with a `title`, a one-sentence `description`, and the source paths it reflects, if the site keeps them (for example `source:` for code paths and `wiki:` for internal docs).

Body order for an **architecture or module page**:

1. An eyebrow or breadcrumb, then the H1 naming the topic.
2. **What it is for:** two to four sentences in product terms (which user-visible behaviour depends on it).
3. **How it works:** the mechanism, from reading the code. Name the real functions, classes, tables and keys in `code`.
4. **Interfaces:** what calls in and what it calls out to. Use a table for endpoints, CLI commands, environment variables or tables when there are several.
5. **Invariants and failure behaviour:** what it refuses, what it guarantees, and what happens on restart or error.
6. **Diagram:** if one would help, request it (§6). Do not draw ASCII or Mermaid.
7. End with the next useful task or explanation.

**User and operator pages** follow task order: what you will achieve, before you start, steps, what you will see, and when something goes wrong. Screenshots go where they help.

Link between pages with root-absolute paths without an extension, for example `[the read model](/architecture/read-model)`.

## 5. Components

Use only the components §0 names. For MDX sites:

- Escape a bare `<` or `{` in prose as `&lt;` and `&#123;`, or put it in backticks.
- Write `className`, not `class`.
- HTML comments do not work; use `{/* … */}`.

## 6. Diagrams: request them, do not draw them

Add a row to your ledger under **Diagram requests**:

```
- kind: archify-architecture | archify-workflow | archify-sequence | archify-dataflow | archify-lifecycle | dd-<type>
  slug: <area>/<name>
  page: <the page path>
  shows: one paragraph: components, flows and labels, precisely, from the code
  sources: [paths you read]
```

- **archify** is for system pictures that reward exploration: deployed units, request sequences, data pipelines, state machines.
- **diagram-design** (`dd-…`: architecture, flowchart, sequence, state, er, layers, swimlane, tree, timeline and others) is for an inline explanatory figure.
- Put the embed tag in your page now, with the agreed path. The diagram pass fills it in.

## 7. The ledger

`ledger/<unit-id>.md` in the work folder, owned by the lead and appended to by its writers. It has four headings:

- **Pages:** each path with a one-line summary.
- **Diagram requests.**
- **Gaps:** things a reader needs that the code or docs could not settle.
- **Doc ↔ code disagreements:** the doc path, the code path, what differs, and which one the page followed (the code).

## 8. Legibility

Follow the `docs-legibility` skill after every page change. Remove unnecessary jargon. Keep a technical term only with a reader-facing reason and a clear definition, in the site's glossary if it has one. Expand acronyms in nearby prose. An independent agent must review the whole changed page.

## 9. Done means

- The site's tests (§0) pass for your pages: sources exist, and no tripwire words.
- Every file you were assigned is covered by at least one page, or listed under *Gaps* with the reason.
- You touched only your own `content_dir` and your own ledger file.
