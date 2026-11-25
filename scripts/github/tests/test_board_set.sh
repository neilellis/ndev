#!/usr/bin/env bash
# Proves `gh.sh board fields`, `board set` for every board field type, and `issue-new`'s
# number, milestone, assignee and type, against a stub `gh` first on PATH.
#
# Each case asserts the exit code AND what reached gh (or the error text), because a set that
# exits 0 without editing the item is the failure this file exists to catch.
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
GHSH="$HERE/gh.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); echo "  ok   — $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL — $1"; }

# A missing script must NOT read as a pass.
if [ ! -x "$GHSH" ]; then
  echo "CANNOT MEASURE: $GHSH is missing or not executable. That is not a pass."
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LOG="$TMP/gh.log"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_LOG"
case "$1 $2" in
  "project view") echo PVT_1 ;;
  "project item-edit") echo '{}' ;;
  "api graphql") cat <<'JSON'
{"data":{"node":{"fields":{"nodes":[
 {"id":"F_title","name":"Title","dataType":"TITLE"},
 {"id":"F_status","name":"Status","dataType":"SINGLE_SELECT","options":[{"id":"O_back","name":"Backlog"},{"id":"O_ready","name":"Ready"}]},
 {"id":"F_prio","name":"Priority","dataType":"SINGLE_SELECT","options":[{"id":"O_p1","name":"P1"},{"id":"O_p2","name":"P2"}]},
 {"id":"F_est","name":"Estimate","dataType":"NUMBER"},
 {"id":"F_note","name":"Notes","dataType":"TEXT"},
 {"id":"F_due","name":"Due","dataType":"DATE"},
 {"id":"F_iter","name":"Sprint","dataType":"ITERATION","configuration":{"iterations":[{"id":"I_7","title":"Sprint 7","startDate":"2026-10-20"}]}}
]}}}}
JSON
  ;;
  "api -X") echo "https://github.com/acme/app/issues/42" ;;  # gh.sh asks for --jq .html_url
  *) echo "stub gh: unexpected: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$TMP/bin/gh"

run() {
  : >"$LOG"
  (cd "$TMP" && PATH="$TMP/bin:$PATH" GH_STUB_LOG="$LOG" GH_REPO=acme/app \
    GH_PROJECT_OWNER=acme GH_PROJECT_NUMBER=3 "$GHSH" "$@") >"$TMP/out" 2>"$TMP/err"
}

expect_edit() { # <name> <expected gh item-edit tail>
  if [ "$code" -eq 0 ] && grep -qF -- "project item-edit --id PVTI_1 --project-id PVT_1 $2" "$LOG"; then ok "$1"
  else bad "$1 (exit $code; gh saw: $(grep item-edit "$LOG"); err: $(cat "$TMP/err"))"; fi
}

run board set PVTI_1 priority p1; code=$?
expect_edit "single-select by name, case-insensitive" "--field-id F_prio --single-select-option-id O_p1"

run board move PVTI_1 Backlog; code=$?
expect_edit "move sets Status" "--field-id F_status --single-select-option-id O_back"

run board set PVTI_1 Estimate 3; code=$?
expect_edit "number field" "--field-id F_est --number 3"

run board set PVTI_1 Notes "needs design"; code=$?
expect_edit "text field" "--field-id F_note --text needs design"

run board set PVTI_1 Due 2026-11-01; code=$?
expect_edit "date field" "--field-id F_due --date 2026-11-01"

run board set PVTI_1 Sprint "sprint 7"; code=$?
expect_edit "iteration by title" "--field-id F_iter --iteration-id I_7"

run board set PVTI_1 Priority P9; code=$?
if [ "$code" -ne 0 ] && grep -q "has no option 'P9'" "$TMP/err" && grep -q "P1" "$TMP/err" && ! grep -q item-edit "$LOG"; then
  ok "unknown option refused, options listed, nothing edited"
else bad "unknown option (exit $code; err: $(cat "$TMP/err"))"; fi

run board set PVTI_1 Size L; code=$?
if [ "$code" -ne 0 ] && grep -q "no field 'Size'" "$TMP/err" && grep -q "Estimate" "$TMP/err"; then
  ok "unknown field refused, fields listed"
else bad "unknown field (exit $code; err: $(cat "$TMP/err"))"; fi

run board set PVTI_1 Estimate lots; code=$?
if [ "$code" -ne 0 ] && grep -q "not a number" "$TMP/err" && ! grep -q item-edit "$LOG"; then ok "bad number refused"
else bad "bad number (exit $code; err: $(cat "$TMP/err"))"; fi

run board set PVTI_1 Due tomorrow; code=$?
if [ "$code" -ne 0 ] && grep -q "YYYY-MM-DD" "$TMP/err" && ! grep -q item-edit "$LOG"; then ok "bad date refused"
else bad "bad date (exit $code; err: $(cat "$TMP/err"))"; fi

run board set PVTI_1 Title x; code=$?
if [ "$code" -ne 0 ] && grep -q "set it on the issue" "$TMP/err"; then ok "issue-owned field refused with the repair"
else bad "issue-owned field (exit $code; err: $(cat "$TMP/err"))"; fi

run board fields; code=$?
if [ "$code" -eq 0 ] && grep -q '"name":"Priority","type":"SINGLE_SELECT","options":\["P1","P2"\]' "$TMP/out" \
   && grep -q '"name":"Sprint","type":"ITERATION","options":\["Sprint 7"\]' "$TMP/out"; then ok "board fields lists types and options"
else bad "board fields (exit $code; out: $(cat "$TMP/out"); err: $(cat "$TMP/err"))"; fi

printf 'Impact first.\n' >"$TMP/body.md"
run issue-new --title T --body-file "$TMP/body.md" --label bug --assignee neil --milestone 4 --type Bug; code=$?
if [ "$code" -eq 0 ] && grep -q '"number":42' "$TMP/out" \
   && grep -q -- "-f labels\[\]=bug" "$LOG" && grep -q -- "-f assignees\[\]=neil" "$LOG" \
   && grep -q -- "-F milestone=4" "$LOG" && grep -q -- "-f type=Bug" "$LOG"; then ok "issue-new sends label, assignee, milestone, type and prints the number"
else bad "issue-new (exit $code; out: $(cat "$TMP/out"); gh saw: $(cat "$LOG"); err: $(cat "$TMP/err"))"; fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
