#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
usage="Usage: sizing.sh --config <file> [--cpus N] [--mem-gb N]
       sizing.sh --cpus N --mem-gb N --runners N [--heavy N] [--heavy-label supabase]

  Checks a runner plan against the host: one runner with the heavy label (default supabase) per 4 CPUs,
  one runner per 2 CPUs, 8 GB of memory per runner. Without --cpus and --mem-gb it reads this host.
  Exit 0: the plan fits. Exit 1: it does not, and each broken rule is printed. Exit 2: bad arguments."
usage_fail() { echo "sizing.sh: $1" >&2; echo "$usage" >&2; exit 2; }
. "$here/lib.sh"

cis_defaults
runners_arg="" heavy_arg=""
cis_preload_config "$@"
while [ "$#" -gt 0 ]; do
  if cis_common_option "$@"; then shift 2; continue; fi
  case "$1" in
    --runners|--heavy|--heavy-label)
      [ "$#" -ge 2 ] || usage_fail "$1 needs a value."
      case "$1" in --runners) runners_arg=$2 ;; --heavy) heavy_arg=$2 ;; --heavy-label) heavy_label=$2 ;; esac
      shift 2 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) usage_fail "unknown argument: $1." ;;
  esac
done

if [ -n "$runners_arg" ]; then
  [ "${#runner_specs[@]}${#cli_runner_specs[@]}" = 00 ] || usage_fail "give --runners or a runner plan (--config or --runner), not both."
  [[ "$runners_arg" =~ ^[1-9][0-9]*$ ]] || usage_fail "--runners must be a whole number; got '$runners_arg'."
  [[ "${heavy_arg:-0}" =~ ^[0-9]+$ ]] || usage_fail "--heavy must be a whole number; got '$heavy_arg'."
  [ -z "$cpus_override" ] || [[ "$cpus_override" =~ ^[1-9][0-9]*$ ]] || usage_fail "--cpus must be a whole number; got '$cpus_override'."
  [ -z "$mem_override" ] || [[ "$mem_override" =~ ^[1-9][0-9]*$ ]] || usage_fail "--mem-gb must be a whole number; got '$mem_override'."
  runner_count=$runners_arg heavy_count=${heavy_arg:-0}
else
  [ -z "$heavy_arg" ] || usage_fail "--heavy goes with --runners; with a runner plan the heavy runners are counted from their labels."
  [ -n "$name_prefix" ] || name_prefix=sizing
  cis_validate
fi

cis_host_size
problems=$(sizing_problems "$cpus" "$mem_gb" "$runner_count" "$heavy_count" "$heavy_label")
if [ -n "$problems" ]; then
  echo "sizing.sh: $runner_count runners ($heavy_count with $heavy_label) do not fit $cpus CPUs and $mem_gb GB:"
  echo "$problems"
  exit 1
fi
echo "sizing.sh: $runner_count runners ($heavy_count with $heavy_label) fit $cpus CPUs and $mem_gb GB."
