#!/usr/bin/env bash
# Wait quietly for one GitHub Actions run to change status.
# Usage: wait-for-run.sh <run_id> [--max-polls 120] [--interval 120]
# The default interval is 120 seconds: each poll spends GitHub quota, once for each agent waiting.
# Repository: GH_REPO, else the current checkout (see lib.sh).
# Exit 0 on a change or an already complete run, 1 on error, and 2 on timeout.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091 # The library path is resolved from this script at runtime.
source "$DIR/lib.sh"
gh_resolve_repo || exit 1

RUN_ID="${1:-}"
if ! [[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]]; then
  echo "wait-for-run.sh: give a positive GitHub Actions run ID" >&2
  exit 1
fi
shift

MAX_POLLS=120
INTERVAL=120
while [ "$#" -gt 0 ]; do
  case "$1" in
    --max-polls|--interval)
      if [ "$#" -lt 2 ]; then
        echo "wait-for-run.sh: run $RUN_ID requires a value for $1; give a positive integer" >&2
        exit 1
      fi
      if [ "$1" = --max-polls ]; then
        MAX_POLLS="$2"
      else
        INTERVAL="$2"
      fi
      shift 2
      ;;
    *)
      echo "wait-for-run.sh: unknown argument '$1'; use --max-polls N or --interval N" >&2
      exit 1
      ;;
  esac
done

if ! [[ "$MAX_POLLS" =~ ^[1-9][0-9]*$ ]] || ! [[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
  echo "wait-for-run.sh: run $RUN_ID requires positive --max-polls and --interval values" >&2
  exit 1
fi

read_status() {
  local out status err code=0
  err="$(mktemp)"
  out="$(GH_REPO="$REPO" "$DIR/gh.sh" run-status "$RUN_ID" 2>"$err")" || code=$?
  if [ "$code" -ne 0 ]; then
    echo "wait-for-run.sh: failed to read run $RUN_ID (gh.sh exited $code): $(tr '\n' ' ' <"$err" | cut -c1-500); check access with 'gh auth status' (Actions calls can need GH_USE_KEYRING=1) and retry" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  status="$(jq -r '.status // empty' <<<"$out")"
  case "$status" in
    requested|waiting|pending|queued|in_progress|completed) printf '%s\n' "$status" ;;
    *)
      echo "wait-for-run.sh: run $RUN_ID returned invalid status '$status'; check the Actions API response" >&2
      return 1
      ;;
  esac
}

initial="$(read_status)"
if [ "$initial" = completed ]; then
  echo "run $RUN_ID already completed; inspect its conclusion"
  exit 0
fi

polls=0
while true; do
  sleep "$INTERVAL"
  polls=$((polls + 1))
  current="$(read_status)"
  if [ "$current" != "$initial" ]; then
    echo "run $RUN_ID status changed: $initial -> $current"
    exit 0
  fi
  if [ "$polls" -gt "$MAX_POLLS" ]; then
    echo "wait-for-run.sh: run $RUN_ID unchanged after $polls polls (limit $MAX_POLLS); inspect the runner and retry" >&2
    exit 2
  fi
done
