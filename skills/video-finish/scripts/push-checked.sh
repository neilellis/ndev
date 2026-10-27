#!/usr/bin/env bash
# Update a feature branch from its base, run the project's local checks and push it.
#
# Usage (from the video project's folder):
#   push-checked.sh [--base <branch>] <git push arguments>...
#
# The local checks are `npm run precheck` in the project. The base defaults to main.
# Exit codes: 0 pushed; 2 refused (wrong branch, dirty worktree, no precheck); other: a failed step.
set -euo pipefail

BASE=main
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi
if [[ "${1:-}" == "--base" ]]; then
  BASE="${2:?push-checked: --base needs a branch name}"
  shift 2
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "push-checked: $(pwd) is not a git checkout; run from the video project's folder." >&2
  exit 2
}
cd "$ROOT"

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" || "$BRANCH" == "$BASE" ]]; then
  echo "push-checked: refuse to push from '$BRANCH'; switch to a feature branch." >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "push-checked: worktree is not clean; commit or remove changes before continuing." >&2
  exit 2
fi
for arg in "$@"; do
  case "$arg" in
    --no-verify|--all|--mirror|"$BASE"|"HEAD:$BASE"|*":$BASE"|*":refs/heads/$BASE")
      echo "push-checked: refusing bypass or push that can include $BASE ('$arg')." >&2
      exit 2
      ;;
  esac
done
if ! node -e 'process.exit(require("./package.json").scripts?.precheck ? 0 : 1)' 2>/dev/null; then
  echo "push-checked: package.json has no 'precheck' script. Add one that runs the kit checks, for example \"precheck\": \"npm run check && npm test\" (see the video-setup skill)." >&2
  exit 2
fi

git fetch origin "$BASE"
git merge --no-edit "origin/$BASE"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "push-checked: worktree changed during base update; resolve and commit before continuing." >&2
  exit 2
fi
if ! git merge-base --is-ancestor "origin/$BASE" HEAD; then
  echo "push-checked: origin/$BASE is not an ancestor of HEAD after merge." >&2
  exit 2
fi
npm run precheck
git push "$@"
