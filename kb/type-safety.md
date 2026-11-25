# Type safety

[kb](README.md) › type-safety

**A type error is the cheapest bug that you will find. Every rule blocks, and every rule is at zero.** A rule gets to zero because the code is fixed, never because the bar moves.

## One command

One script runs every type checker and linter for the repository, in the same way locally and in CI. The precheck and the pre-push hook call that script. There is no second copy of the path list.

- Keep the checker's include list and the script's path list in step, and add a test that fails when they differ.
- A package `tsconfig.json` must list its tests folder in `include`. Otherwise the tests are never type-checked, and `next build` (or a similar build) does not check them either.

## Every rule at zero

- With zero findings, any finding is something your change introduced.
- No rule is at `warning`. A warning that nothing enforces grows.
- A red check is not fixed by an edit to the checker config. Never widen a config to get green ([core belief 5](core-beliefs.md#5-never-silence-a-rule)).
- A suppression is inline, narrow and carries its reason on the same line: `# pyright: ignore[rule] — reason`, `# noqa: RULE — reason`.
- A file-level directive in some checkers takes no trailing comment. Put the reason on the line above, or the directive is silently ignored.

## Where the untyped values come from

In a large backlog, three roots produce most findings:

1. A parameter with no type. Everything derived from it is unknown.
2. A bare `dict` or `list` annotation, which means unknown keys and values.
3. A value read from JSON. `json.loads` returns `Any`, and one unchecked payload untypes a whole module.

### Reading JSON without losing the types

Put a small typed boundary module between JSON and the code:

- `json_obj(value)` returns a typed mapping, or an empty one when the shape is wrong. Use it where a wrong shape reads as absent.
- `is_json_obj(value)` is a type guard that narrows in both branches. Use it where a wrong shape must be logged or must stop a loop.
- Where a wrong shape is an operator error, raise at the call site.

## Magic values

A magic-number rule catches numbers only. Name the constant with its unit. Tests can be exempt per file, which is not the same as a global ignore.

## Escape hatches

- Make `Any` an error where the checker allows it.
- A library with no type stubs gets a stub package, not an exemption.
- Mark an optional dependency at its import, not by a rule exemption.
- Every package ships its typed marker (for example `py.typed`), or cross-package imports read as untyped.

## Traps

- **Never run an unused-import autofix on modules that exist only to re-export.** The imports are the public surface. Declare `__all__` in every re-export module before you turn the rule on.
- **Git merges an `__all__` list by taking both sides.** A name that one branch removed comes back, with no conflict. A checker rule for unsupported `__all__` entries catches it. Run the type check after any merge that touches a re-export module.
- **A scripted audit is not a test suite.** Trust the suite, not a grep over the diff.
- **`from __future__ import annotations` above a module docstring destroys the docstring.**
- **The type checker needs the project's virtual environment.** Run it through the project's runner.
