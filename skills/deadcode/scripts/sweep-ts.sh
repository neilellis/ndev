#!/usr/bin/env bash
# Report the dead TypeScript code THIS BRANCH created, not what the repo already had.
#
# Usage: sweep-ts.sh [base-ref]       default base-ref = origin/HEAD, else origin/main
# Needs: knip at node_modules/.bin/knip and a knip.json at the repository root.
# Exit:  0 = this branch added no dead code
#        1 = this branch added dead code (listed on stdout — triage every line)
#        2 = could not measure. NEVER a pass.
#
# The Python sweep beside this one reads source files, so its base scan is a
# cheap checkout. `knip` needs a resolved `node_modules` to run at all, so the
# base worktree shares the head's by symlink. That is only correct while the two
# commits agree on `pnpm-lock.yaml`. When they differ, the base worktree gets
# its own install instead — slow, but a branch that adds a dependency is
# ordinary work and must still get a measurement.
set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  BASE="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)" || BASE="origin/main"
fi

# Walk up to the repo that holds knip.json. `git rev-parse --show-toplevel`
# answers with the SUBMODULE when this script is run from inside one.
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "sweep-ts.sh: not in a git repository." >&2; exit 2; }
while [ ! -f "$REPO/knip.json" ] && [ "$REPO" != "/" ]; do
  REPO="$(cd "$REPO/.." && git rev-parse --show-toplevel 2>/dev/null)" || break
done
cd "$REPO" 2>/dev/null || {
  echo "sweep-ts.sh: cannot enter the repository root $REPO." >&2; exit 2; }

# ⚠️ Without knip.json, knip walks the whole tree, including docs and skill
# folders that no workspace builds. That is not a measurement of the project's
# TypeScript, so refuse rather than report it.
if [ ! -f "$REPO/knip.json" ]; then
  echo "sweep-ts.sh: knip.json is absent. Without it knip walks the whole tree and" >&2
  echo "  reports files no workspace builds. Fix: add a knip.json that names the" >&2
  echo "  workspaces (https://knip.dev/overview/configuration), then run again." >&2
  exit 2
fi

MERGE_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null)" || {
  echo "sweep-ts.sh: no merge base with $BASE. Fix: git fetch origin, or pass a base ref." >&2
  exit 2; }

# ⚠️ The head having a configuration says nothing about the base. A base that
# predates knip.json scans unconfigured, and the subtraction against it reports
# false numbers with an exit code that reads as a pass.
if ! git cat-file -e "$MERGE_BASE:knip.json" 2>/dev/null; then
  echo "sweep-ts.sh: the merge base $MERGE_BASE has no knip.json, so the base scan" >&2
  echo "  has no scope to read. Its findings would not describe the base, and the" >&2
  echo "  subtraction against them would be meaningless. There is nothing to compare" >&2
  echo "  until the configuration is on the base branch." >&2
  exit 2
fi

# The base worktree borrows this checkout's node_modules. A different lock file
# makes that tree wrong for the base, and every dependency finding it produces
# would describe the head's dependencies against the base's source.
#
# ⚠️ Do NOT refuse here. Adding or bumping a dependency is ordinary work, and a
# sweep that declines to measure those branches is a sweep nobody can run. Pay
# the install cost on the branches that need it, and only on those.
HEAD_LOCK="$(git rev-parse "HEAD:pnpm-lock.yaml" 2>/dev/null)" || HEAD_LOCK=""
BASE_LOCK="$(git rev-parse "$MERGE_BASE:pnpm-lock.yaml" 2>/dev/null)" || BASE_LOCK=""
BASE_NEEDS_INSTALL=0
[ "$HEAD_LOCK" != "$BASE_LOCK" ] && BASE_NEEDS_INSTALL=1

if [ ! -d "$REPO/node_modules" ]; then
  echo "sweep-ts.sh: node_modules is absent. Run pnpm install first." >&2; exit 2; fi

# scan <checkout-dir> <label> -> sorted "category<TAB>name<TAB>file" lines
#
# ⚠️ knip exits 1 when it finds something and 0 when it does not, so a non-zero
# status is NOT a failure by itself. Anything above 1 is. A crashed run prints
# the workspaces it managed and exits higher: the output is real, non-empty, and
# missing everything after the crash. The empty-output guards below cannot see
# that, because the output is not empty. Never report a partial scan as complete.
#
# Fields are tab separated. knip names hold spaces and commas — `unlisted`,
# `unresolved` and `duplicates` all produce them — and splitting the report on
# whitespace put half a name in the File column and dropped the path.
#
# ⚠️ Run the binary, never `pnpm exec knip`. pnpm 11 checks the install before
# exec, and its state file names absolute paths. In the base worktree of any pnpm
# workspace, the check finds a "changed" workspace and starts `pnpm install`. That
# install wants to purge the symlinked node_modules. With no TTY it aborts: exit 1,
# with the abort text on stdout, which looks like a knip report. With a TTY it
# prompts, and with CI=true it purges without a prompt. Setting CI=true is no fix.
scan() {
  local dir="$1" label="$2" status
  if [ ! -x "$dir/node_modules/.bin/knip" ]; then
    echo "sweep-ts.sh: $dir/node_modules/.bin/knip is absent at the $label, so there is" >&2
    echo "  nothing to scan with. Fix: run pnpm install. If the $label's package.json does" >&2
    echo "  not list knip, run pnpm add -D -w knip (no -w in a single-package repository)." >&2
    return 2
  fi
  ( cd "$dir" && ./node_modules/.bin/knip --no-progress --reporter json 2>"$TMP/$label.err" )   \
    > "$TMP/$label.json"
  status=$?
  echo "$status" > "$TMP/$label.status"
  if [ "$status" -gt 1 ]; then
    echo "sweep-ts.sh: knip exited $status at the $label. That is a crash, not a" >&2
    echo "  finding count. Any workspace it did not reach is missing from the scan," >&2
    echo "  and the difference against it would be wrong in both directions." >&2
    sed 's/^/  knip: /' "$TMP/$label.err" >&2
    return 2
  fi
  python3 -c '
import json,sys
raw = sys.stdin.read()
try:
    issues = json.loads(raw)["issues"]
except Exception as exc:
    # Never swallow this. An unreadable report is not an empty one, and exiting
    # 0 here would turn a broken run into "no findings".
    sys.stderr.write("could not parse knip JSON: %s\n" % exc)
    sys.exit(3)
for entry in issues:
    path = entry.get("file", "")
    for category, found in entry.items():
        if category == "file" or not isinstance(found, list):
            continue
        for item in found:
            if isinstance(item, dict):
                name = item.get("name", "")
            elif isinstance(item, list):
                name = ",".join(str(x.get("name", x)) for x in item)
            else:
                name = str(item)
            print("%s\t%s\t%s" % (category, name, path))
' < "$TMP/$label.json" 2>"$TMP/$label.parse.err" | sort -u
  status="${PIPESTATUS[0]}"
  if [ "$status" -ne 0 ]; then
    echo "sweep-ts.sh: could not read knip's report at the $label." >&2
    sed 's/^/  /' "$TMP/$label.parse.err" >&2
    sed 's/^/  knip: /' "$TMP/$label.err" >&2
    # The text that failed to parse is the diagnosis: a tool that fails can write
    # its error to stdout, and then the stderr above is empty.
    head -n 20 "$TMP/$label.json" | cut -c1-300 | sed 's/^/  stdout: /' >&2
    return 2
  fi
  return 0
}

TMP="$(mktemp -d)"
trap 'git worktree remove --force "$TMP/base" >/dev/null 2>&1; rm -rf "$TMP"' EXIT

scan "$REPO" head > "$TMP/head.txt" || exit 2
# An empty scan is "no findings" only when knip itself exited 0. Empty output
# after knip exit 1 (findings exist) means the report was not read, and a
# failed read must never reach the subtraction.
[ -s "$TMP/head.txt" ] || [ "$(cat "$TMP/head.status")" = "0" ] || {
  echo "sweep-ts.sh: knip produced no output at HEAD. That is a failed run, not a" >&2
  echo "  clean repository. Check that node_modules/.bin/knip runs here." >&2
  exit 2; }

git worktree add --detach "$TMP/base" "$MERGE_BASE" >/dev/null 2>&1 || {
  echo "sweep-ts.sh: could not check out the merge base $MERGE_BASE." >&2; exit 2; }

if [ "$BASE_NEEDS_INSTALL" -eq 1 ]; then
  # A real install into the worktree, never a symlink: the two commits resolve
  # to different trees. This costs minutes. It runs only when the lock files
  # differ, and it never touches the user's own node_modules.
  echo "sweep-ts.sh: pnpm-lock.yaml differs from the base. Installing the base's own" >&2
  echo "  dependencies into a temporary worktree. This takes a few minutes." >&2
  if ! ( cd "$TMP/base" && pnpm install --frozen-lockfile --ignore-scripts >&2 ); then
    echo "sweep-ts.sh: pnpm install failed in the base worktree. Without it the base" >&2
    echo "  scan reads the wrong dependency tree, so there is no number to report." >&2
    exit 2
  fi
else
  # ⚠️ The root node_modules is not the whole install. pnpm also creates one
  # inside each workspace, holding the symlinks that make that workspace's own
  # dependencies resolvable. A base worktree without them cannot resolve those
  # dependencies, and knip reports every one unused.
  #
  # Linking the root alone makes the base scan report each dependency of a
  # workspace that carries its own node_modules as unused. Those findings are
  # false, and they sit on the wrong side of the subtraction.
  #
  # WARNING: `ln -s` cannot be trusted to report its own failure here. Against a
  # destination that already exists as a directory it returns 0 and creates a
  # NESTED link inside it, leaving the workspace unlinked. So each link is
  # resolved after it is made, and a link that does not resolve stops the run.
  link_node_modules() {  # link_node_modules <relative path>
    local rel="$1"
    if [ -e "$TMP/base/$rel" ] || [ -L "$TMP/base/$rel" ]; then
      echo "sweep-ts.sh: $rel already exists in the base worktree, so the link to" >&2
      echo "  this checkout's copy cannot be made. The base scan would read the" >&2
      echo "  wrong dependency tree for that workspace." >&2
      return 1
    fi
    if ! ln -s "$REPO/$rel" "$TMP/base/$rel" 2>"$TMP/ln.err"; then
      echo "sweep-ts.sh: could not link $rel into the base worktree. Without it knip" >&2
      echo "  reports every dependency that workspace declares as unused, on the" >&2
      echo "  wrong side of the subtraction." >&2
      sed 's/^/  ln: /' "$TMP/ln.err" >&2
      return 1
    fi
    return 0
  }

  link_node_modules node_modules || exit 2
  # The workspace globs come from pnpm-workspace.yaml rather than a fixed depth,
  # so a workspace nested deeper than the current layout is still found. A
  # single-package repository has no workspace file and links the root only.
  WS_FILE="$REPO/pnpm-workspace.yaml"
  [ -f "$WS_FILE" ] || WS_FILE=/dev/null
  while IFS= read -r _pat; do
    case "$_pat" in ""|"#"*) continue ;; esac
    for _nm in $_pat/node_modules; do
      [ -d "$REPO/$_nm" ] || continue
      [ -d "$TMP/base/$(dirname "$_nm")" ] || continue
      link_node_modules "$_nm" || exit 2
    done
  done < <(sed -n '/^packages:/,/^[^ #-]/p' "$WS_FILE" \
             | sed -n 's/^[[:space:]]*-[[:space:]]*//p' | tr -d "'\"" )
fi
scan "$TMP/base" base > "$TMP/base.txt" || exit 2
# ⚠️ An empty base file silently disables the subtraction below. `NR==FNR` stays
# true through the SECOND file when the first held no records, so awk loads every
# head line as a key rather than testing it, and prints nothing whatever the head
# contains. A base scan that produced nothing has not measured the base.
[ -s "$TMP/base.txt" ] || [ "$(cat "$TMP/base.status")" = "0" ] || {
  echo "sweep-ts.sh: knip produced no output at the base $MERGE_BASE. That is a" >&2
  echo "  failed run, not a clean base. Subtracting against it would report every" >&2
  echo "  finding as new, or nothing as new, and neither is a measurement." >&2
  # Name the one number that IS known. "Never report a bare exit code" applies to
  # a refusal as much as to a result: the head count says whether that scan ran.
  echo "  The head scan produced $(wc -l < "$TMP/head.txt" | tr -d ' ') finding(s)." >&2
  exit 2; }

# Key on "category + name + file" — never on a line number, which moves whenever
# any line above it changes and would report every shifted finding as new.
if [ -s "$TMP/base.txt" ]; then
  NEW="$(awk 'NR==FNR{k[$0];next} !($0 in k)' "$TMP/base.txt" "$TMP/head.txt")"
else
  NEW="$(cat "$TMP/head.txt")"   # a clean base: every head finding is new
fi

BASE_N=$(wc -l < "$TMP/base.txt" | tr -d ' ')
HEAD_N=$(wc -l < "$TMP/head.txt" | tr -d ' ')

echo "### Dead code sweep (TypeScript)"
echo
echo "\`knip\` over the workspaces in \`knip.json\`, against \`$BASE\` (\`${MERGE_BASE:0:9}\`)."
echo "Whole repo: **$BASE_N** findings at the base, **$HEAD_N** at this branch's head."
echo
if [ -z "$NEW" ]; then
  # Name both counts in the same sentence. Exit 0 has two meanings and the code
  # cannot tell them apart: this branch added nothing, and this branch is a
  # deletion branch whose findings all existed at the base.
  echo "**This branch introduced no unused TypeScript name.**"
  echo
  echo "That is not the same as a clean repository, and it is not evidence of a deletion."
  echo "$BASE_N finding(s) were already dead at the base and $HEAD_N are dead now. A branch"
  echo "whose purpose is deletion moves that second number down and reports nothing new here."
  exit 0
fi
NEW_N=$(printf '%s\n' "$NEW" | wc -l | tr -d ' ')
echo "**This branch introduced $NEW_N unused TypeScript finding(s).** Triage every one."
echo
echo '| Category | Name | File |'
echo '|---|---|---|'
printf '%s\n' "$NEW" | awk -F'\t' '{printf "| %s | `%s` | `%s` |\n", $1, $2, $3}'
exit 1
