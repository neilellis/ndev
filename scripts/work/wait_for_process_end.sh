#!/bin/bash
# Wait silently until the given process exits. It cannot recover the exit code:
# read the result file or log that the command owner writes.
# Usage: wait_for_process_end.sh <pid>
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Usage: %s <positive-process-id>\n' "$0" >&2
    exit 2
fi

if ! kill -0 "$1" 2>/dev/null; then
    printf 'wait_for_process_end: process %s is not running (already ended, or not yours). Read its log or result file.\n' "$1" >&2
fi

while kill -0 "$1" 2>/dev/null; do
    sleep 5
done
