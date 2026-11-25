#!/usr/bin/env bash
# warn-subscription-cli.sh — warn the agent before a command that can spend the subscription.
#
# WHAT IT GUARDS
#   Core belief 7: never spend the subscription through `claude -p` without
#   explicit permission. The project puts every headless `claude -p` call behind
#   a gate that refuses unless an environment variable is set, and only the user
#   sets that variable. This hook adds a warning to the model's context when a
#   command mentions that variable or runs `claude -p` / `claude --print`.
#   It warns. It does not block the command, and it always exits 0.
#
# HOW TO WIRE IT (.claude/settings.json)
#   {
#     "hooks": {
#       "PreToolUse": [
#         { "matcher": "Bash",
#           "hooks": [ { "type": "command",
#                        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/warn-subscription-cli.sh\"",
#                        "statusMessage": "Checking for subscription use" } ] }
#       ]
#     }
#   }
#
# SETTINGS (environment, optional)
#   SUBSCRIPTION_GATE_VAR  the gate variable's name (ALLOW_CLAUDE_CLI if not set)
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
[ -n "$payload" ] || exit 0
if ! command -v jq >/dev/null 2>&1; then
  printf 'warn-subscription-cli: jq is not on PATH, so this command was not checked for subscription use.\n' >&2
  exit 0
fi
command="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -n "$command" ] || exit 0

gate="${SUBSCRIPTION_GATE_VAR:-ALLOW_CLAUDE_CLI}"
matched=0
case "$command" in
  *"$gate"*) matched=1 ;;
esac
if printf '%s\n' "$command" | grep -Eq '(^|[;&|[:space:]])claude[[:space:]]+(.*[[:space:]])?(-p|--print)([[:space:]]|$)'; then
  matched=1
fi
[ "$matched" = 1 ] || exit 0

jq -n --arg gate "$gate" '{hookSpecificOutput: {
  hookEventName: "PreToolUse",
  additionalContext: ("WARNING: this command can spend the user'"'"'s subscription (a headless claude run, or the " + $gate + " gate). Confirm that the user gave permission for this exact run before you continue. If no permission covers it, stop and ask the user, and say what will run, how many times and why. This hook warns and does not block.")
}}'
exit 0
