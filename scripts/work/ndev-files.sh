#!/usr/bin/env bash
# Lists the ndev files of every git worktree, and creates or copies a missing one.
# See --help, or ndev_files.mjs.
set -euo pipefail
script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
exec node "$script_dir/ndev_files.mjs" "$@"
