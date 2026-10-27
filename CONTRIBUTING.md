# Contributing to ndev (neil-development)

This repository is a Claude Code plugin: the shared development methodology. Read `README.md` first.

- Text here is project-neutral. A fact about one project goes in that project's wiki, not here.
- A helper that two or more skills, agents or hooks use goes in `scripts/<area>/`, with its tests in
  `scripts/<area>/tests/`, and gets one line in `scripts/README.md`. Docs call it as
  `${CLAUDE_PLUGIN_ROOT}/scripts/<area>/<name>`. Never copy a shared script into a skill.
- A helper that only one skill uses stays in `skills/<name>/scripts/`. Check each script with `bash -n`,
  `python3 -m py_compile` or `node --check` after a change.
- Prose follows ASD-STE100 (`simple-english`): British spelling, answer first, present tense only.
- Bump `version` in `.claude-plugin/plugin.json` for each change, and run `claude plugin validate .`.
