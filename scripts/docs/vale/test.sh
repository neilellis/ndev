#!/usr/bin/env bash
# Mutation-proves the House vale style in BOTH directions (a rule is proven to fire on bad text and to stay quiet on good text).
#
#   bad.md  — one instance of every rule. Every rule MUST fire here.
#   good.md — a worked example of good prose. NOTHING may fire here.
#
# A rule that never fires is decorative. A rule that fires on good.md trains agents to
# ignore the linter, which is worse than no linter — narrow it or delete it.
#
# Run after editing any rule:  vale/test.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

RULES=$(ls styles/House/*.yml | xargs -n1 basename | sed 's/\.yml$//')
FAIL=0

echo "== direction 1: every rule must fire on bad.md =="
OUT=$(vale --config=.vale.ini --output=line testdata/bad.md 2>&1 || true)
for r in $RULES; do
  if grep -q "House.$r" <<<"$OUT"; then
    echo "  ok    $r fires"
  else
    echo "  FAIL  $r never fires — decorative, or its fixture case is missing"; FAIL=1
  fi
done

echo "== direction 2: nothing may fire on good.md =="
if vale --config=.vale.ini testdata/good.md >/dev/null 2>&1; then
  echo "  ok    good.md is clean"
else
  echo "  FAIL  a rule fires on good prose:"; vale --config=.vale.ini testdata/good.md || true; FAIL=1
fi

[ $FAIL -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
