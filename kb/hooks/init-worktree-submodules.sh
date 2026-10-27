#!/usr/bin/env bash
# init-worktree-submodules.sh — initialise the submodules of a new worktree after `git worktree add`.
#
# WHAT IT GUARDS
#   A new worktree has empty submodule folders. A project that keeps shared
#   agent files (for example .claude/agents) in a submodule then runs with no
#   agents in that worktree, and nothing says so. After a Bash command that ran
#   `git worktree add`, this hook reads the new path and, only when a listed
#   submodule folder is empty, runs `git submodule update --init` for it. It
#   pins the recorded commit (no --remote), touches only the new worktree, and
#   never sweeps other worktrees.
#   It is best effort: it always exits 0, and it says on stderr when an update
#   failed, with the command to run by hand.
#   Worktrees made through Orca do not pass through this hook. Run the same
#   `git submodule update --init` in Orca's worktree set-up step.
#
# HOW TO WIRE IT (.claude/settings.json)
#   {
#     "hooks": {
#       "PostToolUse": [
#         { "matcher": "Bash",
#           "hooks": [ { "type": "command", "async": true,
#                        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/init-worktree-submodules.sh\"",
#                        "statusMessage": "Initialising worktree submodules" } ] }
#       ]
#     }
#   }
#
# SETTINGS (environment, optional)
#   WORKTREE_SUBMODULES  space-separated submodule paths to initialise
#                        (.claude/agents if not set)
set -u

payload="$(cat 2>/dev/null || true)"
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
case "$cmd" in
  *"git worktree add"*) ;;
  *) exit 0 ;;
esac

cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -n "$cwd" ] || cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

# The first operand after `worktree add` that is not an option is the path.
# The values of -b and -B are branch names, not paths.
target="$(printf '%s\n' "$cmd" | awk '
  {
    for (i = 1; i < NF; i++) {
      if ($i == "worktree" && $(i+1) == "add") {
        skip = 0
        for (j = i + 2; j <= NF; j++) {
          tok = $j
          if (skip) { skip = 0; continue }
          if (tok == "-b" || tok == "-B") { skip = 1; continue }
          if (substr(tok, 1, 1) == "-") continue
          print tok
          exit
        }
      }
    }
  }')"
[ -n "$target" ] || exit 0

target="${target%\"}"; target="${target#\"}"
target="${target%\'}"; target="${target#\'}"
case "$target" in
  /*) ;;
  *) target="$cwd/$target" ;;
esac
[ -d "$target" ] || exit 0

for submodule in ${WORKTREE_SUBMODULES:-.claude/agents}; do
  [ -d "$target/$submodule" ] || continue
  [ -z "$(ls -A "$target/$submodule" 2>/dev/null)" ] || continue
  if ! out="$(cd "$target" && git submodule update --init -- "$submodule" 2>&1)"; then
    printf 'init-worktree-submodules: could not initialise %s in %s: %s\nRun by hand: git -C %s submodule update --init -- %s\n' \
      "$submodule" "$target" "$out" "$target" "$submodule" >&2
  fi
done

exit 0
