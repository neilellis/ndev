#!/usr/bin/env bash
# install-guard-hooks.sh — install the shared pre-push dispatcher for this clone and all its worktrees.
#
# WHAT IT GUARDS
#   Every worktree of a clone shares one Git common folder. This script copies
#   pre-push-dispatch.sh into <common>/guard-hooks/pre-push and sets
#   core.hooksPath to that folder, so every worktree runs the pre-push gate.
#   It never replaces a hook that it does not recognise: a hook without the
#   marker comment, or an existing hooks folder with real hooks in it, stops
#   the install with a message.
#
# HOW TO WIRE IT
#   Keep it in the repository (for example scripts/install-guard-hooks.sh) next
#   to pre-push-dispatch.sh. push-checked.sh runs it before each push. It is
#   idempotent. Run it by hand once after a fresh clone:
#       bash scripts/install-guard-hooks.sh
#   This is not a Claude Code hook. It needs no .claude/settings.json entry.
#
# SETTINGS (environment, optional)
#   GUARD_DISPATCHER  path of the dispatcher, relative to the root
#                     (scripts/pre-push-dispatch.sh if not set)
set -euo pipefail

marker='# Managed by install-guard-hooks.sh.'
root="$(git rev-parse --show-toplevel)"
cd "$root"
dispatcher="${GUARD_DISPATCHER:-scripts/pre-push-dispatch.sh}"

if [ ! -x .githooks/pre-push ]; then
  printf 'ERROR: %s/.githooks/pre-push is missing or not executable. Add it (see kb/hooks/pre-push) or update this checkout.\n' "$root" >&2
  exit 1
fi
if [ ! -x "$dispatcher" ]; then
  printf 'ERROR: %s is missing or not executable. Add it or set GUARD_DISPATCHER.\n' "$dispatcher" >&2
  exit 1
fi
if ! grep -Fq "$marker" "$dispatcher"; then
  printf 'ERROR: %s does not carry the marker line "%s". The installer could not recognise it later.\n' "$dispatcher" "$marker" >&2
  exit 1
fi

common="$(git rev-parse --path-format=absolute --git-common-dir)"
installed="$common/guard-hooks"
current="$(git rev-parse --git-path hooks)"

# Hooks that somebody else installed need an explicit integration, not a silent replacement.
if [ "$current" != "$installed" ] && [ "$current" != .githooks ] && [ "$current" != "$root/.githooks" ] && [ -d "$current" ]; then
  existing="$(find "$current" -maxdepth 1 ! -name '*.sample' \( -type f -o -type l \) -print -quit)"
  if [ -n "$existing" ]; then
    printf 'ERROR: existing hooks at %s (first: %s) need an explicit integration. Nothing was replaced.\n' "$current" "$existing" >&2
    exit 1
  fi
fi
if [ -e "$installed/pre-push" ] && ! grep -Fq "$marker" "$installed/pre-push"; then
  printf 'ERROR: %s/pre-push is not a hook this installer made. Nothing was replaced. Integrate it by hand.\n' "$installed" >&2
  exit 1
fi

mkdir -p "$installed"
temporary="$(mktemp "$installed/pre-push.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
cp "$dispatcher" "$temporary"
chmod +x "$temporary"
mv "$temporary" "$installed/pre-push"
git config --local core.hooksPath "$installed"
printf 'Installed the pre-push gate at %s for this clone and its worktrees.\n' "$installed/pre-push"
