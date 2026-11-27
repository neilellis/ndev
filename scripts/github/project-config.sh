#!/usr/bin/env bash
# Source this file; do not run it. Sets GH_REPO, GH_PROJECT_OWNER and GH_PROJECT_NUMBER from the
# "github" key of the project's .ndev.json, else the old .neil-dev.json (saved by the ndev /dev-setup dialog),
# so no script looks them up again. A value already in the environment wins. A file that cannot
# be read stops the calling script, with the repair.

neil_dev_github() {
  local root file out repo owner number
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  file="$root/.ndev.json"
  [ -f "$file" ] || [ -f "$root/.neil-dev.json" ] || return 0
  if ! out="$(python3 -I -c '
import json, os, sys
root = sys.argv[1]
current, legacy = os.path.join(root, ".ndev.json"), os.path.join(root, ".neil-dev.json")
def load(path):
    try:
        return json.load(open(path))
    except Exception as e:
        sys.exit(f"cannot read {path}: {type(e).__name__}: {e}. Repair: fix the JSON in {path}, or run /dev-setup in Claude Code to write it again.")
found = [p for p in (current, legacy) if os.path.isfile(p)]
configs = [load(p) for p in found]
if len(configs) == 2 and configs[0] != configs[1]:
    sys.exit(f"{current} and {legacy} both exist and their settings differ, so neither is read. Repair: put the settings to keep in {current}, delete {legacy}, then run ndev project migrate-config to check.")
g = configs[0].get("github") or {}
b = g.get("board") or {}
print(g.get("repo") or "")
print(b.get("owner") or "")
print(b.get("number") or "")
' "$root" 2>&1)"; then
    echo "project-config: $out" >&2
    return 1
  fi
  { IFS= read -r repo; IFS= read -r owner; IFS= read -r number; } <<<"$out"
  if [ -z "${GH_REPO:-}" ] && [ -n "$repo" ]; then export GH_REPO="$repo"; fi
  if [ -z "${GH_PROJECT_OWNER:-}" ] && [ -z "${GH_PROJECT_NUMBER:-}" ] && [ -n "$owner" ] && [ -n "$number" ]; then
    export GH_PROJECT_OWNER="$owner" GH_PROJECT_NUMBER="$number"
  fi
}

neil_dev_github || exit 2
