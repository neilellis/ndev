---
name: testing
description: "Apply the testing taxonomy and verification rules across Python and TypeScript, including guard integrity and minimal live-system tests."
---

# Testing discipline

Choose the tier that can observe the changed behaviour, and keep the test at that boundary. The plugin's `kb/testing.md` and `kb/guards.md` hold the full method.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## The workflow

The check scripts in `scripts/ndev/workflow/` run these tests when the workflow commits, pushes or marks a PR ready. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

| Tier | Use |
|---|---|
| Unit | Deterministic pure logic. No network, database, file storage, object store, LLM, heavy model, browser or external process. |
| Integration | One intentional boundary: database or ORM, storage adapter, migration, realtime subscription, service contract. |
| End-to-end | A minimal user path or assembled pipeline against a live deployment or system. |

- Test through one meaningful public entry point, not private helpers.
- Keep unit tests fast enough for the project's speed gate.
- An integration test cleans up its resources and uses the smallest realistic fixture.
- Add an end-to-end test only when a lower tier cannot observe the contract.
- Mock only external boundaries.
- A test never depends on time or machine load. Never assert how long something took (`performance.now()` or `Date.now()` minus a start), and never race a short timer. Prove the result, count the steps, or use a fake clock. A suite guard that scans the test files for elapsed-time checks keeps it so.

## Test first

1. Write a test at the chosen entry point.
2. Watch it fail for the intended reason. An import error is not proof.
3. Make the smallest change that passes it.
4. Run the focused test, the type checker and linter, then the relevant broader suite.

Read the project's CLAUDE.md for its commands. Usual shapes are `pytest -q <test>`, `pnpm exec vitest run <test>` and the project's type-check and end-to-end scripts.

## Guards

An architectural invariant belongs in a guard, not in a behaviour test. A guard must:

- match the forbidden shape,
- fail on a bad fixture,
- pass on a good fixture.

Prove a guard both ways: break the implementation or the fixture, watch the guard fail, then restore it. A guard that never failed is not yet a guard. Use `ast-grep` for structural rules.

## Never weaken a test

Never weaken, skip or delete a test to make a suite pass. Never lose an exit status through a pipe. Keep credentials out of tests and logs. Record an unrelated baseline failure, check it against the base branch, and do not count it as a pass.
