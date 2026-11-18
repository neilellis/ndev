# ndev for Orca

The Files panel shows project files and resources across local Orca worktrees. Select a worktree to create or copy its files and manage its resources. The other panels follow the active worktree and share their data with the ndev CLI.

Open it from the right sidebar (the document icon). The current workspace comes first.

| File | What it holds | Create | Copy from main |
| --- | --- | --- | --- |
| `.neil-dev.json` | mode, steering, GitHub repo and board | `{ "mode": "light", "steering": "interactive" }` | yes |
| `.neil-dev.env` | private keys for ndev skills | empty file, mode 600 | yes, mode 600 |
| `.neil-dev.worktree.json` | stacks one worktree started | no (ndev writes it) | no (one per worktree) |

Rules, so nothing leaks or is overwritten:
- Only key **names** of `.neil-dev.env` are ever shown. Values never leave the worker.
- `.neil-dev.env` is created or copied only where git ignores it. Otherwise the error names the repair: `echo .neil-dev.env >> <folder>/.gitignore`.
- An existing file is never overwritten.
- Changes apply to the active local worktree at the revision shown in the panel.
- A file that is not valid JSON, or an env file readable by other users, shows its problem and the repair command.

The worker needs the `workspace:read` capability and an installed `ndev` command. For a custom install prefix, include its `bin` directory in Orca’s PATH or set `NDEV_PANEL_CLI` to the command’s absolute path in Orca’s environment. `npm test` runs the file logic against real temporary git repositories and worktrees.

## Resources

Each workspace card lists the docker stacks and dev servers recorded in `.neil-dev.worktree.json` (version 2). Dev servers: Open, Copy port, Copy command, Stop (SIGTERM, only while the pid still runs the recorded command from the recorded start time). Docker: Stop keep data, Stop and delete data (`npx -y supabase@<cliVersion> stop --project-id <id> [--no-backup]`). Stop all has a docker policy. Data deletion requires confirmation in a native desktop dialog.

## Building the panel

Orca serves a panel as one HTML file, so relative CSS and JS do not load. Edit `panel-src/`, then run `npm run build`; it regenerates the self-contained HTML files in `panel/`.
