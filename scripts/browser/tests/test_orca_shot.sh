#!/usr/bin/env bash
# Proves orca-shot.sh against a fake `orca` on PATH. The fake answers like Orca
# 1.4: JSON with "ok", exit 1 on a failed command, and `screenshot` saves a file
# and answers with its path.
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
    if [ "\$2" = close ]; then
      [ "\${FAKE_CLOSE:-ok}" != warn ] || echo "a warning on stderr" >&2
      [ "\${FAKE_CLOSE:-ok}" != fail ] || fail browser_host_unavailable "The tab did not close"
      printf '{"ok":true,"result":{}}\n'
    elif [ "\${FAKE_TAB:-ok}" = ok ]; then
      printf '{"ok":true,"result":{"browserPageId":"new-page"}}\n'
    else
      printf '{"ok":true,"result":{}}\n'
    fi ;;
  goto)
    [ "\${FAKE_GOTO:-ok}" = ok ] || fail browser_tab_not_found "Browser page p1 was not found"
    printf '{"ok":true,"result":{"url":"u","title":"t"}}\n' ;;
  wait|viewport)
    printf '{"ok":true,"result":{}}\n' ;;
  eval)
    printf '{"ok":true,"result":{"result":"%s"}}\n' "\${FAKE_WIDTH:-390}" ;;
  screenshot)
    [ "\${FAKE_SHOT:-ok}" != fail ] || fail browser_host_unavailable "The desktop is offline"
    [ "\${FAKE_SHOT:-ok}" != nopath ] || { printf '{"ok":true,"result":{"format":"png"}}\n'; exit 0; }
    if [ "\${FAKE_SHOT:-ok}" = text ]; then
      echo hello > "$root/shot.png"
    else
      base64 -D <<<"$PNG_B64" > "$root/shot.png"
    fi
    echo "a warning on stderr" >&2
    printf '{"ok":true,"result":{"format":"png","path":"%s"}}\n' "$root/shot.png" ;;
  *) fail unknown "unexpected \$1" ;;
esac
EOF
  chmod +x "$root/bin/orca"
  echo "$root"
}

# Runs the helper with only the fake orca and the system tools on PATH.
run() { local root="$1"; shift; PATH="$root/bin:/usr/bin:/bin" "$SHOT" "$@" 2>&1; }

echo "case 1 — no orca on PATH: exit 3, names the repair"
R="$(new_env)"; rm "$R/bin/orca"; echo stale > "$R/o.png"
out="$(run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 3 ] && ok "exit 3" || bad "exit $rc, expected 3 ($out)"
grep -q "orca open" <<<"$out" && ok "names orca open" || bad "no repair in: $out"
[ ! -e "$R/o.png" ] && ok "stale file removed" || bad "stale file left"

echo "case 2 — Orca not reachable: exit 3, names orca open"
R="$(new_env)"; echo stale > "$R/o.png"
out="$(FAKE_REACHABLE=false run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 3 ] && ok "exit 3" || bad "exit $rc, expected 3 ($out)"
grep -q "orca open" <<<"$out" && ok "names orca open" || bad "no repair in: $out"
[ ! -e "$R/o.png" ] && ok "stale file removed" || bad "stale file left"

echo "case 3 — no --page: a new tab, PNG written, the tab closed"
R="$(new_env)"
out="$(run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
grep -q "tab create --url https://x.test" "$R/calls.log" && ok "tab created" || bad "no tab create: $(cat "$R/calls.log")"
[ "$(head -c 4 "$R/o.png" | od -An -c | tr -d ' ')" = "211PNG" ] && ok "PNG written" || bad "not a PNG"
grep -q "page=new-page" <<<"$out" && ok "prints page id" || bad "no page id in: $out"
grep -q "^tab close --page new-page" "$R/calls.log" && ok "tab closed" || bad "tab left open: $(cat "$R/calls.log")"
grep -q "tab=closed" <<<"$out" && ok "says closed" || bad "no tab state in: $out"

echo "case 4 — --page: navigates that tab, creates none"
R="$(new_env)"
out="$(run "$R" https://x.test "$R/o.png" --page p1)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
grep -q "goto --url https://x.test --page p1" "$R/calls.log" && ok "goto on p1" || bad "no goto: $(cat "$R/calls.log")"
grep -q "^tab create" "$R/calls.log" && bad "created a tab" || ok "no new tab"
grep -q "^tab close" "$R/calls.log" && bad "closed the caller's tab" || ok "the caller's tab stays"

echo "case 5 — --page not found: exit 1, names orca tab list"
R="$(new_env)"; echo stale > "$R/o.png"
out="$(FAKE_GOTO=missing run "$R" https://x.test "$R/o.png" --page p1)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "browser_tab_not_found" <<<"$out" && ok "names the error code" || bad "no code in: $out"
grep -q "orca tab list" <<<"$out" && ok "names the repair" || bad "no repair in: $out"
[ ! -e "$R/o.png" ] && ok "stale file removed" || bad "stale file left"

echo "case 6 — viewport ignored (innerWidth differs): exit 1, no file"
R="$(new_env)"; echo stale > "$R/o.png"
out="$(FAKE_WIDTH=1200 run "$R" https://x.test "$R/o.png" --viewport 390x844)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "innerWidth" <<<"$out" && ok "names innerWidth" || bad "no detail in: $out"
[ ! -e "$R/o.png" ] && ok "stale file removed" || bad "stale file left"

echo "case 7 — viewport honoured: exit 0"
R="$(new_env)"
out="$(FAKE_WIDTH=390 run "$R" https://x.test "$R/o.png" --viewport 390x844)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
grep -q "viewport --width 390 --height 844" "$R/calls.log" && ok "viewport set" || bad "no viewport: $(cat "$R/calls.log")"
# A page load resets the viewport, so it must come after the load wait.
order="$(grep -n -E '^(wait --load|viewport)' "$R/calls.log" | cut -d' ' -f1 | tr '\n' ' ')"
[ "$order" = "3:wait 4:viewport " ] && ok "viewport after the load" || bad "order: $order"

echo "case 8 — screenshot fails: exit 1, earlier file removed"
R="$(new_env)"; echo stale > "$R/o.png"
out="$(FAKE_SHOT=fail run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "browser_host_unavailable" <<<"$out" && ok "names the error code" || bad "no code in: $out"
[ ! -e "$R/o.png" ] && ok "stale file removed" || bad "stale file left"

echo "case 9 — screenshot data is not a PNG: exit 1, no file"
R="$(new_env)"; echo stale > "$R/o.png"
out="$(FAKE_SHOT=text run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "not a PNG" <<<"$out" && ok "says not a PNG" || bad "no detail in: $out"
[ ! -e "$R/o.png" ] && ok "stale file removed" || bad "stale file left"

echo "case 10 — tab create gives no page id: exit 1"
R="$(new_env)"
out="$(FAKE_TAB=noid run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "browserPageId" <<<"$out" && ok "names browserPageId" || bad "no detail in: $out"

echo "case 12 — the opened tab closes on each failure, as the caller never gets its id"
for fake in FAKE_SHOT=fail FAKE_SHOT=text FAKE_SHOT=nopath FAKE_WIDTH=1200; do
  R="$(new_env)"
  out="$(env "$fake" PATH="$R/bin:/usr/bin:/bin" "$SHOT" https://x.test "$R/o.png" --viewport 390x844 --keep-tab 2>&1)"; rc=$?
  [ "$rc" = 1 ] && ok "$fake: exit 1" || bad "$fake: exit $rc, expected 1 ($out)"
  grep -q "^tab close --page new-page" "$R/calls.log" && ok "$fake: tab closed" || bad "$fake: tab left open: $(cat "$R/calls.log")"
done

echo "case 13 — a failure on the caller's tab leaves that tab open"
R="$(new_env)"
out="$(FAKE_SHOT=fail run "$R" https://x.test "$R/o.png" --page p1)"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q "^tab close" "$R/calls.log" && bad "closed the caller's tab" || ok "the caller's tab stays"

echo "case 14 — --keep-tab: the new tab stays, and the id is for the next call"
R="$(new_env)"
out="$(run "$R" https://x.test "$R/o.png" --keep-tab)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
grep -q "^tab close" "$R/calls.log" && bad "closed a kept tab" || ok "tab kept"
grep -q "page=new-page.*tab=kept" <<<"$out" && ok "says kept" || bad "no tab state in: $out"
grep -q "orca tab close --page new-page" <<<"$out" && ok "names how to close it" || bad "no close command in: $out"

echo "case 15 — the tab does not close: the PNG stands, and the repair is named"
R="$(new_env)"
out="$(FAKE_CLOSE=fail run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
[ -s "$R/o.png" ] && ok "PNG kept" || bad "PNG lost"
grep -q "Repair: orca tab close --page new-page" <<<"$out" && ok "names the repair" || bad "no repair in: $out"
grep -q "tab=open" <<<"$out" && ok "says open" || bad "no tab state in: $out"

echo "case 17 — a warning on stderr does not make a closed tab look open"
R="$(new_env)"
out="$(FAKE_CLOSE=warn run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
grep -q "tab=closed" <<<"$out" && ok "says closed" || bad "no closed state in: $out"
grep -q "Repair:" <<<"$out" && bad "needless repair in: $out" || ok "names no repair"

echo "case 16 — Orca gives no file path: exit 1, shows the answer"
R="$(new_env)"; echo stale > "$R/o.png"
out="$(FAKE_SHOT=nopath run "$R" https://x.test "$R/o.png")"; rc=$?
[ "$rc" = 1 ] && ok "exit 1" || bad "exit $rc, expected 1 ($out)"
grep -q 'no file path' <<<"$out" && ok "says no path" || bad "no detail in: $out"
[ ! -e "$R/o.png" ] && ok "stale file removed" || bad "stale file left"

echo "case 11 — bad arguments: exit 2, never hangs"
R="$(new_env)"
out="$(run "$R" https://x.test)"; rc=$?
[ "$rc" = 2 ] && ok "missing out: exit 2" || bad "exit $rc, expected 2 ($out)"
out="$(run "$R" https://x.test "$R/o.png" --viewport wide)"; rc=$?
[ "$rc" = 2 ] && ok "bad viewport: exit 2" || bad "exit $rc, expected 2 ($out)"
# A flag with no value once looped for ever; the timeout turns a hang into a failure.
out="$(PATH="$R/bin:/usr/bin:/bin" perl -e 'alarm 5; exec @ARGV' "$SHOT" https://x.test "$R/o.png" --page 2>&1)"; rc=$?
[ "$rc" = 2 ] && ok "flag without value: exit 2" || bad "exit $rc, expected 2 ($out)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = 0 ]
