#!/usr/bin/env bash
# find.sh — structural code search that refuses to report a false zero.
#
# Usage: find.sh '<pattern>' [ast-grep flags] [paths...]
#
# Exit: 0 = the search ran and matched. Matches are on stdout.
#       1 = the search ran over N files and matched nothing. The zero is real.
#       2 = the search did NOT run. NEVER a pass, and never "nothing uses it".
#
# WHY THIS EXISTS. `ast-grep run` is fail-open in three directions, and each one
# prints an empty result that reads exactly like "this code does not exist":
#
#   1. A pattern that does not parse exits 0 with no matches. A real no-match
#      exits 1. The exit code alone therefore says the opposite of the truth.
#   2. A path that does not exist prints one line on stderr and exits 1 —
#      indistinguishable by exit code from a genuine no-match.
#   3. A language filter that matches no file scans nothing and exits 1.
#
# This script reads `--inspect summary` (which reports how many files ast-grep
# actually opened) and the parse warning, and turns each of those three states
# into exit 2. A search that did not run is not a search that found nothing.
#
# Use it whenever the result becomes a claim — "nothing calls this", "this
# pattern appears twice". For a quick look while you read code, call ast-grep
# directly; the traps are in ../SKILL.md.
set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "find.sh: no pattern given." >&2
  echo "Usage: find.sh '<pattern>' [ast-grep flags] [paths...]" >&2
  exit 2
fi

pattern="$1"
shift

# RESOLVE THE BINARY, OR REFUSE. A search that silently did not happen is the
# defect this whole script exists to prevent, so a missing binary is exit 2.
# Order: an explicit override, then the version the repo pins, then the PATH.
bin=""
if [ -n "${AST_GREP_BIN:-}" ] && "$AST_GREP_BIN" --version >/dev/null 2>&1; then
  bin="$AST_GREP_BIN"
elif command -v pnpm >/dev/null 2>&1 && pnpm exec ast-grep --version >/dev/null 2>&1; then
  bin="pnpm exec ast-grep"
elif command -v ast-grep >/dev/null 2>&1; then
  bin="ast-grep"
else
  echo "find.sh: ast-grep is not available, so no search ran." >&2
  echo "This is a failure, not an empty result." >&2
  echo "Fix: install ast-grep ('brew install ast-grep', or 'pnpm add -D @ast-grep/cli' then 'pnpm install')," >&2
  echo "or set AST_GREP_BIN to the ast-grep binary." >&2
  exit 2
fi

# NEVER `sg`. On Linux /usr/bin/sg is the util-linux set-group command, not
# ast-grep. It reads the first argument as a group name and fails with a usage
# message, which an unwary caller reads as a search that found nothing.

err="$(mktemp)"
trap 'rm -f "$err"' EXIT

# shellcheck disable=SC2086  # $bin is a resolved command, and may be two words.
$bin run --pattern "$pattern" --inspect summary "$@" 2>"$err"
code=$?

# The summary goes to stderr as `sg: summary|file: scannedFileCount=N,...`.
scanned="$(sed -n 's/.*scannedFileCount=\([0-9][0-9]*\).*/\1/p' "$err" | tail -1)"

# Everything on stderr that is not the inspection summary is a real message.
grep -v '^sg: summary|' "$err" >&2 || true

if grep -q 'ERROR node' "$err"; then
  echo "find.sh: the pattern does not parse, so it matched nothing." >&2
  echo "This is not evidence that the code is absent." >&2
  echo "Fix: rerun with --debug-query=pattern. A root node of ERROR is a broken pattern;" >&2
  echo "a real pattern shows a named node such as function_definition or call." >&2
  exit 2
fi

if [ "$code" -gt 1 ]; then
  echo "find.sh: ast-grep refused the query (exit $code), so no search ran." >&2
  echo "Exit 2 is a bad flag or an unknown --lang. Exit 8 is a pattern the language cannot parse." >&2
  exit 2
fi

if [ -z "$scanned" ] || [ "$scanned" = "0" ]; then
  echo "find.sh: ast-grep opened 0 files, so no search ran." >&2
  echo "This is not evidence that the code is absent." >&2
  echo "Causes: a path that does not exist, a --lang that matches no file here," >&2
  echo "or a .gitignore rule. Check the path, then drop --lang, then add --no-ignore vcs." >&2
  exit 2
fi

if [ "$code" = "0" ]; then
  echo "find.sh: matched over $scanned files." >&2
  exit 0
fi

echo "find.sh: no match, over $scanned files searched. The zero is real." >&2
exit 1
