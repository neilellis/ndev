#!/usr/bin/env bash
# Runs a check script past the host's limit of 10 minutes for one process: start detaches it, and the
# plugin calls wait again and again, each call shorter than that limit, until the check ends.
#
#   run-check.sh start <dir> <script> [args...]  start the check in its own process group; print its pid.
#                                               It writes <dir>/stdout, <dir>/stderr and, at the end, <dir>/exit.
#   run-check.sh wait <dir> <pid> <seconds>     exit 0 and print the check's exit code when it has ended;
#                                               exit 124 when it still runs after <seconds>;
#                                               exit 3 when the process is gone with no exit code.
#   run-check.sh out <dir> | err <dir>          print the check's stdout or stderr.
#   run-check.sh stop <pid>                     stop the check and the processes it started.
set -uo pipefail

usage() { echo "usage: run-check.sh start <dir> <script> [args...] | wait <dir> <pid> <seconds> | out <dir> | err <dir> | stop <pid>" >&2; exit 2; }

cmd="${1:-}"
shift || usage
case "$cmd" in
  start)
    [ $# -ge 2 ] || usage
    dir="$1"; shift
    mkdir -p "$dir" || { echo "run-check.sh: cannot make $dir" >&2; exit 1; }
    rm -f "$dir/exit" "$dir/stdout" "$dir/stderr"
    # Job control gives the check its own process group, so stop can end it with its children.
    set -m
    # The streams go to files, so the detached check does not hold the caller's pipes.
    # shellcheck disable=SC2016 # the inner shell expands its own arguments
    nohup bash -c 'bash "$@" >"$0/stdout" 2>"$0/stderr" </dev/null; echo $? >"$0/exit.tmp" && mv "$0/exit.tmp" "$0/exit"' "$dir" "$@" >/dev/null 2>&1 </dev/null &
    echo $!
    ;;
  wait)
    [ $# -eq 3 ] || usage
    dir="$1"; pid="$2"; secs="$3"
    end=$((SECONDS + secs))
    while :; do
      if [ -f "$dir/exit" ]; then cat "$dir/exit"; exit 0; fi
      if ! kill -0 "$pid" 2>/dev/null; then
        [ -f "$dir/exit" ] && { cat "$dir/exit"; exit 0; }
        echo "run-check.sh: the check (pid $pid) ended and wrote no exit code to $dir/exit" >&2
        exit 3
      fi
      [ "$SECONDS" -ge "$end" ] && exit 124
      sleep 1
    done
    ;;
  out) [ $# -eq 1 ] || usage; cat "$1/stdout" ;;
  err) [ $# -eq 1 ] || usage; cat "$1/stderr" ;;
  stop)
    [ $# -eq 1 ] || usage
    kill -TERM -- "-$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null
    sleep 2
    kill -KILL -- "-$1" 2>/dev/null
    exit 0
    ;;
  *) usage ;;
esac
