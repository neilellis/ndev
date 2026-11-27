# Contributing to ndev

This repository holds the ndev CLI, installer, skills, scripts, and retained Claude Code plugin assets. Read `README.md` first.

- Text here is project-neutral. A fact about one project goes in that project's wiki, not here.
- A helper that two or more skills, agents or hooks use goes in `scripts/<area>/`, with its tests in
  `scripts/<area>/tests/`, and gets one line in `scripts/README.md`. Docs call it as
  `${CLAUDE_PLUGIN_ROOT}/scripts/<area>/<name>`. Never copy a shared script into a skill.
- A helper that only one skill uses stays in `skills/<name>/scripts/`. Check each script with `bash -n`,
  `python3 -m py_compile` or `node --check` after a change.
- Prose follows ASD-STE100 (`simple-english`): British spelling, answer first, present tense only.
- Bump `version` in `.claude-plugin/plugin.json` with each change to retained plugin assets, and run `claude plugin validate .`.

## Tests

Run `npm test` for the native CLI and installer tests. It runs every `*.test.mjs` file that git tracks, except the files in `scripts/test/exceptions.json`. Each exception gives the reason and the command that runs it. A new test file runs when you `git add` it.

The retained SDK suite is every tracked `*.test.ts` and `*.test.tsx` file. The `sdk` job of `.github/workflows/ndev.yml` runs it with `node scripts/test/sdk.mjs`. The runtime is the `claude` binary, which runs `claude plugin test .` without a model call or a login. `scripts/test/sdk-runtime.json` pins its npm package and version. To run the suite here:

```
npm install --prefix <folder> @anthropic-ai/claude-code@<version in sdk-runtime.json>
NDEV_SDK_CLAUDE=<folder>/node_modules/.bin/claude node scripts/test/sdk.mjs
```

The runner fails on a missing runtime, a runtime of another version, a failing test, a skipped test, a tracked test file that the run did not report, and a run that did not finish. A failure that you cannot fix at once goes in `scripts/test/sdk-known-failures.json` as `{"test": "<test file>: <test name>", "reason": "<why, with the issue>"}`. The runner fails on a failure that is not listed, and on a listed test that passes or that the run did not report. The list is empty now. Raise the version in `sdk-runtime.json` on purpose, and run the suite on the new version first.

SDK integration tests import `expect` and `test` from `./sdk-testing`. Async callbacks have a default execution allowance of 30 seconds, including fixture setup and calls to the SDK. A test can set `timeoutMs` explicitly. The adapter preserves that value. Synchronous callbacks keep the SDK's default, including in files that also have integration tests.

The SDK compiler follows `$` calls only into named top-level helpers or functions imported from the plugin. Resolve context through those helpers and pass the resulting data to shared handlers. A registry of callbacks that receive `$` prevents the hooks module from loading.


This execution allowance differs from the workflow's time limits. Keep assertions about the simulated clock, process timeouts, the hook's own budget and workflow restoration. A longer runner deadline does not change those contracts. The forced low-budget tests retain their explicit deadlines and refusal assertions.

Tests of the hook budget call the real registered tool handler through `tests/workflow-host.ts`. The host fixture supplies state, files, process results and the remaining hook budget. The simulated clock and budget move independently. Controls cover the exact threshold, refusal before the first check, interruption inside a pause and workflow restoration.

## Retained plugin version guard

Run `node scripts/ndev/workflow/check-plugin-version.mjs` after you commit. Pre-push checks and CI run the same command. It checks the committed tree, with complete Git history. A shallow clone must run `git fetch --unshallow` first.

The guard compares plugin assets at HEAD with the latest version change on the first-parent history. Changes to manifest metadata do not count as a version change. The version must exceed every earlier version on that history, so a downgrade cannot permit reuse of a published version. After another asset change, raise the patch version and commit it with the changed assets.

Plugin assets are `.claude-plugin/`, `hooks/`, `skills/`, `agents/`, `scripts/`, `kb/`, `templates/`, `types/`, `README.md` and `tsconfig.json`. Tests, CI configuration, development docs and native CLI files outside these paths do not require a plugin version bump.
