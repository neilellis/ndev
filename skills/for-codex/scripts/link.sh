#!/usr/bin/env bash
# Link this plugin's skills into one project's Codex-only skill folder:
#   <project>/.codex/skills/<name> -> <plugin-root>/skills/<name>
#   <project>/.codex/scripts       -> <plugin-root>/scripts
# The second link keeps a skill's `<skill folder>/../../scripts/...` path working when a
# tool normalises the path as text (.codex/skills/<name>/../.. is .codex).
# Usage: link.sh [--dry-run] [--remove] [--source <plugin-root>] [project-dir]
set -euo pipefail

usage() {
  echo "usage: link.sh [--dry-run] [--remove] [--source <plugin-root>] [project-dir]" >&2
}

die() {
  echo "for-codex: error: $*" >&2
  exit 2
}

dry_run=0
remove=0
source_root=""
project=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --remove) remove=1 ;;
    --source)
      [ $# -ge 2 ] || die "--source needs a path. Example: --source ~/dev/ndev"
      source_root="$2"
      shift
      ;;
    -h | --help) usage; exit 0 ;;
    -*) usage; die "unknown option '$1'" ;;
    *)
      [ -z "$project" ] || die "more than one project dir given ('$project' and '$1')"
      project="$1"
      ;;
  esac
  shift
done

# Plugin root: --source, else the stable working copy when this script runs
# from Claude's plugin cache, else the plugin that holds this script.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
own_root="$(cd "$script_dir/../../.." && pwd -P)"
working_copy="$HOME/dev/ndev"

if [ -n "$source_root" ]; then
  [ -d "$source_root/skills" ] ||
    die "'$source_root' has no skills/ folder. Give the plugin root with --source."
  plugin_root="$(cd "$source_root" && pwd -P)"
elif [[ "$own_root" == */.claude/plugins/cache/* ]] && [ -d "$working_copy/skills" ]; then
  plugin_root="$(cd "$working_copy" && pwd -P)"
  echo "note: running from the plugin cache; linking to the working copy $plugin_root"
else
  plugin_root="$own_root"
  if [[ "$plugin_root" == */.claude/plugins/cache/* ]]; then
    echo "warning: linking into the plugin cache ($plugin_root). A plugin update changes" \
      "this path and breaks the links. Clone the plugin to $working_copy or pass --source." >&2
  fi
fi
[ -d "$plugin_root/skills" ] || die "plugin root '$plugin_root' has no skills/ folder. Pass --source <plugin-root>."
[ -d "$plugin_root/scripts" ] || die "plugin root '$plugin_root' has no scripts/ folder, which the skills call. Repair: update the plugin copy (git pull in $plugin_root, or claude plugin update ndev), or pass --source <plugin-root>."

if [ -z "$project" ]; then
  project="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    die "'$PWD' is not in a git repository. Give the project dir: link.sh <project-dir>"
fi
[ -d "$project" ] || die "project dir '$project' does not exist"
project="$(cd "$project" && pwd -P)"
[ "$project" != "$plugin_root" ] || die "the project dir is the plugin itself ('$project'). Give another project."

target="$project/.codex/skills"
prefix=""
[ "$dry_run" -eq 0 ] || prefix="[dry-run] "

n_linked=0 n_kept=0 n_updated=0 n_refused=0 n_removed=0
refusals=()

say() { echo "${prefix}$1 $2"; }

run() {
  [ "$dry_run" -eq 1 ] || "$@"
}

# True when symlink $1 points into this plugin's skills/ folder (or is the
# scripts/ link), either the chosen plugin root or any cached copy of this plugin.
points_into_plugin() {
  local dest
  dest="$(readlink "$1")"
  [[ "$dest" == "$plugin_root/skills/"* ]] ||
    [[ "$dest" == */.claude/plugins/cache/*/ndev/*/skills/* ]] ||
    [[ "$dest" == "$own_root/skills/"* ]]
}
points_to_plugin_scripts() {
  local dest
  dest="$(readlink "$1")"
  [[ "$dest" == "$plugin_root/scripts" ]] ||
    [[ "$dest" == */.claude/plugins/cache/*/ndev/*/scripts ]] ||
    [[ "$dest" == "$own_root/scripts" ]]
}
scripts_link="$project/.codex/scripts"

refuse() {
  n_refused=$((n_refused + 1))
  refusals+=("$1 ($2)")
  say "refused" "$1: $2"
}

if [ "$remove" -eq 1 ]; then
  if [ -d "$target" ]; then
    for entry in "$target"/* "$target"/.[!.]*; do
      [ -L "$entry" ] || continue
      if points_into_plugin "$entry"; then
        run rm "$entry"
        n_removed=$((n_removed + 1))
        say "removed" "$entry"
      fi
    done
    if [ "$dry_run" -eq 0 ] && [ -z "$(ls -A "$target")" ]; then
      rmdir "$target"
    fi
  fi
  if [ -L "$scripts_link" ] && points_to_plugin_scripts "$scripts_link"; then
    run rm "$scripts_link"
    n_removed=$((n_removed + 1))
    say "removed" "$scripts_link"
  fi
  [ "$dry_run" -eq 1 ] || rmdir "$project/.codex" 2>/dev/null || true
  echo "${prefix}summary: removed=$n_removed target=$target"
  exit 0
fi

if [ -e "$target" ] && [ ! -d "$target" ]; then
  die "'$target' exists and is not a folder. Move it away, then run again."
fi
run mkdir -p "$target"

for skill_dir in "$plugin_root"/skills/*/; do
  skill_dir="${skill_dir%/}"
  name="$(basename "$skill_dir")"
  [ -f "$skill_dir/SKILL.md" ] || continue
  link="$target/$name"

  if [ -L "$link" ]; then
    current="$(readlink "$link")"
    if [ "$current" = "$skill_dir" ]; then
      n_kept=$((n_kept + 1))
      say "kept" "$link"
    elif points_into_plugin "$link"; then
      run ln -sfn "$skill_dir" "$link"
      n_updated=$((n_updated + 1))
      say "updated" "$link -> $skill_dir (was $current)"
    else
      refuse "$link" "symlink to '$current', not this plugin. Remove it yourself to link this skill"
    fi
  elif [ -e "$link" ]; then
    refuse "$link" "real file or folder. Move or rename it to link this skill"
  else
    run ln -s "$skill_dir" "$link"
    n_linked=$((n_linked + 1))
    say "linked" "$link -> $skill_dir"
  fi
done

# The shared scripts folder that the skills call as <skill folder>/../../scripts.
want_scripts="$plugin_root/scripts"
if [ -L "$scripts_link" ]; then
  current="$(readlink "$scripts_link")"
  if [ "$current" = "$want_scripts" ]; then
    n_kept=$((n_kept + 1))
    say "kept" "$scripts_link"
  elif points_to_plugin_scripts "$scripts_link"; then
    run ln -sfn "$want_scripts" "$scripts_link"
    n_updated=$((n_updated + 1))
    say "updated" "$scripts_link -> $want_scripts (was $current)"
  else
    refuse "$scripts_link" "symlink to '$current', not this plugin. Remove it yourself so the skills can find their scripts"
  fi
elif [ -e "$scripts_link" ]; then
  refuse "$scripts_link" "real file or folder. Move or rename it so the skills can find their scripts"
else
  run ln -s "$want_scripts" "$scripts_link"
  n_linked=$((n_linked + 1))
  say "linked" "$scripts_link -> $want_scripts"
fi

echo "${prefix}summary: linked=$n_linked kept=$n_kept updated=$n_updated refused=$n_refused target=$target"

# Suggest .gitignore; do not edit it.
if git -C "$project" rev-parse --git-dir >/dev/null 2>&1; then
  if ! git -C "$project" check-ignore -q "$target/" 2>/dev/null; then
    echo "hint: '.codex/skills/' is not git-ignored. The links hold absolute paths for this machine." \
      "If you do not want to commit them, add this line to $project/.gitignore:  .codex/skills/"
  fi
  if ! git -C "$project" check-ignore -q "$scripts_link" 2>/dev/null; then
    echo "hint: '.codex/scripts' is not git-ignored. It is a link with an absolute path for this machine." \
      "If you do not want to commit it, add this line to $project/.gitignore:  .codex/scripts"
  fi
fi

if [ "$n_refused" -gt 0 ]; then
  echo "for-codex: $n_refused refused (user content kept):" >&2
  for r in "${refusals[@]}"; do echo "  - $r" >&2; done
  exit 1
fi
