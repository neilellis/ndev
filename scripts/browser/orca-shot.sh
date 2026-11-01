#!/usr/bin/env bash
# Opens a URL in Orca's built-in browser and saves a PNG screenshot of the viewport.
# Orca's browser keeps the user's signed-in sessions, so a signed-in page needs no
# password. Without --page it makes a new tab and prints its id: pass that id as
# --page on later calls, so the user's own tabs stay where they are.
#
# Usage: orca-shot.sh <url> <out.png> [--page <id>] [--viewport <W>x<H>] [--wait <seconds>]
#   --page      a browserPageId from `orca tab list --json` (or `--worktree all`)
#   --viewport  sets the CSS viewport, then checks window.innerWidth
#   --wait      extra seconds after the page loads (animations, late data)
#
# Prints: <out.png> page=<id> width=<innerWidth>
# Exit codes: 0 saved, 1 a browser command failed, 2 bad arguments,
# 3 Orca is not available (run `orca open`).
set -uo pipefail

usage() {
  sed -n 's/^# \{0,1\}//; 7,10p' "$0" >&2
  exit 2
}

[ $# -ge 2 ] || usage
URL="$1"; OUT="$2"; shift 2
PAGE=""; VIEWPORT=""; WAIT=0
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "orca-shot: $1 needs a value" >&2; usage; }
  case "$1" in
    --page) PAGE="${2:-}"; shift 2 ;;
    --viewport) VIEWPORT="${2:-}"; shift 2 ;;
    --wait) WAIT="${2:-}"; shift 2 ;;
    *) echo "orca-shot: unknown option $1" >&2; usage ;;
  esac
done
if [ -n "$VIEWPORT" ] && [[ ! "$VIEWPORT" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]]; then
  echo "orca-shot: --viewport must be <W>x<H>, for example 390x844 (got '$VIEWPORT')" >&2
  exit 2
fi
[[ "$WAIT" =~ ^[0-9]+$ ]] || { echo "orca-shot: --wait must be whole seconds (got '$WAIT')" >&2; exit 2; }

# A failed run must not leave an earlier screenshot that looks like evidence.
rm -f "$OUT"

if ! command -v orca >/dev/null 2>&1; then
  echo "orca-shot: the orca CLI is not on PATH. Repair: start the Orca app (orca open), or use Playwright or claude-in-chrome." >&2
  exit 3
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "orca-shot: python3 is not on PATH; it reads Orca's JSON. Repair: install the Xcode Command Line Tools (xcode-select --install)." >&2
  exit 3
fi

# json <expression> reads Orca's JSON on stdin and prints one field, or exits 1.
json() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1" 2>/dev/null; }

ERRF="$(mktemp)"
trap 'rm -f "$ERRF"' EXIT

# call <orca args...> runs one Orca command and keeps its JSON (stdout only) in
# $REPLY. On failure it prints the command, Orca's error code, its output and the repair.
call() {
  REPLY="$(orca "$@" --json 2>"$ERRF")"
  local rc=$?
  if [ $rc = 0 ] && [ "$(json 'd["ok"]' <<<"$REPLY")" = True ]; then
    return 0
  fi
  local code; code="$(json 'd["error"]["code"]' <<<"$REPLY")"
  echo "orca-shot: 'orca $*' failed (exit $rc): ${code:-no error code}" >&2
  { echo "$REPLY"; cat "$ERRF"; } | head -20 >&2
  case "$code" in
    browser_tab_not_found) echo "Repair: list the pages with 'orca tab list --worktree all --json', or leave out --page to open a new tab." >&2 ;;
    browser_no_tab) echo "Repair: leave out --page, so the script opens a new tab." >&2 ;;
    browser_host_unavailable) echo "Repair: bring the Orca desktop app back online (orca open)." >&2 ;;
  esac
  exit 1
}

STATUS="$(orca status --json 2>"$ERRF")"
if [ "$(json 'd["result"]["runtime"]["reachable"]' <<<"$STATUS")" != True ]; then
  echo "orca-shot: the Orca runtime is not reachable. Repair: run 'orca open' and try again." >&2
  { echo "$STATUS"; cat "$ERRF"; } | head -20 >&2
  exit 3
fi

if [ -n "$PAGE" ]; then
  call goto --url "$URL" --page "$PAGE"
else
  call tab create --url "$URL"
  PAGE="$(json 'd["result"]["browserPageId"]' <<<"$REPLY")"
  [ -n "$PAGE" ] || { echo "orca-shot: 'orca tab create' gave no browserPageId: $REPLY" >&2; exit 1; }
fi

# A page load resets the viewport, so set it after the load.
call wait --load networkidle --page "$PAGE"
if [ -n "$VIEWPORT" ]; then
  W="${VIEWPORT%x*}"; H="${VIEWPORT#*x}"
  call viewport --width "$W" --height "$H" --page "$PAGE"
fi
[ "$WAIT" = 0 ] || call wait --timeout "$((WAIT * 1000))" --page "$PAGE"

call eval --expression "window.innerWidth" --page "$PAGE"
WIDTH="$(json 'd["result"]["result"]' <<<"$REPLY")"
if [ -n "$VIEWPORT" ] && [ "$WIDTH" != "$W" ]; then
  echo "orca-shot: window.innerWidth is $WIDTH, not $W, on page $PAGE. The viewport was not applied, so a screenshot is not evidence of that size. Repair: use the responsive-check script for exact sizes." >&2
  exit 1
fi

call screenshot --format png --page "$PAGE"
if ! json 'd["result"]["data"]' <<<"$REPLY" | python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode(sys.stdin.read()))' "$OUT"; then
  rm -f "$OUT"
  echo "orca-shot: could not decode the screenshot of page $PAGE into $OUT." >&2
  exit 1
fi
if [ "$(head -c 4 "$OUT" | od -An -c | tr -d ' ')" != "211PNG" ]; then
  rm -f "$OUT"
  echo "orca-shot: the screenshot of page $PAGE is not a PNG; nothing saved." >&2
  exit 1
fi

echo "$OUT page=$PAGE width=$WIDTH"
