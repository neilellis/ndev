#!/usr/bin/env bash
# Merge the base branch into open PR branches. See: merge-main-into-open-prs.sh --help
# Repository: GH_REPO, else the current checkout. Base: the repository's default branch.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
gh_resolve_repo || exit 1
base="$(GH_REPO="$REPO" "$DIR/gh.sh" default-branch | jq -r .default_branch)" \
  || { echo "merge-main-into-open-prs.sh: cannot read the default branch of $REPO; run 'gh auth status'" >&2; exit 1; }
exec python3 "$DIR/merge_main_into_open_prs.py" --github-repo "$REPO" --base "$base" "$@"
