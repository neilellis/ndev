#!/usr/bin/env bash
# readability.sh — mechanical half of the readability gate.
#
# Lints prose an agent is about to post or commit (a plan, an issue/PR comment, a wiki
# page, a docs page) against the House vale style in ./vale (plain-prose rules: short
# sentences, no hedges, no overclaims, no corporate filler, no artefact-as-actor).
#
#   readability.sh <file> [<file>...]     lint files
#   readability.sh -                      lint stdin (treated as markdown)
#
# Exit codes:  0 = clean   1 = errors found (fix before posting)   2 = vale not installed
#
# Vale is syntax-aware: it skips fenced code blocks, inline code, link targets and URLs,
# so identifiers and table names never trip it. Only prose is judged.
#
# This is the MECHANICAL half only. It cannot tell you that a sentence is technically
# plain and still says nothing — that needs a cold reader: a fresh agent that gets only
# the text and says what it could not decode.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$HERE/vale/.vale.ini"

if ! command -v vale >/dev/null 2>&1; then
  echo "readability.sh: vale is not installed — the readability gate cannot run." >&2
  echo "  fix: brew install vale   (other systems: https://vale.sh/docs/install)" >&2
  exit 2
fi

if [ $# -eq 0 ]; then
  echo "usage: readability.sh <file> [<file>...]   |   readability.sh -" >&2
  exit 2
fi

if [ "$1" = "-" ]; then
  TMP="$(mktemp -t readability).md"
  trap 'rm -f "$TMP"' EXIT
  cat > "$TMP"
  set -- "$TMP"
else
  # ⚠️ A PATH THAT DOES NOT EXIST MUST NOT PASS THE GATE.
  # `vale` handed a missing path falls back to reading stdin, and with no stdin that is
  # empty input — so it prints a cheerful "0 errors ... in stdin" and exits 0. A typo, or
  # running from the wrong directory, therefore reads as a clean gate on a file nobody
  # linted. Fail loudly instead.
  MISSING=0
  for path in "$@"; do
    if [ ! -f "$path" ]; then
      echo "readability.sh: no such file: $path" >&2
      MISSING=1
    fi
  done
  if [ "$MISSING" -ne 0 ]; then
    echo "  (nothing was linted — this is NOT a pass)" >&2
    exit 2
  fi
fi

set +e
vale --config="$CONFIG" --minAlertLevel=suggestion "$@"
VALE_STATUS=$?
set -e

# Suppressions are legitimate — a quotation cannot be rewritten to satisfy a linter.
# They are also the only way this style learns it is too aggressive, and a suppression
# nobody can see teaches nobody anything. So print every one, and name the ones carrying no
# reason. This REPORTS, it never fails: a second gate on the escape hatch from the first
# gate is how writers end up mangling prose to keep a linter quiet.
SUPPRESSIONS="$(grep -Hn -- '<!--[[:space:]]*vale[[:space:]]' "$@" 2>/dev/null \
                | grep -viE '=[[:space:]]*YES[[:space:]]*-->[[:space:]]*$' || true)"

if [ -n "$SUPPRESSIONS" ]; then
  echo
  echo "Rules switched off in this text — each needs a reason on the same line:"
  while IFS= read -r line; do
    # A reason is any prose left on the line once the directive itself is removed.
    remainder="$(sed -E 's/<!--[[:space:]]*vale[^>]*-->//g; s/[[:space:]]+//g' <<<"${line#*:*:}")"
    if [ -z "$remainder" ]; then
      echo "  NO REASON GIVEN  $line"
    else
      echo "  $line"
    fi
  done <<<"$SUPPRESSIONS"
  echo
  echo "  Turning the same rule off repeatedly means the RULE is wrong. Narrow it or drop it"
  echo "  to 'warning', then re-run $HERE/vale/test.sh."
fi

exit "$VALE_STATUS"
