# Shared scripts

Helpers that two or more skills, agents or hooks call. Each one has one copy here. A helper that only one skill uses stays in that skill's `scripts/` folder.

Call a script as `${CLAUDE_PLUGIN_ROOT}/scripts/<area>/<name>`. The installer resolves the root to the shared ndev release folder for each harness. Use the installed absolute paths; skill folders are separate from the shared release.

Scripts find their siblings from their own real path (`pwd -P`). If a sibling is missing, the script prints the missing path and the repair, then exits non-zero.

Tests are in `<area>/tests/`. Run them after a change.

## github/

| Script | What it does | Used by |
|---|---|---|
| `gh.sh` | Compact GitHub reads and writes (issues, PRs, project board), one JSON object per line. The gh command runs first and REST is the fallback; every other script reaches GitHub only through it. `GH_CACHE_TTL=<seconds>` keeps the answers of `issue-read`, `pr-read` and `issue-states` in a cache (off by default), and every other command clears the cache of its repository. Guard: `github/tests/no_raw_gh.test.mjs`. | github, issue, goal-work, work-heavy, work-heavy-auto, work-light-auto, diagram-design, agents board-survey and issue-implementer, `board/board.sh` |
| `lib.sh` | Shared GitHub settings (repository, retries). Source it; do not run it. | the scripts in `github/`, `work/work_status.py`, command-reuse |
| `project-config.sh` | Sets `GH_REPO`, `GH_PROJECT_OWNER` and `GH_PROJECT_NUMBER` from `.neil-dev.json`. Source it. | `github/` scripts, `board/board.sh` |
| `dump.py` | Dumps an issue or PR to one markdown file and downloads its images. | github, command-reuse |
| `merge-main-into-open-prs.sh` | Merges the base branch into each open PR branch. Wrapper for `merge_main_into_open_prs.py`. | github |
| `merge_main_into_open_prs.py` | The merge logic, one worktree for each PR. | `merge-main-into-open-prs.sh` |
| `wait-for-pr-change.sh` | Waits until a PR's status, checks, comments or reviews change. Polls every 120 s by default. | github, fix-ci, fix-all-prs, pick-up-prs, work-heavy, work-light, command-reuse, video-finish (`finish.mjs`) |
| `wait-for-run.sh` | Waits for one GitHub Actions run to change status. Polls every 120 s by default. | github, work-heavy, video-publish |

## env/

| Script | What it does | Used by |
|---|---|---|
| `neil-dev-env.mjs` | Finds the project's git-ignored `.neil-dev.env` (copies the main checkout's file into a worktree), creates it from the exports in `~/.zshrc` (`init`), reports key names (`status`, `check`) and runs a command with its keys (`run --need`). It never prints a value. | `hooks/credentials.ts`, video-narration, video-setup, video-images, site-check |

## board/

| Script | What it does | Used by |
|---|---|---|
| `board.sh` | Reads and moves cards on the Ready board (`ready`, `awaiting`, `items`, `move`). Calls `github/gh.sh`. | work-light-auto, work-heavy-auto, work-heavy, goal-work, agents board-survey, issue-implementer and work-heavy-auto-orchestrator, `work/pr_feedback.sh` |

## work/

| Script | What it does | Used by |
|---|---|---|
| `worktree_claim.sh` | Claims a worktree for one task (issue number or branch slug), and refuses one with uncommitted or unpushed work. | work-light, work-light-auto, work-heavy, work-heavy-auto, goal-work, implement-spec, github, command-reuse, agent issue-implementer |
| `peer_activity.sh` | Tells if another live session works in an issue's worktree. | work-heavy-auto, work-light-auto |
| `gates.sh` | Artefact gates (plan of record, pinned tests, and others) that a unit must pass before it leaves the implement loop. | work-heavy, work-heavy-auto, work-light-auto, agent plan-scout |
| `pr_feedback.sh` | Finds new human feedback on PRs. Calls `board/board.sh`. | work-heavy, work-heavy-auto |
| `work-status.sh` | One call for PR, branch, worktree and ownership status. Wrapper for `work_status.py`. | work-light, fix-ci, pick-up-prs, command-reuse |
| `work_status.py` | The status logic. | `work-status.sh` |
| `wait_for_process_end.sh` | Waits until a process exits. | work-light, fix-ci, command-reuse |
| `worktree-env.sh` | Records the resources a worktree started in `.neil-dev.worktree.json`: docker stacks (`add-stack`, `remove-stack`) and dev servers by name (`add-dev-server`, `remove-dev-server`). Shows them (`list`, with `--json --live` for status), stops one (`stop`) or all (`stop-all`) converts a version 1 file (`migrate`), creates a missing record (`init`), saves the worktree's mode and steering (`set-setting`) and writes the workflow state of one issue to `.neil-dev.issue-<id>.json` (`set-workflow`). Wrapper for `worktree_env.mjs`. | work-light, work-heavy, `hooks/worktree-stacks.ts` (session end) |
| `ndev-files.sh` | Lists the ndev files of every git worktree (`list --json`) and creates or copies a missing `.neil-dev.json` or `.neil-dev.env` (`create`, `copy`). Wrapper for `ndev_files.mjs`. | `hooks/view.tsx` (`/view`) |
| `ndev_files.mjs` | The listing and create/copy logic. Test: `node --test scripts/work/tests/ndev_files.test.mjs`. | `ndev-files.sh` |
| `worktree_env.mjs` | The record and stop logic. Test: `node --test scripts/work/tests/worktree_env.test.mjs`. | `worktree-env.sh` |
| `tests/test_gates.sh`, `tests/test_peer_activity.sh`, `tests/test_worktree_claim.sh` | Prove `gates.sh`, `peer_activity.sh` and `worktree_claim.sh` in both directions. | work-heavy-auto (its Tests line) |

## docs/

| Script | What it does | Used by |
|---|---|---|
| `screenshots.mjs` | Refreshes stale project screenshots and checks source and PNG receipts. | docs, docs-sync |
| `readability.sh` | Lints prose with the House vale style in `vale/`. | docs, work-light, work-heavy, work-heavy-auto (`work_ready_workflow.js`) |
| `md-to-pdf.sh` | Renders a markdown file to an A4 PDF. | docs |
| `vale/test.sh` | Proves every vale rule fires on `testdata/bad.md` and none fires on `testdata/good.md`. | docs |

## requirements/

| Script | What it does | Used by |
|---|---|---|
| `requirements.mjs` | The `ndev requirements` commands. Creates, lists, searches and checks the requirement records in `docs/formal/requirements/`, prints a quoted source (`quote`), renders the records as one HTML file (`render`), fails a protected text that changed since a base with no human agreement (`guard`), records that agreement from a human's terminal (`agree`), lists the documents by tier (`sources`), records lines that hold no requirement (`ledger`), lists the lines of a document that no record or ledger entry accounts for (`uncovered`), lists the merged pull requests that no record names (`untraced`), adds a pull request and its issues to a record's Trace (`link`), adds the files that implement a record (`file`), sets the Quint models that specify a record (`model`), checks the links between records, pull requests, issues and files in both directions (`trace`), and stores and checks the prose of each section of the document (`narrate`, `narrative`), writes the pages for the documentation app (`publish`), lists the files that reference a document (`references`), retires a document with a frozen copy (`retire`), moves an obsolete or replaced record to `docs/formal/deprecated/` (`deprecate`), and fails a change to the id, title, author or origin of a record (`fixed`). | requirements, requirements-find, requirements-retrospective, requirements-document, requirements-publish, requirements-retire, requirements-deprecate |

## wiki/

| Script | What it does | Used by |
|---|---|---|
| `init.sh` | Creates the development wiki from this plugin's `kb/`. | dev-wiki, `hooks/register.ts` (session start) |

## browser/

| Script | What it does | Used by |
|---|---|---|
| `orca-shot.sh` | Opens a URL in Orca's built-in browser, sets and checks the viewport, and saves a PNG screenshot. A new tab closes after the screenshot (or stays with `--keep-tab`); a `--page <id>` tab stays open. It names the repair when Orca is not running or the page is missing. | kb `testing.md`, finish, responsive-check, motion, command-reuse |
| `tests/test_orca_shot.sh` | Proves `orca-shot.sh` with a fake `orca`. | |

## walk-doc/

| Script | What it does | Used by |
|---|---|---|
| `video-to-gif.sh` | Turns a reader's browser video into a GIF. It keeps only the frames that change and caps each still stretch (`--hold`). | `hooks/walk-doc/` (the main agent, when it places a `RECORD`) |

## ui/

| Script | What it does | Used by |
|---|---|---|
| `component-sources.mjs` | Fails on a UI component file whose header does not name an approved source from `kb/ui-components.md` (`// From <source> <item> (<url>), <date>.`) or give a reason (`// Own component: <reason>.`). Exit 1 lists each file and the repair; exit 2 is a bad argument. | `kb/ui-components.md`, project guard tests |

## workflow/

| Script | What it does | Used by |
|---|---|---|
| `notify.sh` | Shows the macOS notification of a blocked workflow with `osascript`, and leaves no process running. `withdraw` stops watchers that the older `alerter` version left. Tests: `tests/workflow_scripts.test.mjs`. | `hooks/workflow/` |
| `merge.sh` | Merges a PR through REST and prints its base and migrations as JSON, with `unlisted` and a warning for each migration file that the PR adds but does not list. A stacked PR goes through merge-async, and one with an open PR below it in its stack needs `--stack`. It is safe to run twice. Tests: `tests/workflow_scripts.test.mjs`. | `merge` skill, `done` |
| `fast-checks-template.sh` | The template for a project's `fast-checks.sh`: ruff, ty, oxlint and ast-grep on the named files. Tests: `tests/workflow_scripts.test.mjs`. | Copied to `scripts/ndev/workflow/` |

## remote/

| Script | What it does | Used by |
|---|---|---|
| `root-setup.sh` | The first build of a server that `/dev remote create` made from the base image: packages, Docker, key-only SSH, host keys that a snapshot restore keeps, and the workspace user. It runs on the server as root (`u=<user> bash -s` over SSH), never on a desktop, and prints the server's new host key. A server that `/dev remote import <hetzner-id>` handed over was not built by it, and `import` runs no script on the server. | `hooks/remote-host.ts` |
| `floating-ip.sh` | Puts a floating IPv4 on `eth0` of the server (`ip addr add <floating ip> dev eth0`) and writes Hetzner's netplan file so it survives a restart. It checks first, so a second run changes nothing. It runs on the server as root (`floating=<ip> bash -s` over SSH). | `hooks/remote-host.ts` |

## export/

| Script | What it does | Used by |
|---|---|---|
| `export.mjs` | Copies the skills, agents, scripts and `kb/` for another agent harness, with a generated stamp on each file. It rewrites the Claude-only paths and tool calls, writes `manifest.json` and `leftovers.json`, and refuses to overwrite a file that it did not generate (exit 3). Prints a JSON summary. Tests: `node --test scripts/export/tests/export.test.mjs`. | `hooks/export.ts` (`/dev export`) |
| `harnesses/*.json` | One profile for each known harness: its skills and agents folders, agent format, review command, verify command and notes. | `export.mjs` |
| `flow/cli.ts` | The source of `ndev-flow`, the workflow CLI of an export. It imports the copied `machine.ts`, `change-types.ts` and `records.ts`. Tests: `node --test scripts/export/tests/flow.test.mjs`. | `export.mjs` (copied to `<home>/flow/`) |

## ndev/workflow/

| Script | Purpose | Used by |
|---|---|---|
| `check-plugin-version.mjs` | Rejects committed plugin asset changes after the latest version bump. Requires complete Git history. Tests: `node --test tests/ndev-plugin-version.test.mjs`. | `pre-push-check.sh`, CI |
