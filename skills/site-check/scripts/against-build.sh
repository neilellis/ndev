#!/usr/bin/env bash
# Serve the project's production build locally and run a site check against it.
#
# Usage (run in the project root):
#   bash against-build.sh links|spider [--serve '<command>'] [extra check args]
#
# The serve command starts a server for the existing build on the port in $PORT, for example
#   --serve 'npx --yes serve@14.2.4 -l $PORT out'
# Use single quotes so that $PORT is read when the server starts. SITE_CHECK_SERVE sets the same.
# Without a serve command, a Next.js project (next in package.json) uses `npx next start -p $PORT`.
# Any other project must give a serve command.
#
# SITE_CHECK_PORT sets the port (default 3123). Exit codes: as the check, and 2 if no server starts.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE="usage: against-build.sh links|spider [--serve '<command>'] [extra check args]"

MODE="${1:-}"
case "$MODE" in
  links|spider) shift ;;
  -h|--help) echo "$USAGE"; exit 0 ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac

SERVE="${SITE_CHECK_SERVE:-}"
if [[ "${1:-}" == "--serve" ]]; then
  if [[ -z "${2:-}" ]]; then echo "site-check: --serve needs a command. $USAGE" >&2; exit 2; fi
  SERVE="$2"
  shift 2
fi

PORT="${SITE_CHECK_PORT:-3123}"
export PORT

if [[ -z "$SERVE" ]]; then
  if [[ -f package.json ]] && node -e 'const p=require("./package.json");process.exit({...p.dependencies,...p.devDependencies}.next?0:1)'; then
    if [[ ! -f .next/BUILD_ID ]]; then
      echo "site-check: no Next.js production build found in $(pwd)/.next. Run: npm run build" >&2
      exit 2
    fi
    SERVE='npx next start -p "$PORT"'
  else
    echo "site-check: $(pwd) is not a Next.js project, so give the command that serves its build on \$PORT." >&2
    echo "  Example: bash $HERE/against-build.sh $MODE --serve 'npx --yes serve@14.2.4 -l \$PORT dist'" >&2
    exit 2
  fi
fi

LOG="$(mktemp -t site-check.XXXXXX)"
bash -c "$SERVE" >"$LOG" 2>&1 &
SERVER=$!
# Stop the server and its children (npx starts the real server as a child).
trap 'pkill -P "$SERVER" 2>/dev/null || true; kill "$SERVER" 2>/dev/null || true' EXIT

URL="http://localhost:$PORT/"
for _ in $(seq 1 60); do
  if curl -sfL -o /dev/null "$URL"; then break; fi
  if ! kill -0 "$SERVER" 2>/dev/null; then
    status=0
    wait "$SERVER" || status=$?
    echo "site-check: the server command stopped with exit code $status while starting: $SERVE" >&2
    echo "Its output ($LOG):" >&2
    cat "$LOG" >&2
    exit 2
  fi
  sleep 1
done
if ! curl -sfL -o /dev/null "$URL"; then
  echo "site-check: $URL did not answer within 60 seconds. Server command: $SERVE" >&2
  echo "Its output ($LOG):" >&2
  cat "$LOG" >&2
  exit 2
fi

node "$HERE/$MODE.mjs" "$URL" "$@"
