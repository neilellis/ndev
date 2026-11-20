---
name: ast-grep
description: "Search the codebase by parsed code shape. Use for call sites, imports, definitions, component props and refactor impact. Use text search for prose and literal values."
---

# Structural code search

Use the ast-grep CLI that the project pins (for example `pnpm exec ast-grep`). If the project pins none, use an installed `ast-grep`. Do not run a bare `sg`: on many machines that name is a different program.

Use ast-grep directly to explore. Use `scripts/find.sh` in this skill's folder for a result that you will report:

```bash
ast-grep run -p '<pattern>' [paths]          # exploration
scripts/find.sh '<pattern>' [flags] [paths]  # a result that becomes a claim
```

`find.sh` uses `AST_GREP_BIN` when it is set. Else it uses `pnpm exec ast-grep` or `ast-grep` on `PATH`.

## Patterns

A pattern must be complete syntax. `$X` is one node, `$_` is one unbound node and `$$$` is zero or more nodes.

| Need | Pattern |
|---|---|
| bare call | `foo($$$)` |
| qualified call | `$_.foo($$$)` |
| annotated Python definition | `def foo($$$) -> $R: $$$` |
| Python import | `from $PKG.$MOD import $$$` |
| exported TS function | `export function $N($$$) { $$$ }` |
| JSX component | `<Link $$$>$$$</Link>` |

- Omit `-l` unless you must restrict the language. Without it, `.tsx` files are included.
- Give a bare-name pattern a language or a syntactic context. Else Markdown can give false matches.
- To find all calls, run both the bare and the qualified call pattern.
- An annotated Python definition needs `-> $R`.

## Do not trust the exit status alone

ast-grep is fail-open in three ways, and each one prints an empty result:

1. A pattern that does not parse exits 0 with no output.
2. A path that does not exist exits 1, the same as a real no-match.
3. A language or path filter that opens no file exits 1.

`find.sh` reads `--inspect summary` and the parse warning. It exits 0 for matches, 1 for no match over N inspected files, and 2 when the search did not run. Exit 2 is never "nothing uses it". Read its stderr. Use `--debug-query=pattern` when a pattern surprises you.

## When to use text search

Use `rg` for prose, comments, strings, JSON/YAML/TOML values, file names, and a first text sweep. ast-grep has no type information. It cannot answer cross-file type questions.

## Rewrites

Preview first, then apply with `-U`. Then run the affected type checker and tests.

```bash
ast-grep run -p 'foo($A)' -r 'bar($A)' <paths>
ast-grep run -p 'foo($A)' -r 'bar($A)' -U <paths>
```

## Guards

An architectural guard written as an ast-grep rule needs a bad fixture that the rule matches and a good fixture that it passes. Prove it both ways: break the code and see the rule fail, then restore it. Read the project's CLAUDE.md for where its rules and rule tests live.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
