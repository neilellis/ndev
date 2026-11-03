#!/usr/bin/env bash
# The persistent notification of the workflow tools (blocked, unblocked).
#
#   notify.sh raise --group <id> --title <t> --message <m> --log <file> [--terminal <orca handle>]
#   notify.sh withdraw --group <id> [--pid <pid>]
#
# raise starts a detached watcher and prints its pid. The alert stays until it is dismissed. A click
# brings the Orca terminal to the front. withdraw removes the alert and stops the watcher.
# Exit codes: 0 done; 2 bad usage; 3 alerter is not installed.
set -u

die() { echo "notify.sh: $1" >&2; exit "${2:-2}"; }
need_alerter() {
  command -v "${NDEV_ALERTER:-alerter}" >/dev/null 2>&1 \
    || die "alerter is not installed, so no persistent notification was raised. Run: brew install vjeantet/tap/alerter" 3
}

command=${1:-}
[ $# -gt 0 ] && shift
group="" title="" message="" terminal="" log="" pid=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "$1 needs a value"
  case "$1" in
    --group) group=$2 ;;
    --title) title=$2 ;;
    --message) message=$2 ;;
    --terminal) terminal=$2 ;;
    --log) log=$2 ;;
    --pid) pid=$2 ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done
[ -n "$group" ] || die "--group is required"

case "$command" in
  raise)
    [ -n "$title" ] && [ -n "$message" ] && [ -n "$log" ] || die "raise needs --title, --message and --log"
    need_alerter
    # The output goes to the log, so the detached watcher does not hold the caller's pipes.
    nohup bash "$0" _watch --group "$group" --title "$title" --message "$message" --terminal "$terminal" --log "$log" >>"$log" 2>&1 </dev/null &
    echo $!
    ;;
  _watch)
    # alerter runs in the background so that a TERM reaches it now: bash runs a trap only after a
    # foreground child ends, and this child ends only when the alert is answered.
    result=$(mktemp)
    "${NDEV_ALERTER:-alerter}" --title "$title" --message "$message" --group "$group" --actions Open --close-label Dismiss --sound default --ignore-dnd >"$result" &
    child=$!
    trap 'kill "$child" 2>/dev/null; rm -f "$result"; exit 0' TERM INT
    wait "$child"
    code=$?
    answer=$(cat "$result")
    rm -f "$result"
    echo "$(date -u +%FT%TZ) alerter exited $code: $answer"
    case "$answer" in
      @CONTENTCLICKED|@ACTIONCLICKED|Open)
        if [ -n "$terminal" ]; then
          "${NDEV_ORCA:-orca}" terminal switch --terminal "$terminal"
          echo "$(date -u +%FT%TZ) orca terminal switch --terminal $terminal exited $?"
        fi
        ;;
    esac
    ;;
  withdraw)
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || echo "notify.sh: the watcher $pid was not running" >&2; fi
    need_alerter
    "${NDEV_ALERTER:-alerter}" --remove "$group"
    ;;
  *) die "usage: notify.sh raise|withdraw --group <id> ..." ;;
esac
