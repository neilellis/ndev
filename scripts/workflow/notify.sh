#!/usr/bin/env bash
# The macOS notification of the workflow tools (blocked, a long wait, interview questions).
#
#   notify.sh raise --group <id> --title <t> --message <m>
#   notify.sh withdraw --group <id> [--pid <pid>]
#
# raise shows one notification with osascript and returns. No process stays behind: the alerter
# version kept one per alert until it was dismissed, and leaked memory. The Orca worktree flag is
# the lasting signal. macOS cannot withdraw an osascript notification, so withdraw only stops a
# watcher that the alerter version started (--pid, from a workflow record of that time).
# Exit codes: 0 done; 2 bad usage; 3 osascript failed.
set -u

die() { echo "notify.sh: $1" >&2; exit "${2:-2}"; }

command=${1:-}
[ $# -gt 0 ] && shift
group="" title="" message="" pid=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "$1 needs a value"
  case "$1" in
    --group) group=$2 ;;
    --title) title=$2 ;;
    --message) message=$2 ;;
    --pid) pid=$2 ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done
[ -n "$group" ] || die "--group is required"

case "$command" in
  raise)
    [ -n "$title" ] && [ -n "$message" ] || die "raise needs --title and --message"
    # The text goes in as arguments, so no quote in it can break the script.
    out=$("${NDEV_OSASCRIPT:-osascript}" \
      -e 'on run argv' \
      -e 'display notification (item 2 of argv) with title (item 1 of argv) sound name "default"' \
      -e 'end run' \
      "$title" "$message" 2>&1)
    code=$?
    [ "$code" -eq 0 ] || die "osascript exited $code: $out. Check that Script Editor may send notifications (System Settings > Notifications)." 3
    ;;
  withdraw)
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || echo "notify.sh: the watcher $pid was not running" >&2; fi
    ;;
  *) die "usage: notify.sh raise|withdraw --group <id> ..." ;;
esac
