#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
. "$here/config.sh"

usage="Usage: sizing.sh --config <file> [--cpus N] [--mem-gb N]   checks the config's runners against the CPUs and memory of this host, or of the host --cpus and --mem-gb describe"
usage_fail() { echo "sizing.sh: $1" >&2; echo "$usage" >&2; exit 2; }

config_arg="" cpus_override="" mem_override=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config|--cpus|--mem-gb)
      [ "$#" -ge 2 ] || usage_fail "$1 needs a value."
      case "$1" in
        --config) config_arg=$2 ;;
        --cpus) count_ok "$2" || usage_fail "--cpus must be a whole number; got '$2'."; cpus_override=$2 ;;
        --mem-gb) count_ok "$2" || usage_fail "--mem-gb must be a whole number; got '$2'."; mem_override=$2 ;;
      esac
      shift 2 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) usage_fail "unknown argument: $1." ;;
  esac
done
[ -n "$config_arg" ] || usage_fail "give --config <file>."
load_config "$config_arg"
host_size
problems=$(sizing_problems "$cpus" "$mem_gb")
if [ -n "$problems" ]; then
  echo "sizing.sh: the config does not fit $cpus CPUs and $mem_gb GB ($(sizing_rule)):" >&2
  echo "$problems" >&2
  advice="give fewer runners"
  [ -z "$heavy_label" ] || advice="$advice or fewer $heavy_label labels"
  echo "sizing.sh: $advice, or a larger host. The runner count and labels are the owner's decision." >&2
  exit 1
fi
echo "sizing.sh: $(sizing_fit "$cpus" "$mem_gb")"
