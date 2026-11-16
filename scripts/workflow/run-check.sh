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

# The Node of the project: when .nvmrc or .node-version in the current folder names a major (24, v24 or
# 24.1.0) and the node on PATH is another major, put a node of that major first on PATH: nvm, then fnm,
# then Homebrew node@<major>. With none installed, stop before the check and name the repair.
# A name such as lts/iron is not read here, and the PATH stays as it is.
node_line=""
use_project_node() {
  local file="" spec major have bin cand
  for f in .nvmrc .node-version; do [ -f "$f" ] && { file="$f"; break; }; done
  [ -n "$file" ] || return 0
  spec="$(head -n1 "$file" | tr -d '[:space:]')"
  [[ "$spec" =~ ^v?([0-9]+)(\.[0-9]+)*$ ]] || return 0
  major="${BASH_REMATCH[1]}"
  have="$(node --version 2>/dev/null || echo none)"
  [[ "$have" == "v$major" || "$have" == "v$major."* ]] && return 0
  local nvm="${NVM_DIR:-$HOME/.nvm}" fnm="${FNM_DIR:-}"
  local dirs=()
  while IFS= read -r cand; do [ -n "$cand" ] && dirs+=("$cand"); done < <(
    for d in "$nvm/versions/node"/v"$major".*/bin; do [ -x "$d/node" ] && echo "$d"; done | sort -t. -k2,2nr -k3,3nr
    for root in ${fnm:+"$fnm"} "$HOME/.local/share/fnm" "$HOME/Library/Application Support/fnm"; do
      for d in "$root/node-versions"/v"$major".*/installation/bin; do [ -x "$d/node" ] && echo "$d"; done | sort -t. -k2,2nr -k3,3nr
    done
    local prefixes=("${HOMEBREW_PREFIX:-}")
    [ -n "${HOMEBREW_PREFIX:-}" ] || prefixes=(/opt/homebrew /usr/local)
    for prefix in "${prefixes[@]}"; do
      [ -x "$prefix/opt/node@$major/bin/node" ] && echo "$prefix/opt/node@$major/bin"
    done
  )
  bin="${dirs[0]:-}"
  if [ -z "$bin" ]; then
    echo "run-check.sh: $PWD/$file asks for Node $major, but node on PATH is $have ($(command -v node || echo 'not found')), and no Node $major was found in ${nvm}/versions/node, the fnm node-versions or ${HOMEBREW_PREFIX:-/opt/homebrew}/opt/node@$major. The check did not run. Repair: brew install node@$major, or nvm install $major, or fnm install $major. Then call the tool again." >&2
    exit 1
  fi
  export PATH="$bin:$PATH"
  node_line="run-check.sh: $file asks for Node $major and node on PATH was $have, so the check runs with $bin/node ($("$bin/node" --version 2>&1))."
}

cmd="${1:-}"
shift || usage
case "$cmd" in
  start)
    [ $# -ge 2 ] || usage
    dir="$1"; shift
    mkdir -p "$dir" || { echo "run-check.sh: cannot make $dir" >&2; exit 1; }
    rm -f "$dir/exit" "$dir/stdout" "$dir/stderr"
    use_project_node
    # The note on the Node goes first in the check's stderr, which the check then appends to.
    if [ -n "$node_line" ]; then echo "$node_line" >"$dir/stderr"; else : >"$dir/stderr"; fi
    # Job control gives the check its own process group, so stop can end it with its children.
    set -m
    # The streams go to files, so the detached check does not hold the caller's pipes.
    # shellcheck disable=SC2016 # the inner shell expands its own arguments
    nohup bash -c 'bash "$@" >"$0/stdout" 2>>"$0/stderr" </dev/null; echo $? >"$0/exit.tmp" && mv "$0/exit.tmp" "$0/exit"' "$dir" "$@" >/dev/null 2>&1 </dev/null &
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
