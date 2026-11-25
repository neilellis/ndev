#!/usr/bin/env bash
# precheck-reminder.sh — after a `git commit`, remind the agent to run the precheck before the push.
#
# WHAT IT GUARDS
#   The precheck script is recommended, not forced (the pre-push hook is the
#   forced gate). This hook prints one reminder line after a command that ran
#   `git commit`. It never runs the precheck, never blocks, and always exits 0.
#
#   It fires only when a command RAN `git commit`, not when the words appear in
#   prose:
#     1. Strip every heredoc body (a commit message in a heredoc is not a commit).
#     2. Split the rest into simple commands on &&, ||, ;, | and newlines.
#     3. Skip leading VAR=value tokens. The first token's basename must be `git`.
#     4. Skip git's global options (consuming the value of -C and -c). The next
#        token must be exactly `commit`.
#
# HOW TO WIRE IT (.claude/settings.json)
#   {
#     "hooks": {
#       "PostToolUse": [
#         { "matcher": "Bash",
#           "hooks": [ { "type": "command",
#                        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/precheck-reminder.sh\"",
#                        "statusMessage": "Checking for a commit" } ] }
#       ]
#     }
#   }
#
# SETTINGS (environment, optional)
#   PRECHECK_COMMAND  the command named in the reminder (./scripts/precheck.sh if not set)
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -n "$command" ] || exit 0

strip_heredocs() {
  awk '
    BEGIN { in_heredoc = 0; tag = ""; strip_tabs = 0 }
    {
      if (in_heredoc) {
        line = $0
        if (strip_tabs) { sub(/^\t+/, "", line) }
        if (line == tag) { in_heredoc = 0; tag = "" }
        next
      }
      print
      if (match($0, /<<-?["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/)) {
        m = substr($0, RSTART, RLENGTH)
        strip_tabs = (substr(m, 1, 3) == "<<-") ? 1 : 0
        gsub(/^<<-?/, "", m)
        gsub(/["'"'"']/, "", m)
        tag = m
        in_heredoc = 1
      }
    }
  '
}

stripped="$(printf '%s\n' "$command" | strip_heredocs)"
simple_commands="$(printf '%s' "$stripped" | sed -E 's/(&&|\|\||[;|])/\n/g')"

is_commit=0
while IFS= read -r simple; do
  # shellcheck disable=SC2206  # deliberate word split into argument tokens
  tokens=($simple)
  n=${#tokens[@]}
  [ "$n" -gt 0 ] || continue

  i=0
  while [ "$i" -lt "$n" ]; do
    case "${tokens[$i]}" in
      [A-Za-z_][A-Za-z0-9_]*=*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [ "$i" -lt "$n" ] || continue

  first="${tokens[$i]}"
  [ "${first##*/}" = "git" ] || continue
  i=$((i + 1))

  while [ "$i" -lt "$n" ]; do
    case "${tokens[$i]}" in
      -C|-c) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [ "$i" -lt "$n" ] || continue
  [ "${tokens[$i]}" = "commit" ] || continue

  is_commit=1
  break
done <<EOF_SIMPLE
$simple_commands
EOF_SIMPLE

[ "$is_commit" = "1" ] || exit 0

printf 'Reminder: run %s before you push (recommended, not forced).\n' "${PRECHECK_COMMAND:-./scripts/precheck.sh}" >&2
exit 0
