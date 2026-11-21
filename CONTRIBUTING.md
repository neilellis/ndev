# Contributing to ndev

This repository is a Claude Code plugin: the shared development methodology. Read `README.md` first.

- Text here is project-neutral. A fact about one project goes in that project's wiki, not here.
- A helper that two or more skills, agents or hooks use goes in `scripts/<area>/`, with its tests in
  `scripts/<area>/tests/`, and gets one line in `scripts/README.md`. Docs call it as
  `${CLAUDE_PLUGIN_ROOT}/scripts/<area>/<name>`. Never copy a shared script into a skill.
- A helper that only one skill uses stays in `skills/<name>/scripts/`. Check each script with `bash -n`,
  `python3 -m py_compile` or `node --check` after a change.
- Prose follows ASD-STE100 (`simple-english`): British spelling, answer first, present tense only.
- Bump `version` in `.claude-plugin/plugin.json` for each change, and run `claude plugin validate .`.

## Tests

Run `npm test` for the native CLI and installer tests. Run `claude plugin test .` for the retained SDK suite.

SDK integration tests import `expect` and `test` from `./sdk-testing`. Async callbacks have a default execution allowance of 30 seconds, including fixture setup and calls to the SDK. A test can set `timeoutMs` explicitly. The adapter preserves that value. Synchronous callbacks keep the SDK's default, including in files that also have integration tests.

The SDK compiler follows `$` calls only into named top-level helpers or functions imported from the plugin. Resolve context through those helpers and pass the resulting data to shared handlers. A registry of callbacks that receive `$` prevents the hooks module from loading.


This execution allowance differs from the workflow's time limits. Keep assertions about the simulated clock, process timeouts, the hook's own budget and workflow restoration. A longer runner deadline does not change those contracts. The forced low-budget tests retain their explicit deadlines and refusal assertions.

Tests of the hook budget call the real registered tool handler through `tests/workflow-host.ts`. The host fixture supplies state, files, process results and the remaining hook budget. The simulated clock and budget move independently. Controls cover the exact threshold, refusal before the first check, interruption inside a pause and workflow restoration.
