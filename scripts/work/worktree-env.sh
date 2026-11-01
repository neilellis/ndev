#!/usr/bin/env bash
# Records the local service stacks a git worktree started, in .neil-dev.worktree.json at the
# worktree root, and stops them. See --help, or worktree_env.mjs.
set -euo pipefail
script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
exec node "$script_dir/worktree_env.mjs" "$@"
