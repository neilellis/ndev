# ndev

`ndev` runs development workflows from a terminal or an agent harness. It uses Orca for worktrees, workers, messages, browser captures, and panels. It uses GitHub for issues, pull requests, and checks.

## Install

Use Node.js 22.18 or later. Install Orca and make sure `orca` is on your path. For GitHub work, sign in with the GitHub CLI.

From a copy of this repository, run the install plan first.

```sh
bin/ndev install all --dry-run
bin/ndev install all
ndev install verify all
```

Use `claude`, `codex`, or `opencode` in place of `all` to install one profile. The default binary path is `$HOME/.local/bin/ndev`. Add `$HOME/.local/bin` to your path if necessary. In Codex, use `/hooks` to review and trust the installed hooks.

The Claude install uses `CLAUDE_CONFIG_DIR` when set. When that path changes, ndev keeps each recorded Claude home working and refreshes its hooks, skills and agents on reinstall. Copied hooks must match the ownership manifest. Skills and agents reached through directory symlinks retain their recorded ownership. Foreign hooks and files stay protected.

Use `ndev install <profile> --panels` to install the Orca plugin. Orca prints the approval command if the plugin asks for trust. Open the panel in the correct Orca workspace. Use the CLI text view in a terminal or on a headless host.

## Set up a new project from an agent

Open the project's Git worktree in Orca. Give the agent this prompt in Claude Code, Codex, or opencode.

> Set up ndev for this project and for the harness you are running in. Use `ndev` or `$HOME/.local/bin/ndev` if it is already installed. Otherwise use `bin/ndev` from the ndev source. If the source is missing, download and extract the archive from `gh api repos/neilellis/ndev/tarball/main` in a temporary directory. Run `install <harness> --dry-run`, then `install <harness>` and `install verify <harness>`. Replace `<harness>` with `claude`, `codex`, or `opencode`.
>
> From this project's Git worktree, run `ndev project status --json` with the installed binary. If the project has no ndev GitHub settings, use its GitHub remote and run `ndev project setup --repo <owner/repo> --no-board`. Use `--board <owner/number>` if I gave you a board, or `ndev project setup --no-repo` if I said there is no GitHub repository. Ask if the remote is unclear. Read back the settings with `ndev project status` and tell me what was set up.
>
> If the project has no `NORTH_STAR.md` at the repository root, ask me to create it. I can also give you the project's purpose and guiding rules so you can draft the file for my approval. Keep the file if it already exists.

The install adds the CLI, skills, and hooks to your user account. Project setup records the GitHub settings in `.neil-dev.json`. Run project setup in each new repository. If the installer has just added the skills or hooks, start a fresh agent session. In Codex, use `/hooks` to review and trust the new hooks.

## Skills

Use the [skill index](skills/README.md) to find a task, compare related skills and see retired entry points. Skills are installed as `ndev-<name>` in each harness. To refresh Claude and Codex, run each profile’s dry-run, install and verify commands. Reinstall uses the ownership manifest to retire old files and preserve unrelated skills and hooks. Start a fresh session afterward.

## Use

```sh
ndev --help
ndev project status
ndev project setup --repo owner/name --no-board
ndev flow start 42 --short-name fix-login
ndev flow status --json
ndev pane view
```

Resume an existing PR in an isolated checkout by naming its issue and PR before starting work:

```sh
ndev flow start 1401 --pr 1402
```

If a local workflow already names an alias branch or an accidental duplicate PR, repair its association:

```sh
ndev flow repair --issue 1401 --pr 1402
```

The repair checks the open PR, issue link, origin, canonical head and local ancestry. It keeps the local branch, files, commits and existing canonical branch intact. Future checkpoints publish `HEAD` to the canonical PR branch. Prior review, CI and smoke evidence is cleared. Renew it on the resulting head. A pending operation, shared workflow or record in another worktree refuses repair and names the recovery. To take over from another owner, add `--take-over` only after that owner finishes. The command requires Orca to confirm that owner finished. An old timestamp or absent status is insufficient. It does not close duplicate PRs or merge anything.

`ndev flow` gives the current phase and the next step. Use `ndev flow checkpoint` to commit named files and run the workflow checks. Use `ndev wait` for one blocking wait. In Orca, the watcher checks the current PR head and sends an update when a check fails or the checks finish.

Use `ndev <group> --help` to see the commands in a group. Use `ndev <group> <command> --help` to see its flags.

### Run from Codex chat

Install the Codex profile with `ndev install codex` and start a fresh session. Type one of these commands in the chat.

```text
$ndev-cli flow status
$ndev-cli pane view --open
$ndev-triage --open
$ndev-triage launch
```

`$ndev-cli` runs an ndev command and returns its result. `$ndev-triage` loads and groups issues, then shows a plan. Use `$ndev-triage launch` when you want Orca to start the workers.

## Source and tests

- The [ndev 2.0 spec](docs/ndev-2/spec.md) defines the CLI, hooks, installer, and panel protocol.
- The [parity list](docs/ndev-2/parity.md) maps the older Claude Code plugin to the new commands and tests.
- [The knowledge base](kb/README.md) holds workflow and development guides.
- [The scripts guide](scripts/README.md) lists shared tools.

Run `npm test` for the CLI, installer, and panel regression suites, and every other tracked `*.test.mjs` file except those in `scripts/test/exceptions.json`. Set `NDEV_TEST_NATIVE_HARNESSES=1` to include native install trials when all three harnesses are available. The install tests use temporary homes.
