#!/usr/bin/env bash
# fast-checks-template.sh: a start for a project's scripts/ndev/workflow/fast-checks.sh.
#
#   fast-checks.sh <file>...
#
# The workflow tools run this script on the staged files before each commit. It runs only tools that
# answer in about a second, on the named files. The full lint, typecheck and tests belong in
# pre-commit-check.sh, pre-push-check.sh and pre-ready-check.sh. Add or remove tools to match the project.
#
# Exit 0: no tool found a fault. A tool that is not installed is named on stderr, so a check that did
# not run does not look like a pass. Exit 1: a tool found a fault, and its output says where.
set -u

status=0
python=()
script=()
all=()
for file in "$@"; do
  [ -f "$file" ] || continue
  all+=("$file")
  case "$file" in
    *.py | *.pyi) python+=("$file") ;;
    *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) script+=("$file") ;;
  esac
done

# Direct binaries: a package-manager wrapper (uv run, npx) can cost seconds for each call.
find_tool() {
  local name="$1" path
  for path in ".venv/bin/$name" "node_modules/.bin/$name"; do
    if [ -x "$path" ]; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  command -v "$name" || return 1
}

# check <tool> <count> <arguments and files>
check() {
  local name="$1" count="$2" tool output
  shift 2
  [ "$count" -gt 0 ] || return 0
  if ! tool="$(find_tool "$name")"; then
    echo "fast-checks: $name is not installed, so it did not check $count file(s)." >&2
    return 0
  fi
  if ! output="$("$tool" "$@" 2>&1)"; then
    printf '%s: found faults\n%s\n' "$name" "$output"
    status=1
  fi
}

check ruff "${#python[@]}" check ${python[@]+"${python[@]}"}
check ty "${#python[@]}" check ${python[@]+"${python[@]}"}
check oxlint "${#script[@]}" ${script[@]+"${script[@]}"}
if [ -f sgconfig.yml ]; then
  check ast-grep "${#all[@]}" scan ${all[@]+"${all[@]}"}
fi

exit "$status"
