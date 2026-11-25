---
title: Orca integration and panels
description: Manage worktrees, panels, remote servers, triage, epics and automated PR repair with ndev and Orca.
---

# Orca integration and panels

`ndev` uses Orca for isolated Git worktrees, worker orchestration, browser captures, terminals and desktop panels. Every panel reads from the same versioned state snapshots that the CLI prints as text, so headless hosts and terminals work identically.

## Orca panels (`ndev pane`)

Install the `neilellis.ndev` Orca plugin with `ndev install <profile> --panels`. Open a panel from Orca's right sidebar or from the CLI:

```sh
ndev pane view --open
ndev pane responsive-matrix --open
ndev pane screenshot http://localhost:3000 --viewport 1280x800 --scheme light --scheme dark
```

Available panels:

- **Files** — inspects `.neil-dev.json`, `.neil-dev.env` (key names only; values never leave the worker) and `.neil-dev.worktree.json` across local worktrees, and manages recorded dev servers and Docker stacks.
- **View** — displays workflow state, running check elapsed time and limits, and active watchers for the worktree.
- **Interview** — presents structured interactive questions and records answers on the issue record.
- **Walk-doc** — tracks fresh-reader documentation walkthroughs.
- **Triage** — reviews grouped issues, close/keep verdicts and worker capacity.
- **Fix-all-prs** — monitors the pull request repair queue.
- **Responsive matrix** — inspects viewport and light/dark screenshot grids.

Manage worktree files and recorded resources from the CLI as well:

```sh
ndev pane files create .neil-dev.json
ndev pane files copy-from-main .neil-dev.env
ndev pane resources stop-server web
ndev pane resources stop-all stop-keep-data
```

See the [Orca panel plugin reference](/architecture/orca-plugin/) for full security and build details.

## Multi-issue coordination (`ndev epic`)

`ndev epic` coordinates multi-issue delivery across nine phases: `framing` → `researching` → `specifying` → `deciding` → `spec-review` → `slicing` → `coordinating` → `closing` → `done`.

```sh
ndev epic start 64 --parallel 3
ndev epic status 64
ndev epic next 64
ndev epic import 64 --issues-file issues.json --evidence "Refreshed from GitHub"
```

Key guarantees verified by the [epic workflow Quint model](/architecture/formal-models/):

- **Dependency-safe stacking.** A child issue can start on an open pushed blocker PR when parallel capacity allows. After the blocker merges, `ndev epic` delivers durable rebase and retarget handoffs. A child cannot be verified until its blocker is merged and its PR targets the default branch.
- **Capacity reservation.** Active PRs owned externally (`external`) reserve parallel slots alongside managed workers.
- **Human gates stay explicit.** A `human` child issue stays `human-pending` until a person records explicit resolution evidence.
- **Zero unruled debt at close.** An epic can leave `closing` for `done` only when all sub-issues are merged and open review debt is zero.

## Issue triage (`ndev triage`) and worker safety

`ndev triage` loads open issues, groups related work and launches Orca workers safely:

```sh
ndev triage start --open
ndev triage launch
ndev triage status
```

Triage enforces the [Orca worker safety rules](/architecture/orca-worker-safety/):

- Starts **one worker at a time** by default.
- On local macOS and Linux hosts, holds new starts when the 1-minute load average exceeds the CPU core count.
- Before retrying a Task, reads every page of `orca orchestration worker-list` and requires positive proof of `exited` liveness and `released` terminal state.

## Automated PR repair (`ndev fix-prs`)

`ndev fix-prs` maintains a repair queue for open PRs:

```sh
ndev fix-prs start --no-merge
ndev fix-prs status
ndev fix-prs pause
ndev fix-prs resume
ndev fix-prs retry 142
```

Each repair worktree is configured for `light` mode and `auto` steering before launching its Codex worker. Pass `--no-merge` to leave green PRs for human merge. `NDEV_PR_CHECK_MS` sets the check interval (default: 15 minutes).

## Remote Orca servers (`ndev remote`)

Manage saved remote Orca servers for offloading heavy worktrees and epics:

```sh
ndev remote status
ndev remote list
ndev remote set prod-builder
ndev remote create build-01 --type cpx31 --location fsn1
ndev remote off
```
