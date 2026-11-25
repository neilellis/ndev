---
title: Installation
description: Install the ndev CLI, skills, agents, hooks and optional Orca panels for Claude Code, Codex, opencode and Google Antigravity.
---

# Installation

Install `ndev` once per user account from a local clone of the repository. The installer places the `ndev` binary in `$HOME/.local/bin/ndev`, copies shared release files to `$HOME/.local/share/ndev`, and wires skills, agents and hooks into each selected harness.

## Prerequisites

- **Node.js 22.18 or later.** Check with `node --version`.
- **Orca.** Install Orca and make sure `orca` is on your `PATH`.
- **GitHub CLI (`gh`).** Sign in with `gh auth login` for issue, pull request and board commands.

## Install all harnesses

Preview the install plan before writing any file:

```sh
bin/ndev install all --dry-run
bin/ndev install all
ndev install verify all
```

`--dry-run` prints every target path, hook update and conflict without modifying disk. Add `$HOME/.local/bin` to your `PATH` if your shell does not find `ndev`.

## Install one harness profile

Replace `all` with `claude`, `codex`, `opencode` (or alias `opencode2`), or `antigravity` (or alias `agy`) to install a single harness:

```sh
bin/ndev install claude --dry-run
bin/ndev install claude
ndev install verify claude
```

To install into a custom directory instead of `$HOME/.local`, pass `--prefix <dir>`:

```sh
bin/ndev install all --prefix "$HOME/.local"
```

After installing into Codex, open Codex and run `/hooks` to review and trust the installed hooks. Start a fresh agent session after any install or refresh so the harness loads the new skills and hooks.

## Install layout

| Item | Default location |
| --- | --- |
| Binary | `$HOME/.local/bin/ndev` (or `<prefix>/bin/ndev`) |
| Shared release files | `$HOME/.local/share/ndev` (CLI, scripts, skills, templates, wiki seed, profiles, Orca plugin) |
| Ownership manifest | `$HOME/.local/share/ndev/install-manifest.json` |
| Claude Code | `~/.claude/skills/ndev-*`, `~/.claude/agents/ndev-*.md`, hooks in `~/.claude/settings.json` |
| Codex | `~/.agents/skills/ndev-*`, `~/.codex/agents/ndev-*.toml`, hooks in `~/.codex/hooks.json` |
| opencode | `~/.config/opencode/skills/ndev-*`, `~/.config/opencode/agents/ndev-*.md`, plugin under `~/.config/opencode/plugins/ndev/` |
| Antigravity | `~/.gemini/config/skills/ndev-*`, `~/.gemini/config/agents/ndev-*.md`, `ndev` hook group in `~/.gemini/config/hooks.json` |

The Claude installer honours `CLAUDE_CONFIG_DIR` when set. If you change `CLAUDE_CONFIG_DIR`, `ndev` records each Claude home and refreshes its hooks, skills and agents on reinstall. Codex honours `CODEX_HOME`, and opencode honours `XDG_CONFIG_HOME`.

## Ownership manifest and safe reinstall

Every install records owned files, versions and hook entries in `install-manifest.json`.

- **Foreign files stay protected.** The installer refuses to overwrite a file or hook entry that it does not own.
- **Retired skills clean up automatically.** Reinstalling removes unchanged files from older releases and preserves unrelated skills and hooks.
- **Symlinked skill directories keep ownership.** Skills and agents reached through directory symlinks retain their recorded ownership.

## Install the Orca panel plugin

Add `--panels` to install the `neilellis.ndev` Orca plugin alongside the harness:

```sh
ndev install claude --panels
```

If Orca asks for plugin trust, `ndev` prints the approval command with the plugin fingerprint. Rerun with `--approve <fingerprint>` to complete plugin installation:

```sh
ndev install claude --panels --approve <fingerprint>
```

You can install and use the CLI and harness profiles without installing panels. Headless hosts and plain terminals use the CLI text view automatically.

## Next step

After installation succeeds, configure your first repository in [Project setup](/guides/project-setup/).
