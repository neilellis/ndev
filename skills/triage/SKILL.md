---
name: triage
description: Group a project's GitHub issues, preview a triage plan, and launch or track Orca workers when asked.
---

# Triage issues

Use `ndev` on PATH. If it is missing from PATH, use `"${CLAUDE_PLUGIN_ROOT}/bin/ndev"`. Run triage in the current project worktree.

With no subcommand, or with `start`, run `ndev triage start --dry-run --json` with the user's flags. Use `--codex` in Codex unless the user asks for Claude workers. Keep a dry run when the user asks for one. Add `--open` only when the user wants open issues across the repository. Check `ndev project status` if the command reports missing GitHub settings.

If the result is `done`, report that no issues need grouping and stop. Submit groups only in the `grouping` phase. Read the issue bodies and relevant comments before grouping. If the result has only a title, read the issue with `gh issue view <number> --repo <owner/repo> --comments`.

Group related issues into one pull request per group. Give each group a short implementation hint. Submit a JSON file with a `groups` array to `ndev triage groups --file <path> --json`. Each group has `issues`, `title`, `complexity`, `hint`, and optional `after` group lead numbers. The lead is the lowest issue number in the group. Use `very-simple`, `simple`, `average`, `complex`, or `very-complex` for complexity. Account for each issue once. With `--bugs-only`, put non-bugs in `screened` as `{issue, kind, reason}`. Use `enhancement`, `proposal`, `human`, or `other` for the kind. Use `skipped` entries with `{issue, reason}` for work that cannot start.

Show the result after submission. Run `ndev triage launch` only when the phase is `planned` and the user requests launch. If the user explicitly asked for a dry run, stop after showing the result. If the CLI reports an existing triage, show its status before proposing any reset.

For `status`, `refresh`, or `launch`, run the named command directly. For other subcommands, read their CLI help and follow the next action in the result.
