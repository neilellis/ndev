#!/usr/bin/env bash
# Proves orca-shot.sh against a fake `orca` on PATH. The fake answers like Orca
# 1.4: JSON with "ok", exit 1 on a failed command.
#
# Each failure case also proves that no screenshot file is left behind: a stale
# PNG from an earlier run must never pass as evidence.
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
SHOT="$HERE/orca-shot.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); echo "  ok   — $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL — $1"; }

if [ ! -x "$SHOT" ]; then
  echo "CANNOT MEASURE: $SHOT is missing or not executable. That is not a pass."
  exit 2
fi

# A 1x1 PNG.
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

# A throwaway folder with a fake `orca`. FAKE_* variables choose its answers;
# each call is appended to calls.log.
new_env() {
  local root; root="$(mktemp -d)"
  mkdir -p "$root/bin"; : > "$root/calls.log"
  cat > "$root/bin/orca" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$root/calls.log"
fail() { printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' "\$1" "\$2"; exit 1; }
case "\$1" in
  status)
    printf '{"ok":true,"result":{"runtime":{"reachable":%s}}}\n' "\${FAKE_REACHABLE:-true}" ;;
  tab)
    printf '{"ok":true,"result":{"browserPageId":"new-page"}}\n' ;;
  goto)
    [ "\${FAKE_GOTO:-ok}" = ok ] || fail browser_tab_not_found "Browser page p1 was not found"
    printf '{"ok":true,"result":{"url":"u","title":"t"}}\n' ;;
  wait|viewport)
    printf '{"ok":true,"result":{}}\n' ;;
  eval)
    printf '{"ok":true,"result":{"result":"%s"}}\n' "\${FAKE_WIDTH:-390}" ;;
  screenshot)
    [ "\${FAKE_SHOT:-ok}" = ok ] || fail browser_host_unavailable "The desktop is offline"
    printf '{"ok":true,"result":{"data":"%s"}}\n' "$PNG_B64" ;;
  *) fail unknown "unexpected \$1" ;;
esac
EOF
  chmod +x "$root/bin/orca"
  echo "$root"
}

# Runs the helper with only the fake orca and the system tools on PATH.
run() { local root="$1"; shift; PATH="$root/bin:/usr/bin:/bin" "$SHOT" "$@" 2>&1; }

echo "case 1 — no orca on PATH: exit 3, names the repair"
R="$(new_env)"; rm "$R/bin/orca"
out="$(run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 3 ] && ok "exit 3" || bad "exit $rc, expected 3 ($out)"
grep -q "orca open" <<<"$out" && ok "names orca open" || bad "no repair in: $out"
[ ! -e "$R/o.png" ] && ok "no file" || bad "file written"

echo "case 2 — Orca not reachable: exit 3, names orca open"
R="$(new_env)"
out="$(FAKE_REACHABLE=false run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 3 ] && ok "exit 3" || bad "exit $rc, expected 3 ($out)"
grep -q "orca open" <<<"$out" && ok "names orca open" || bad "no repair in: $out"
[ ! -e "$R/o.png" ] && ok "no file" || bad "file written"

echo "case 3 — no --page: a new tab, PNG written, page id printed"
R="$(new_env)"
out="$(run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
grep -q "tab create --url https://x.test" "$R/calls.log" && ok "tab created" || bad "no tab create: $(cat "$R/calls.log")"
[ "$(head -c 4 "$R/o.png" | od -An -c | tr -d ' ')" = "211PNG" ] && ok "PNG written" || bad "not a PNG"
grep -q "page=new-page" <<<"$out" && ok "prints page id" || bad "no page id in: $out"

echo "case 4 — --page: navigates that tab, creates none"
R="$(new_env)"
out="$(run "$R" https://x.test "$R/o.png" --page p1)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
grep -q "goto --url https://x.test --page p1" "$R/calls.log" && ok "goto on p1" || bad "no goto: $(cat "$R/calls.log")"
grep -q "^tab create" "$R/calls.log" && bad "created a tab" || ok "no new tab"

echo "case 5 — --page not found: exit 1, names orca tab list"
R="$(new_env)"
out="$(FAKE_GOTO=missing run "$R" https://x.test "$R/o.png" --page p1)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "browser_tab_not_found" <<<"$out" && ok "names the error code" || bad "no code in: $out"
grep -q "orca tab list" <<<"$out" && ok "names the repair" || bad "no repair in: $out"
[ ! -e "$R/o.png" ] && ok "no file" || bad "file written"

echo "case 6 — viewport ignored (innerWidth differs): exit 1, no file"
R="$(new_env)"
out="$(FAKE_WIDTH=1200 run "$R" https://x.test "$R/o.png" --viewport 390x844)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "innerWidth" <<<"$out" && ok "names innerWidth" || bad "no detail in: $out"
[ ! -e "$R/o.png" ] && ok "no file" || bad "file written"

echo "case 7 — viewport honoured: exit 0"
R="$(new_env)"
out="$(FAKE_WIDTH=390 run "$R" https://x.test "$R/o.png" --viewport 390x844)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
grep -q "viewport --width 390 --height 844" "$R/calls.log" && ok "viewport set" || bad "no viewport: $(cat "$R/calls.log")"

echo "case 8 — screenshot fails: exit 1, earlier file removed"
R="$(new_env)"; echo stale > "$R/o.png"
out="$(FAKE_SHOT=fail run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "browser_host_unavailable" <<<"$out" && ok "names the error code" || bad "no code in: $out"
[ ! -e "$R/o.png" ] && ok "stale file removed" || bad "stale file left"

echo "case 9 — bad arguments: exit 2"
R="$(new_env)"
out="$(run "$R" https://x.test)"; rc=$?
[ "$rc" = 2 ] && ok "missing out: exit 2" || bad "exit $rc, expected 2 ($out)"
out="$(run "$R" https://x.test "$R/o.png" --viewport wide)"; rc=$?
[ "$rc" = 2 ] && ok "bad viewport: exit 2" || bad "exit $rc, expected 2 ($out)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = 0 ]
