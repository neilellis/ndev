#!/usr/bin/env bash
# push-checked.sh — pull the base branch, then push through the pre-push gate.
#
# WHAT IT GUARDS
#   A push must contain the current base branch and must pass the pre-push hook.
#   This script refuses any --no-verify option, requires a clean worktree,
#   installs the shared hook, merges the base branch (never a rebase) and then
#   runs git push with your arguments. The pre-push hook runs the checks once,
#   after the pull.
#
# HOW TO WIRE IT
#   Keep it in the repository (for example scripts/push-checked.sh). Tell agents
#   in CLAUDE.md to push only with it:
#       bash scripts/push-checked.sh -u origin HEAD
#   This is not a Claude Code hook. It needs no .claude/settings.json entry.
#
# SETTINGS (git config, optional)
#   guard.baseBranch   the branch to pull (main if not set)
#   GUARD_INSTALLER    environment: the installer path, relative to the root
#                      (scripts/install-guard-hooks.sh if not set)
set -euo pipefail

for argument in "$@"; do
  case "$argument" in
    --no-ver*)
      printf 'ERROR: %s bypasses the required pre-push guards, so the push is refused.\n' "$argument" >&2
      exit 1
      ;;
  esac
done

root="$(git rev-parse --show-toplevel)"
cd "$root"
base_branch="$(git config --get guard.baseBranch || printf 'main')"
installer="${GUARD_INSTALLER:-scripts/install-guard-hooks.sh}"

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  printf 'ERROR: a clean worktree is required before the pull of origin/%s. Commit or preserve the pending changes first.\n' "$base_branch" >&2
  exit 1
fi
[ -f "$installer" ] || { printf 'ERROR: %s is missing. Add it or set GUARD_INSTALLER.\n' "$installer" >&2; exit 1; }

bash "$installer"
git pull --no-rebase --no-edit origin "$base_branch"
git push "$@"
