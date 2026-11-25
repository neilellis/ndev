#!/usr/bin/env bash
set -uo pipefail

CGROUP_ROOT=${CI_CGROUP_ROOT:-/sys/fs/cgroup/system.slice}
grace=10
procs_file=""
main_pid=""
units_glob=""

usage() {
  echo "usage: runner-sweep.sh --cgroup-procs <file> --main-pid <pid> [--grace <seconds>]" >&2
  echo "       runner-sweep.sh --units '<systemd unit glob> [<glob> ...]' [--grace <seconds>]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cgroup-procs|--main-pid|--units|--grace)
      [ "$#" -ge 2 ] || { echo "runner-sweep: $1 needs a value" >&2; usage; } ;;
  esac
  case "$1" in
    --cgroup-procs) procs_file=${2:-}; shift 2 ;;
    --main-pid) main_pid=${2:-}; shift 2 ;;
    --units) units_glob=${2:-}; shift 2 ;;
    --grace) grace=${2:-}; shift 2 ;;
    *) echo "runner-sweep: unknown argument: $1" >&2; usage ;;
  esac
done

case "$grace" in
  ''|*[!0-9]*) echo "runner-sweep: --grace must be a whole number of seconds, got '$grace'" >&2; usage ;;
esac
grace=$((10#$grace))

stat_fields() { sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null; }
start_of() { stat_fields "$1" | awk '{print $20}'; }
parent_of() { stat_fields "$1" | awk '{print $2}'; }
is_gone() { local state; state=$(stat_fields "$1" | awk '{print $1}'); [ -z "$state" ] || [ "$state" = Z ]; }
still_there() { is_gone "$1" && return 1; [ "$(start_of "$1")" = "${start[$1]}" ]; }
command_of() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null; }
argv_head() { tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null | head -n 2; }
is_runner_worker() { case "$(argv_head "$1" | head -n 1)" in */bin/Runner.Worker) return 0 ;; esac; return 1; }
is_runner_machinery() {
  local head first second
  head=$(argv_head "$1")
  first=$(printf '%s\n' "$head" | sed -n 1p)
  second=$(printf '%s\n' "$head" | sed -n 2p)
  case "$first" in */bin/Runner.*|*/externals/*|*_update.sh) return 0 ;; esac
  case "$second" in *_update.sh) return 0 ;; esac
  return 1
}

declare -A start=()

systemctl_out() {
  local err_file sc_err
  err_file=$(mktemp) || { echo "runner-sweep: cannot make a temporary file for the messages of systemctl $*. Check that TMPDIR is writable." >&2; return 2; }
  sc_out=$(systemctl "$@" 2>"$err_file"); sc_rc=$?
  sc_err=$(cat "$err_file"); rm -f "$err_file"
  [ "$sc_rc" = 0 ] && return 0
  echo "runner-sweep: systemctl $* failed with exit code $sc_rc: $sc_out$sc_err. Check that systemd is running and that this user may query units, then sweep again. Nothing was killed." >&2
  return 2
}

sweep_one() {
  local label=$1 procs_file=$2 main_pid=$3
  [ -r "$procs_file" ] || { echo "runner-sweep: $label: cannot read the cgroup file $procs_file. Check the unit's name and that cgroup v2 is mounted." >&2; return 2; }
  [ -d "/proc/$main_pid" ] || { echo "runner-sweep: $label: main pid $main_pid is not running, so no runner tree can be told apart from leftovers. Nothing was killed. Start the runner service, then sweep again." >&2; return 2; }

  local snap pid
  snap=$(cat "$procs_file") || { echo "runner-sweep: $label: reading $procs_file failed. Nothing was killed." >&2; return 2; }
  local -a snapshot=()
  for pid in $snap; do snapshot+=("$pid"); done
  case " ${snapshot[*]:-} " in
    *" $main_pid "*) ;;
    *) echo "runner-sweep: $label: main pid $main_pid is not in $procs_file, so the snapshot cannot be trusted. Nothing was killed. Sweep again; if it repeats, check the unit with systemctl status." >&2; return 2 ;;
  esac

  start=()
  local -A parent=()
  for pid in "${snapshot[@]}"; do
    start[$pid]=$(start_of "$pid")
    parent[$pid]=$(parent_of "$pid")
  done

  local -A in_tree=()
  in_tree[$main_pid]=1
  local changed=1 p
  while [ "$changed" = 1 ]; do
    changed=0
    for p in "${snapshot[@]}"; do
      [ -n "${in_tree[$p]:-}" ] && continue
      [ -n "${parent[$p]:-}" ] && [ -n "${in_tree[${parent[$p]}]:-}" ] && { in_tree[$p]=1; changed=1; }
    done
  done

  local worker_start=""
  for p in "${snapshot[@]}"; do
    [ -n "${in_tree[$p]:-}" ] && [ -n "${start[$p]}" ] || continue
    ! is_runner_worker "$p" || worker_start=${start[$p]}
  done

  local -a victims=()
  for p in "${snapshot[@]}"; do
    [ -n "${start[$p]}" ] || continue
    [ -n "${in_tree[$p]:-}" ] && continue
    ! is_runner_machinery "$p" || continue
    if [ -n "$worker_start" ] && [ "${start[$p]}" -ge "$worker_start" ]; then continue; fi
    victims+=("$p")
  done

  local survivors=() v
  for v in "${victims[@]}"; do
    [ "$(start_of "$v")" = "${start[$v]}" ] || continue
    echo "runner-sweep: $label: SIGTERM $v $(command_of "$v")"
    kill -TERM "$v" 2>/dev/null
  done
  local i
  for ((i = 0; i < grace; i++)); do
    local pending=0
    for v in "${victims[@]}"; do ! still_there "$v" || pending=1; done
    [ "$pending" = 0 ] && break
    sleep 1
  done
  for v in "${victims[@]}"; do
    still_there "$v" || continue
    echo "runner-sweep: $label: SIGKILL $v $(command_of "$v")"
    kill -KILL "$v" 2>/dev/null
  done
  for ((i = 0; i < grace; i++)); do
    local pending=0
    for v in "${victims[@]}"; do ! still_there "$v" || pending=1; done
    [ "$pending" = 0 ] && break
    sleep 1
  done
  for v in "${victims[@]}"; do
    ! still_there "$v" || survivors+=("$v")
  done
  echo "runner-sweep: $label: ${#victims[@]} leftover(s) found, ${#survivors[@]} could not be killed"
  if [ "${#survivors[@]}" -gt 0 ]; then
    for v in "${survivors[@]}"; do
      echo "runner-sweep: $label: pid $v could not be killed: $(command_of "$v"). Read /proc/$v/status for its state and owner, then kill it as root or restart the host." >&2
    done
    return 1
  fi
  return 0
}

if [ -n "$units_glob" ]; then
  [ -z "$procs_file$main_pid" ] || usage
  read -r -a unit_globs <<<"$units_glob"
  systemctl_out list-units --plain --no-legend --state=active "${unit_globs[@]}" || exit 2
  units=$(printf '%s\n' "$sc_out" | awk '{print $1}')
  [ -n "$units" ] || { echo "runner-sweep: no active unit matches $units_glob. List them with: systemctl list-units 'actions.runner.*'" >&2; exit 2; }
  status=0
  for unit in $units; do
    systemctl_out show --property=MainPID --value "$unit" || { status=2; continue; }
    main=$sc_out
    if [ -z "$main" ] || [ "$main" = 0 ]; then
      echo "runner-sweep: $unit: the unit is active but has no main process, so nothing was swept. Check it with: systemctl status $unit" >&2
      [ "$status" = 2 ] || status=2
      continue
    fi
    rc=0
    sweep_one "$unit" "$CGROUP_ROOT/$unit/cgroup.procs" "$main" || rc=$?
    if [ "$rc" -gt "$status" ]; then status=$rc; fi
  done
  exit "$status"
fi

[ -n "$procs_file" ] && [ -n "$main_pid" ] || usage
sweep_one "main $main_pid" "$procs_file" "$main_pid"
