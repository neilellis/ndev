#!/usr/bin/env bash
# Proves the pinned-test half of gates.sh in BOTH directions.
#
# Each case asserts the exit code AND the missing[] entries, because a gate that
# passes for the wrong reason is the failure this file exists to catch. The
# negative cases prove the gate still refuses a tree with no pinned test, does
# not accept another issue's test, and does not count an e2e test as a unit test.
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
GATES="$HERE/gates.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); echo "  ok   — $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL — $1"; }

# A missing script must NOT read as a pass. Without this every assertion below
# is vacuously true when the gate does not exist.
if [ ! -x "$GATES" ]; then
  echo "CANNOT MEASURE: $GATES is missing or not executable. That is not a pass."
  exit 2
fi

# gates.sh reads the pull request body through gh.sh, which calls `gh`. The stub returns a body that
# satisfies gates A and B, so every case below measures the pinned-test gates
# alone. The stub lives first on PATH.
make_stub() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/gh" <<'STUB'
#!/usr/bin/env bash
# gates.sh reads the body through gh.sh pr-read, which runs `gh pr view N --json ...`.
python3 -c 'import json; print(json.dumps({"number": 1, "title": "t", "state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "createdAt": "", "headRefOid": "a", "headRefName": "b", "baseRefName": "main", "url": "u", "author": {"login": "x"}, "mergeCommit": None, "body": "A real plan of record.\n\nTest entry point: `tests/` — the package suite.\n"}))'
STUB
  chmod +x "$dir/gh"
}

# A throwaway repository holding exactly the files a case names.
new_repo() {
  local root; root="$(mktemp -d)"
  git init -q "$root/repo"
  git -C "$root/repo" config user.email t@t.t
  git -C "$root/repo" config user.name t
  local f
  for f in "$@"; do
    mkdir -p "$root/repo/$(dirname "$f")"
    echo "# pinned test" > "$root/repo/$f"
  done
  git -C "$root/repo" add -A
  git -C "$root/repo" commit -qm base
  echo "$root"
}

# Runs gates.sh inside the throwaway repository with the stubbed gh.
run_gates() {
  local repo="$1" issue="$2"
  ( cd "$repo" && GH_REPO=o/r PATH="$STUB_DIR:$PATH" "$GATES" "$issue" HEAD 999 2>&1 )
}

STUB_DIR="$(mktemp -d)/bin"
make_stub "$STUB_DIR"

echo "case 1 — python layout, unit in tests/ and e2e in tests/integration/: must PASS"
R="$(new_repo "tests/test_issue_15_render.py" "tests/integration/test_issue_15_sync.py")"
out="$(run_gates "$R/repo" 15)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 — $out"
grep -q '"pass": true' <<<"$out" && ok "reports pass" || bad "did not report pass — $out"

echo "case 2 — only the UNIT test: must fail naming the e2e gate only"
R="$(new_repo "tests/test_issue_15_render.py")"
out="$(run_gates "$R/repo" 15)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 — $out"
grep -q 'unit-test:' <<<"$out" && bad "unit gate wrongly reported missing — $out" || ok "unit gate satisfied"
grep -q 'e2e-test:' <<<"$out" && ok "e2e gate reported missing" || bad "e2e gate not reported — $out"

echo "case 3 — JS layout, __tests__/issues/ and e2e/issues/: must PASS"
R="$(new_repo "web/__tests__/issues/issue_15_a.test.ts" "web/e2e/issues/issue_15_b.spec.ts")"
out="$(run_gates "$R/repo" 15)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 — $out"

echo "case 4 — no pinned test anywhere: must FAIL naming both gates"
R="$(new_repo "src/render.py")"
out="$(run_gates "$R/repo" 15)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 — $out"
grep -q 'unit-test:' <<<"$out" && ok "unit gate reported missing" || bad "unit gate not reported — $out"
grep -q 'e2e-test:'  <<<"$out" && ok "e2e gate reported missing"  || bad "e2e gate not reported — $out"

echo "case 5 — issue 150's tests must NOT satisfy issue 15"
R="$(new_repo "tests/test_issue_150_other.py" "tests/integration/test_issue_150_other.py")"
out="$(run_gates "$R/repo" 15)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 — $out"
grep -q 'unit-test:' <<<"$out" && ok "unit gate reported missing" || bad "matched another issue — $out"
grep -q 'e2e-test:'  <<<"$out" && ok "e2e gate reported missing"  || bad "matched another issue — $out"

echo "case 6 — only an E2E test: must NOT count as the unit test"
R="$(new_repo "e2e/issues/issue_15_flow.spec.ts")"
out="$(run_gates "$R/repo" 15)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 — $out"
grep -q 'unit-test:' <<<"$out" && ok "unit gate reported missing" || bad "e2e file counted as unit — $out"

echo "case 7 — GATES_UNIT_RE / GATES_E2E_RE override the layout"
R="$(new_repo "spec/unit/pin_15.rb" "spec/system/pin_15.rb")"
out="$(cd "$R/repo" && GH_REPO=o/r GATES_UNIT_RE='^spec/unit/pin_{n}\.rb$' GATES_E2E_RE='^spec/system/pin_{n}\.rb$' PATH="$STUB_DIR:$PATH" "$GATES" 15 HEAD 999 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 — $out"

echo "case 8 — an unreadable ref must exit 2, never pass"
R="$(new_repo "tests/test_issue_15_render.py" "tests/integration/test_issue_15_sync.py")"
out="$(cd "$R/repo" && GH_REPO=o/r PATH="$STUB_DIR:$PATH" "$GATES" 15 no-such-ref 999 2>&1)"; rc=$?
[ "$rc" = 2 ] && ok "exit 2" || bad "exit $rc, expected 2 — $out"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
