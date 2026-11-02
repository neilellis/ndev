#!/usr/bin/env bash
# Records the resources a git worktree started (docker stacks and dev servers), in
# .neil-dev.worktree.json at the worktree root, and stops them. See --help, or worktree_env.mjs.
set -euo pipefail
script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
exec node "$script_dir/worktree_env.mjs" "$@"
