#!/usr/bin/env bash
# Copyright (c) 2026 Neil Ellis. Licensed under the MIT License.
# One agent call for PR, branch, worktree, and ownership status. See --help.
set -euo pipefail
script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
exec python3 "$script_dir/work_status.py" "$@"
