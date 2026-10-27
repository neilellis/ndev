#!/usr/bin/env bash
# Update from origin/main, run all local checks and push a clean feature branch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" || "$BRANCH" == "main" ]]; then
  echo "push-checked: refuse to push from '$BRANCH'; switch to a feature branch." >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "push-checked: worktree is not clean; commit or remove changes before continuing." >&2
  exit 2
fi
for arg in "$@"; do
  case "$arg" in
    --no-verify|--all|--mirror|main|HEAD:main|*:main|*:refs/heads/main|*/main:refs/heads/main)
      echo "push-checked: refusing bypass or push that can include main ('$arg')." >&2
      exit 2
      ;;
  esac
done

git fetch origin main
git merge --no-edit origin/main
if [[ -n "$(git status --porcelain)" ]]; then
  echo "push-checked: worktree changed during base update; resolve and commit before continuing." >&2
  exit 2
fi
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "push-checked: origin/main is not an ancestor of HEAD after merge." >&2
  exit 2
fi
"$ROOT/scripts/precheck.sh"
git push "$@"
