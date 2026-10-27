#!/usr/bin/env bash
# wait-for-process-end.sh — block until a process ends, so that nobody polls it by hand.
#
# WHAT IT GUARDS
#   Core belief 3: wait without polling. Run this once in the foreground, then
#   read the process's log. The end of a process is not proof of success: read
#   its exit status or its final log lines after this script returns.
#
# HOW TO WIRE IT
#   Keep it in the repository (for example scripts/wait-for-process-end.sh).
#       long_job > job.log 2>&1 & pid=$!
#       bash scripts/wait-for-process-end.sh "$pid"
#       tail -n 40 job.log
#   This is not a Claude Code hook. It needs no .claude/settings.json entry.
#
# SETTINGS (environment, optional)
#   WAIT_INTERVAL_SECONDS  seconds between checks (5 if not set)
set -euo pipefail

if [ "$#" -ne 1 ]; then
  printf 'usage: %s <pid>\n' "$0" >&2
  exit 2
fi
case "$1" in
  ''|*[!0-9]*|0)
    printf 'ERROR: "%s" is not a positive process id.\n' "$1" >&2
    exit 2
    ;;
esac
interval="${WAIT_INTERVAL_SECONDS:-5}"
case "$interval" in
  ''|*[!0-9]*|0) printf 'ERROR: WAIT_INTERVAL_SECONDS is "%s", not a positive whole number.\n' "$interval" >&2; exit 2 ;;
esac

while kill -0 "$1" 2>/dev/null; do
  sleep "$interval"
done
printf 'Process %s has ended. Read its log and exit status: an ended process has not proved success.\n' "$1"
