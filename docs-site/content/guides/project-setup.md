---
title: Project setup
description: Configure a Git repository for ndev with .ndev.json, credentials and NORTH_STAR.md.
---

# Project setup

Run project setup once in each Git repository that uses `ndev`. Setup writes shared GitHub and workflow defaults to `.ndev.json` at the repository root.

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
| `<repo>/.ndev.json` | Shared project | Yes | GitHub repo and board, default mode and steering, branding, checks, chat guard and remote defaults. |
| `<worktree>/.neil-dev.worktree.json` | Local worktree | No | Worktree overrides and running Docker stacks or dev servers. |
| `<worktree>/.neil-dev.env` | Local worktree | No (mode 600) | Private environment keys used by skills. Values are never printed in CLI output or state. |
| `<worktree>/.neil-dev.issue-<n>.json` | Local worktree | No | Issue workflow phase, ownership, check evidence, interviews and PR association. |
| `<worktree>/.neil-dev.epic-<n>.json` | Local worktree | No | Epic phases, sub-issue states, blockers, workers and stacked PR records. |
| `<repo>/NORTH_STAR.md` | Shared project | Yes | Project purpose and non-negotiable guiding rules checked during planning and review. |

The project file was `.neil-dev.json` before. `ndev` still reads `.neil-dev.json` when `.ndev.json` does not exist, and the next write moves it to `.ndev.json`. To move it now, run `ndev project migrate-config` and commit the rename. When both files exist and their settings differ, `ndev` reads neither and stops with an error. Keep the settings you want in `.ndev.json` and delete `.neil-dev.json`.

## Dev servers and Proof

`devServers` names the servers that boot the app. Agents and Proof start them to look at the app:

```json
{
  "devServers": {
    "web": { "command": "npm run dev", "cwd": "apps/web", "port": 3000, "ready": "http://localhost:3000/", "routes": ["/", "/settings"] }
  }
}
```

- `command` runs in `cwd` (relative to the project root), with `env` added to the environment.
- `ready` is a URL or a path. The server is ready when the URL answers or the path exists. `timeout` is the seconds to wait for it, 60 by default.
- `routes` are the pages to look at.

`ndev project dev-servers` lists them. `ndev project dev-servers start web` starts one and waits until it is ready.

`proof` sets the Proof check of pull requests. Proof is on unless you turn it off:

```json
{
  "proof": {
    "enabled": true,
    "checks": { "requirements": true, "code": true, "visual": true, "tests": true, "model": true, "docs": true, "lessons": true },
    "viewports": [{ "name": "phone", "width": 390, "height": 844 }],
    "schemes": ["light", "dark"],
    "label": "no-proof",
    "tiers": { "small": 50, "large": 400 },
    "limits": { "standard": { "turns": 40, "budget": 3 }, "complex": { "turns": 100, "budget": 10 } }
  }
}
```

- Set `"enabled": false` to turn Proof off for the project, or set one check to `false`.
- Add the label (`no-proof` by default) to one pull request to skip Proof for it.
- `tiers` are the changed-line counts at which Proof does more checks.
- `limits` cap the Proof agent for each tier: the most turns, and the most US dollars of one run.
- Proof reads these settings from the base branch, not from the pull request, so a pull request cannot turn off its own checks.

`ndev proof plan --base <ref> [--pr <n> | --event <file>] [--proven <sha>]` shows what Proof will check, with no agent. It gives:

- the tier: `trivial`, `standard` or `complex`, with the reasons;
- for each check, `run`, or `skip` with the reason;
- `skip`, with the reason, when Proof skips the whole run.

| Tier | When |
| --- | --- |
| `complex` | At least `tiers.large` changed lines, a risk path (a schema, migration, auth, lock or concurrency, or workflow file), or the label `proof:complex`. |
| `standard` | At least `tiers.small` changed lines, a new exported interface, or a touched requirement record. |
| `trivial` | Any other change, for example a docs-only change. |

Lock files count as changed files, but their lines do not count. A deleted code file makes the change at least `standard`. The label `proof:complex` raises the tier and never lowers it.

Proof skips the whole run when:

- `enabled` is `false` on the base branch;
- the pull request has the opt-out label;
- the pull request is a draft;
- the pull request comes from a fork and `ANTHROPIC_API_KEY` is not set;
- since the commit given by `--proven`, there is only a rebase, or only a change to blank lines and spaces at the ends of lines. Any other space change runs Proof, because a space inside a string or between tokens can change what the code does. A Python, YAML or Makefile change always runs Proof.

The pull request facts come from `gh` with `--pr`, or from the GitHub event file with `--event` (`GITHUB_EVENT_PATH` by default).

`ndev proof evidence --plan <file> [--body <file>]` collects the facts for each check that the plan runs. It makes no judgement. Give it the output of `ndev proof plan --json`, made at the same commit. Each check gets a `state`:

| Check | Facts | States |
| --- | --- | --- |
| `requirements` | The `REQ-NNNN` identifiers that the pull request body, its closing issues and its commits cite; the record and status of each; the report of `ndev requirements verify --base`. | `present`, `missing` (none cited), `not-run` |
| `tests` | The changed test files, and the changed source files with no changed test in the same folder or with the same name. | `present`, `missing` |
| `model` | The Quint models in the `model` lists of the touched records, the models that the change adds, and the result of `ndev requirements model-check`. | `present`, `missing`, `not-run` |
| `docs` | The changed docs-site files, and the changed user-facing files when no docs-site file changed. | `present`, `missing`, `not-needed` |
| `lessons` | The text of the `## Lessons` section of the pull request body. | `present`, `empty`, `missing`, `not-run` |

A check that the plan skips is `skipped`, with the reason. A collector that cannot run is `not-run`, with the command and its output. Examples are a project with no Quint, and a base branch that is not fetched. `not-run` is never a pass.

The body comes from `--body`, else from `gh` for the plan's pull request, else from `GITHUB_EVENT_PATH`.

`ndev proof snapshots --out <dir> (--pr <n> | --local) [--routes <a,b>] [--base <ref>]` takes the screenshots for the `visual` check:

1. It starts each dev server that has `routes`, and waits until it is ready.
2. It takes a screenshot of each route at each of the Proof `viewports`, in each of the `schemes`, at device scale 1 as JPEG quality 60. It also checks each page for overflow, small touch targets and low contrast.
3. It stops the server, also when a step fails.
4. It writes `grid.md` in `--out`: for each route, a table of viewports by schemes, with the findings under each image.

- With `--pr <n>`, it pushes the images to the `ndev-proof-assets` branch under `pr-<n>/<commit>/`, and the grid links them. Each push adds a commit and keeps the images of other pull requests. The worktree must be clean.
- With `--local`, it pushes nothing, and the grid links the images in `--out`.
- With `--base <ref>`, it also starts the servers at the base commit, in a temporary worktree, and takes a before image of each route that the base lists. The grid then shows before and after side by side.
- `--routes /,/settings` takes only these routes.

The command stops with an error when a route does not load, a server does not start, or the screenshot tool cannot run. The message names the server, the route and the end of the server log. The screenshots need Playwright where the server runs (`npm i -D playwright`, then `npx playwright install chromium`).

`ndev proof report --plan <file> [--verdict <file>] [--evidence <file>] [--grid <file>] (--pr <n> | --local)` checks a verdict and posts the result:

1. It refuses a verdict that does not match the plan, lists every problem, and exits 2. A check whose evidence is `not-run` cannot pass. A skipped plan needs no verdict.
2. With `--pr <n>`, it writes one comment on the pull request: a table of the checks A to G with each state and its evidence, the tier with its reasons, and the snapshot grid. The next report edits the same comment. It edits only a comment of the same user, `github-actions[bot]` in GitHub Actions.
3. It sets the `ndev proof` check run on the plan's commit: `success`, `failure`, or `skipped` for a skipped plan. The token needs `checks: write`.
4. It exits 1 when a check that the plan runs fails or did not run.

With `--local`, it posts nothing and prints the comment.

`ndev proof run (--pr <n> | --local) [--base <ref>] [--out <dir>] [--body <file>]` does all the steps: plan, evidence, snapshots when the visual check runs, the verdict, and report. The base is `--base`, else `origin/$GITHUB_BASE_REF`. It keeps each file in `--out`, or in a new temporary folder.

| Tier | Verdict |
| --- | --- |
| `trivial` | From the evidence, with no agent: `present` and `not-needed` pass, `missing` and `empty` fail. The code check is skipped. |
| `standard` | The Proof agent (`claude`, or `NDEV_PROOF_AGENT`) reads the diff, with the `ndev-proof` skill, inside the `limits` of the tier. |
| `complex` | The agent also reads the code paths that the change touches, and the Quint models. |

When the agent fails, stops at a limit, or writes no valid verdict, each check that it judges is `not-run`, and the run fails.

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

At session start in a linked worktree, `ndev hook session-start` copies missing `.ndev.json` and `.neil-dev.env` from the main checkout. It sets mode `600` on `.neil-dev.env` and adds local Git excludes for local state files.

## Next step

Learn how `ndev flow` tracks work from issue start to merge in [Workflows](/guides/workflows/).
