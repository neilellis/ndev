#!/usr/bin/env bash
# Managed by install-guard-hooks.sh.
#
# pre-push-dispatch.sh — the shared pre-push hook for every worktree of one clone.
#
# WHAT IT GUARDS
#   install-guard-hooks.sh copies this file into the shared Git common folder and
#   sets core.hooksPath to it. On each push, it runs the tracked .githooks/pre-push
#   of the worktree that pushes, so each branch runs its own version of the hook.
#   It refuses the push when that worktree has no .githooks/pre-push.
#
# HOW TO WIRE IT
#   Keep this file in the repository (for example scripts/pre-push-dispatch.sh).
#   Do not install it by hand: run install-guard-hooks.sh. The marker comment on
#   line 2 lets the installer recognise and replace its own copy.
#   This is a Git hook, not a Claude Code hook. It needs no .claude/settings.json entry.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
if [ ! -x "$root/.githooks/pre-push" ]; then
  printf 'ERROR: push refused: %s has no executable .githooks/pre-push. Merge the base branch into this worktree to get the guard hook, then retry.\n' "$root" >&2
  exit 1
fi
exec "$root/.githooks/pre-push" "$@"
