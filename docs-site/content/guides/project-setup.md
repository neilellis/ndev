---
title: Project setup
description: Configure a Git repository for ndev with .neil-dev.json, credentials and NORTH_STAR.md.
---

# Project setup

Run project setup once in each Git repository that uses `ndev`. Setup writes shared GitHub and workflow defaults to `.neil-dev.json` at the repository root.

## Set up a repository from the CLI

Check whether the repository already has ndev settings:

```sh
ndev project status
ndev project status --json
```

Configure a GitHub repository without a project board:

```sh
ndev project setup --repo owner/name --no-board
```

Configure a GitHub repository with a GitHub Projects board:

```sh
ndev project setup --repo owner/name --board owner/12
```

Configure a local repository that has no GitHub remote:

```sh
ndev project setup --no-repo
```

Read back the stored configuration to confirm:

```sh
ndev project status
```

## Set up a new project from an agent

Open the project worktree in Orca and give Claude Code, Codex or opencode this prompt:

> Set up ndev for this project and for the harness you are running in. Use `ndev` or `$HOME/.local/bin/ndev` if it is already installed. Otherwise use `bin/ndev` from the ndev source. If the source is missing, download and extract the archive from `gh api repos/neilellis/ndev/tarball/main` in a temporary directory. Run `install <harness> --dry-run`, then `install <harness>` and `install verify <harness>`. Replace `<harness>` with `claude`, `codex`, or `opencode`.
>
> From this project's Git worktree, run `ndev project status --json` with the installed binary. If the project has no ndev GitHub settings, use its GitHub remote and run `ndev project setup --repo <owner/repo> --no-board`. Use `--board <owner/number>` if I gave you a board, or `ndev project setup --no-repo` if I said there is no GitHub repository. Ask if the remote is unclear. Read back the settings with `ndev project status` and tell me what was set up.
>
> If the project has no `NORTH_STAR.md` at the repository root, ask me to create it. I can also give you the project's purpose and guiding rules so you can draft the file for my approval. Keep the file if it already exists.

## Configuration files and precedence

`ndev` resolves settings in strict order: **issue record → worktree record → project file → built-in defaults**.

| File | Scope | Committed to Git | Purpose |
| --- | --- | --- | --- |
| `<repo>/.neil-dev.json` | Shared project | Yes | GitHub repo and board, default mode and steering, branding, checks, chat guard and remote defaults. |
| `<worktree>/.neil-dev.worktree.json` | Local worktree | No | Worktree overrides and running Docker stacks or dev servers. |
| `<worktree>/.neil-dev.env` | Local worktree | No (mode 600) | Private environment keys used by skills. Values are never printed in CLI output or state. |
| `<worktree>/.neil-dev.issue-<n>.json` | Local worktree | No | Issue workflow phase, ownership, check evidence, interviews and PR association. |
| `<worktree>/.neil-dev.epic-<n>.json` | Local worktree | No | Epic phases, sub-issue states, blockers, workers and stacked PR records. |
| `<repo>/NORTH_STAR.md` | Shared project | Yes | Project purpose and non-negotiable guiding rules checked during planning and review. |

## Project defaults and credentials

Set the default workflow mode (`light`, `heavy` or `hack`) and steering (`interactive` or `auto`):

```sh
ndev project mode light
ndev project steering interactive
```

Manage the git-ignored `.neil-dev.env` file in a linked worktree:

```sh
ndev project credentials --copy-from-main
ndev project credentials --init
```

At session start in a linked worktree, `ndev hook session-start` copies missing `.neil-dev.json` and `.neil-dev.env` from the main checkout. It sets mode `600` on `.neil-dev.env` and adds local Git excludes for local state files.

## Next step

Learn how `ndev flow` tracks work from issue start to merge in [Workflows](/guides/workflows/).
