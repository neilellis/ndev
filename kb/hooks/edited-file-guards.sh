#!/usr/bin/env bash
# edited-file-guards.sh — run the single-file guards on the file that the agent just wrote.
#
# WHAT IT GUARDS
#   An earlier copy of checks that CI runs, so a defect shows the moment the file
#   is written, not minutes later in CI. It removes no CI check. If it does not
#   run, CI catches the same defect.
#
#   Blocking (CI runs the same rules):
#     ast-grep scan   every structural rule; each rule carries its own file globs
#     ruff check      Python lint, the same pass as the project's type-check script
#   Advice only (CI does not run them, so they must never refuse what CI accepts):
#     oxlint          a second opinion on JavaScript and TypeScript
#     ty              a second opinion on Python types
#   Add or remove a tool to match what your CI guards job runs.
#
#   Exit 2 is how a PostToolUse hook returns stderr to the model. The edit has
#   already happened, so the message tells the model to fix the file.
#   When the hook cannot run at all (no jq, no file path), it says on stderr
#   that no guard ran, and exits 0. Silence means: judged, and nothing found.
#   It never autofixes, and it removes the tools' "--fix" advice.
#   Each tool is called by its direct binary. A package-manager wrapper
#   (pnpm exec, npx, uv run) can cost 1 to 7 seconds per call.
#
# HOW TO WIRE IT (.claude/settings.json)
#   {
#     "hooks": {
#       "PostToolUse": [
#         { "matcher": "Edit|Write",
#           "hooks": [ { "type": "command",
#                        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/edited-file-guards.sh\"",
#                        "statusMessage": "Running edited-file guards" } ] }
#       ]
#     }
#   }
#
# SETTINGS (environment, optional)
#   EDITED_FILE_GUARDS_VENV   Python virtual environment, relative to the root (.venv if not set)
set -uo pipefail

skipped() {
  printf 'edited-file-guards: no guard ran on this edit. %s\n' "$1" >&2
  exit 0
}

# Read stdin with a shell builtin. On a broken PATH, `cat` is not found and the
# payload reads as empty; a builtin cannot go missing.
payload=""
while IFS= read -r line || [ -n "$line" ]; do
  payload="${payload}${line}"$'\n'
done

[ -n "$payload" ] || skipped 'The hook received no payload on stdin.'
command -v jq >/dev/null 2>&1 || skipped 'jq is not on PATH, so the edited path could not be read.'

file="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
[ -n "$file" ] || skipped 'The payload carried no .tool_input.file_path.'
[ -f "$file" ] || exit 0   # a deleted or moved file has nothing to check

root="${CLAUDE_PROJECT_DIR:-$PWD}"
venv="$root/${EDITED_FILE_GUARDS_VENV:-.venv}"

# Find a tool's direct binary: the project's own copy first, then PATH.
find_tool() {
  local name="$1"; shift
  local candidate
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  command -v "$name" 2>/dev/null || true
}

blocking=""
advisory=""
missing=""
note_blocking() { blocking="${blocking}$1"$'\n'; }
note_advisory() { advisory="${advisory}$1"$'\n'; }
note_missing() { missing="${missing} $1"; }

# --- ast-grep: every file type. Rules carry their own files:/ignores: globs. ---
if [ -f "$root/sgconfig.yml" ]; then
  sg="$(find_tool ast-grep "$root/node_modules/.bin/ast-grep")"
  if [ -n "$sg" ]; then
    if ! out="$(cd "$root" && "$sg" scan "$file" 2>&1)"; then
      note_blocking "$out"
    fi
  else
    note_missing ast-grep
  fi
fi

case "$file" in
  *.py)
    ruff="$(find_tool ruff "$venv/bin/ruff")"
    if [ -n "$ruff" ]; then
      if ! out="$("$ruff" check "$file" 2>&1)"; then
        # Never autofix: an unused-import fix can delete a module's public re-exports.
        note_blocking "$(printf '%s\n' "$out" | grep -v -- '--fix' || true)"
      fi
    else
      note_missing ruff
    fi

    ty="$(find_tool ty "$venv/bin/ty")"
    if [ -n "$ty" ]; then
      if ! out="$("$ty" check "$file" 2>&1)"; then
        note_advisory "$out"
      fi
    fi
    ;;

  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts)
    ox="$(find_tool oxlint "$root/node_modules/.bin/oxlint")"
    if [ -n "$ox" ]; then
      if ! out="$("$ox" "$file" 2>&1)"; then
        note_advisory "$out"
      fi
    fi
    ;;
esac

if [ -n "$missing" ]; then
  printf 'edited-file-guards: these blocking tools are not installed, so they did not check %s:%s. CI still runs them.\n' "$file" "$missing" >&2
fi

if [ -n "$blocking" ]; then
  printf 'The guards refuse %s.\n\n' "$file" >&2
  printf '%s\n' "$blocking" >&2
  if [ -n "$advisory" ]; then
    printf 'Also reported, not blocking:\n%s\n' "$advisory" >&2
  fi
  printf 'Fix the file. Never silence a rule: add a narrow inline ignore with the reason on the same line.\n' >&2
  exit 2
fi

if [ -n "$advisory" ]; then
  printf 'Not blocking, and CI does not run these checks. Judge whether %s needs a change.\n\n' "$file" >&2
  printf '%s\n' "$advisory" >&2
fi

exit 0
