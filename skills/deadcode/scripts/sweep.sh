#!/usr/bin/env bash
# Report the dead Python code THIS BRANCH created, not the dead code the repo already had.
#
# Usage: sweep.sh [--base REF] ROOT [ROOT...]
#        ROOT is a directory relative to the repository root. Pass every root that
#        holds Python source AND every root that holds a consumer of it (scripts,
#        drivers, tests that import it). Default REF = origin/HEAD, else origin/main.
# Exit:  0 = this branch added no dead code
#        1 = this branch added dead code (listed on stdout — triage every line)
#        2 = could not measure. NEVER a pass.
#
# ⚠️ A ROOT THAT IS MISSING IS A FALSE-POSITIVE GENERATOR, because the callers that
# live in it disappear. A library scanned without the scripts that import it reports
# its live exports as dead. Scan all roots together, in ONE invocation. Before you
# trust a run, check that nothing importing the scanned packages sits outside the
# roots:  rg -l 'import <package>' --type py | grep -v -e <root1> -e <root2>
set -uo pipefail

BASE=""
ROOTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || { echo "sweep.sh: --base needs a ref." >&2; exit 2; }
            BASE="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) ROOTS+=("$1"); shift ;;
  esac
done

if [ "${#ROOTS[@]}" -eq 0 ]; then
  echo "sweep.sh: no root given, so nothing would be scanned." >&2
  echo "Usage: sweep.sh [--base REF] ROOT [ROOT...]   e.g. sweep.sh src scripts tests" >&2
  exit 2
fi

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "sweep.sh: not in a git repository. Run it from inside the checkout to scan." >&2; exit 2; }
cd "$REPO" || exit 2

for root in "${ROOTS[@]}"; do
  if [ ! -d "$root" ]; then
    echo "sweep.sh: root '$root' does not exist under $REPO. A missing root hides callers," >&2
    echo "  so the scan would report live names as dead. Fix the path and run again." >&2
    exit 2
  fi
done

if [ -z "$BASE" ]; then
  BASE="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)" || BASE="origin/main"
fi

command -v uv >/dev/null 2>&1 || {
  echo "sweep.sh: uv is not installed. Fix: brew install uv (or pipx install uv)" >&2; exit 2; }

scan() {  # scan <checkout-dir> <label> -> sorted "DCnn name path" lines
  local status
  local tick=$'\x60'
  ( cd "$1" && uv run --with deadcode deadcode "${ROOTS[@]}" ) \
    > "$TMP/$2.raw" 2> "$TMP/$2.err"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "sweep.sh: deadcode scan at $2 exited $status; no comparison was made." >&2
    echo "  A root that is absent at the base also fails here; pass only roots present at both." >&2
    sed 's/^/  deadcode: /' "$TMP/$2.err" >&2
    return 2
  fi
  sed 's/\x1b\[[0-9;]*m//g' "$TMP/$2.raw" > "$TMP/$2.plain"
  sed -nE "s/^([^:]+):([0-9]+):[0-9]+: (DC[0-9]+) [A-Za-z ]*${tick}([^${tick}]+)${tick}.*/\3 \4 \1/p" \
    "$TMP/$2.plain" | sort -u
  # Zero parsed findings is real only when deadcode says so ("Well done!"). Any other
  # output that parses to nothing means the output format changed, and the zero is false.
  if ! grep -qE ': DC[0-9]+ ' "$TMP/$2.plain" && ! grep -q 'Well done' "$TMP/$2.plain"; then
    echo "sweep.sh: deadcode output at $2 holds no finding and no clean verdict." >&2
    echo "  The output format may have changed; the parse below would report a false zero." >&2
    sed 's/^/  deadcode: /' "$TMP/$2.plain" | head -20 >&2
    return 2
  fi
}

MERGE_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null)" || {
  echo "sweep.sh: no merge base with $BASE. Fix: git fetch origin, or pass --base <ref>." >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'git worktree remove --force "$TMP/base" >/dev/null 2>&1; rm -rf "$TMP"' EXIT

scan "$REPO" HEAD > "$TMP/head.txt" || exit 2

git worktree add --detach "$TMP/base" "$MERGE_BASE" >/dev/null 2>&1 || {
  echo "sweep.sh: could not check out the merge base $MERGE_BASE." >&2; exit 2; }
scan "$TMP/base" base > "$TMP/base.txt" || exit 2

# Key on "code + name" only. A line number moves whenever the file above it changes,
# so keying on the location reports every shifted line as new.
cut -d' ' -f1,2 "$TMP/base.txt" | sort -u > "$TMP/base.keys"
# ⚠️ An empty first file breaks awk's NR==FNR idiom (it loads the head as keys and
# prints nothing), so a clean base is handled on its own: every head finding is new.
if [ -s "$TMP/base.keys" ]; then
  NEW="$(awk 'NR==FNR{k[$0];next} !(($1" "$2) in k)' "$TMP/base.keys" "$TMP/head.txt")"
else
  NEW="$(cat "$TMP/head.txt")"
fi

BASE_N=$(wc -l < "$TMP/base.txt" | tr -d ' ')
HEAD_N=$(wc -l < "$TMP/head.txt" | tr -d ' ')

echo "### Dead code sweep"
echo
echo "\`deadcode\` over $(IFS=' '; echo "${ROOTS[*]}"), against \`$BASE\` (\`${MERGE_BASE:0:9}\`)."
echo "Whole repo: **$BASE_N** distinct dead names at the base, **$HEAD_N** at this branch's head."
echo "(Distinct name per file. \`deadcode\` counts each declaration, so its own total is higher.)"
echo
if [ -z "$NEW" ]; then
  # Name the base count in the same sentence. Exit 0 has two meanings and the
  # code cannot tell them apart: this branch added nothing, and this branch is a
  # deletion branch whose findings all existed at the base. The reader can tell
  # them apart only if both numbers are in front of them.
  echo "**This branch introduced no unused Python name.**"
  echo
  echo "That is not the same as a clean repository, and it is not evidence of a deletion."
  echo "$BASE_N name(s) were already dead at the base and $HEAD_N are dead now. A branch whose"
  echo "purpose is deletion moves that second number down and still reports nothing new here."
  exit 0
fi
NEW_N=$(printf '%s\n' "$NEW" | wc -l | tr -d ' ')
echo "**This branch introduced $NEW_N unused Python name(s).** Triage every one."
echo
echo '| Code | Name | File |'
echo '|---|---|---|'
printf '%s\n' "$NEW" | awk '{printf "| %s | `%s` | `%s` |\n", $1, $2, $3}'
exit 1
