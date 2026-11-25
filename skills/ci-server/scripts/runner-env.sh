#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
. "$here/config.sh"

usage="Usage: runner-env.sh --config <file> <slot>   prints the .env of the runner in that slot"
usage_fail() { echo "runner-env.sh: $1" >&2; echo "$usage" >&2; exit 2; }

config_arg="" slot=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) [ "$#" -ge 2 ] || usage_fail "--config needs a file."; config_arg=$2; shift 2 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    -*) usage_fail "unknown argument: $1." ;;
    *) [ -z "$slot" ] || usage_fail "give one slot, not '$slot' and '$1'."; slot=$1; shift ;;
  esac
done
[ -n "$config_arg" ] || usage_fail "give --config <file>."
[ -n "$slot" ] || usage_fail "give the slot of a runner."
load_config "$config_arg"
require_slot "$slot"
runner_env "$slot"
