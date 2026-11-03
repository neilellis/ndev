---
name: i
description: "Alias of issue: create a GitHub issue from a description and put it in Backlog on the project board with its fields filled in. Use when the user types /i."
argument-hint: "[--orca] <description of the issue>"
---

Load the `ndev:issue` skill and follow it. The description is: $ARGUMENTS

## The workflow

After you file an issue that this session will work on, call `mcp__ndev__started(issue, shortName)`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
