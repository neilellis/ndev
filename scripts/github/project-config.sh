#!/usr/bin/env bash
# Source this file; do not run it. Sets GH_REPO, GH_PROJECT_OWNER and GH_PROJECT_NUMBER from the
# "github" key of the project's .neil-dev.json (saved by the neil-development /dev-setup dialog),
# so no script looks them up again. A value already in the environment wins. A file that cannot
# be read stops the calling script, with the repair.

neil_dev_github() {
  local root file out repo owner number
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  file="$root/.neil-dev.json"
  [ -f "$file" ] || return 0
  if ! out="$(python3 -I -c '
import json, sys
try:
    g = json.load(open(sys.argv[1])).get("github") or {}
except Exception as e:
    sys.exit(f"{type(e).__name__}: {e}")
b = g.get("board") or {}
print(g.get("repo") or "")
print(b.get("owner") or "")
print(b.get("number") or "")
' "$file" 2>&1)"; then
    echo "project-config: cannot read the github key of $file: $out" >&2
    echo "  Repair: fix the JSON in $file, or run /dev-setup in Claude Code to write it again." >&2
    return 1
  fi
  { IFS= read -r repo; IFS= read -r owner; IFS= read -r number; } <<<"$out"
  if [ -z "${GH_REPO:-}" ] && [ -n "$repo" ]; then export GH_REPO="$repo"; fi
  if [ -z "${GH_PROJECT_OWNER:-}" ] && [ -z "${GH_PROJECT_NUMBER:-}" ] && [ -n "$owner" ] && [ -n "$number" ]; then
    export GH_PROJECT_OWNER="$owner" GH_PROJECT_NUMBER="$number"
  fi
}

neil_dev_github || exit 2
