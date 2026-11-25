---
title: Claude Code, Codex, opencode and Antigravity
description: How skills, agents and hooks work across Claude Code, Codex, opencode, Google Antigravity and custom profiles.
---

# Using ndev across agent harnesses

`ndev` installs the same shared skills, agents and hook logic into **Claude Code**, **Codex**, **opencode** and **Google Antigravity**, rewriting only harness-specific paths and invocation syntax.

## Skill naming and invocation

Every folder under `skills/<name>/` installs as `ndev-<name>`.

| Harness | Skill invocation | Skills folder | Agents folder | Hooks location |
| --- | --- | --- | --- | --- |
| Claude Code | `/ndev-<name>` | `~/.claude/skills/ndev-*` | `~/.claude/agents/ndev-*.md` | `~/.claude/settings.json` |
| Codex | `$ndev-<name>` | `~/.agents/skills/ndev-*` | `~/.codex/agents/ndev-*.toml` | `~/.codex/hooks.json` |
| opencode | `ndev-<name>` | `~/.config/opencode/skills/ndev-*` | `~/.config/opencode/agents/ndev-*.md` | `~/.config/opencode/plugins/ndev/` |
| Antigravity | `ndev-<name>` | `~/.gemini/config/skills/ndev-*` | `~/.gemini/config/agents/ndev-*.md` | `~/.gemini/config/hooks.json` (`ndev` group) |

Start a fresh agent session after installing or updating `ndev` so the harness picks up newly installed skills and hooks.

## Running ndev from Codex chat

Install the Codex profile with `ndev install codex`, trust the hooks using `/hooks`, and start a fresh Codex session. Common chat commands:

```text
$ndev-cli flow status
$ndev-cli pane view --open
$ndev-triage --open
$ndev-triage launch
```

- `$ndev-cli` runs any `ndev` CLI command and returns its structured result.
- `$ndev-triage` loads and groups issues and displays a triage plan.
- `$ndev-triage launch` instructs Orca to dispatch workers for approved groups.

## Google Antigravity notes

The `antigravity` profile targets Google Antigravity (both the app and the `agy` CLI). It writes an `ndev` group in `~/.gemini/config/hooks.json` and leaves other hook groups untouched. Antigravity has no session-end or compaction hook, so stop worktree stacks before leaving a session. `ndev install verify antigravity` checks the files and runs the tool hook, because `agy` has no command that lists installed skills.

## Verified harness targets

The installer targets Claude Code, Codex and opencode v2. Native trials ran on Claude Code 2.1.326, Codex 0.166.0 and opencode 2.3.0.

Run native trials locally when all three harnesses are available:

```sh
NDEV_TEST_NATIVE_HARNESSES=1 npm test
```

## Custom profiles without native hooks

To target a harness that does not support native lifecycle hooks, pass a custom profile JSON file:

```sh
ndev install my-harness --profile ./my-harness.json --dry-run
ndev install my-harness --profile ./my-harness.json
```

Profiles without native hooks install a session skill with the event duties an agent can perform. They also report which tool guards and cleanup steps require host hook support.

## Refreshing an existing install

Run the dry-run, install and verify sequence for each installed profile:

```sh
bin/ndev install all --dry-run
bin/ndev install all
ndev install verify all
```

The ownership manifest retires obsolete files safely while leaving locally modified or third-party skills untouched. Browse all installed skills in the [Skills index](/skills/) and agent definitions in the [Agents index](/agents/).
