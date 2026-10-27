#!/usr/bin/env bash
# sweep.sh — find every home that still carries a fact, for the `forget` skill (see ../SKILL.md).
#
# A fact is written to ONE home, but it SPREADS: a wiki page, the folder note above it,
# a plan, a human-facing docs page, a skill, a memory file, a code comment, a test name.
# Forgetting it in one place and missing the rest is the failure this script prevents:
# you cannot fix what you did not enumerate.
#
#   sweep.sh [options] <term> [term...]     # each term is an rg regex; results are the UNION
#
# Options:
#   --repo <path>     checkout to sweep        (default: git top level of the current directory)
#   --wiki <path>     wiki root, relative to the repo (default: docs/wiki when it exists)
#   --memory <path>   agent memory directory   (default: the Claude Code project memory for
#                     the repo, ~/.claude/projects/<repo path with / as ->/memory, when it exists)
#   --context <n>     lines of context per hit (default 0)
#
# Exit codes:
#   0  swept; hits printed (hits are NOT a failure — they are the work list)
#   1  no hits anywhere  -> either already forgotten, or the search term is wrong.
#                           Assume the term is wrong until you have proved otherwise.
#   2  could not run (missing rg, bad path, rg error). NEVER a silent pass.
#
# ⚠️ Two things this script CANNOT do, so do not read them into its output:
#   1. The comment/live split is a LINE-SHAPE HEURISTIC, not a parse. A trailing comment
#      (`foo()  # the old way`) lands in LIVE, and a string containing '#' can land in
#      COMMENTS. Read the hits; do not count them.
#   2. It finds TEXT, not meaning. A fact recorded in different words is invisible to it.
#      Run it with several phrasings — the old name, the new name, the issue number.
set -euo pipefail

REPO=""
WIKI=""
MEMORY=""
CTX=0
TERMS=()

need_value() { [ $# -ge 2 ] || { echo "sweep.sh: $1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)    need_value "$@"; REPO="$2"; shift 2 ;;
    --wiki)    need_value "$@"; WIKI="$2"; shift 2 ;;
    --memory)  need_value "$@"; MEMORY="$2"; shift 2 ;;
    --context) need_value "$@"; CTX="$2"; shift 2 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *)         TERMS+=("$1"); shift ;;
  esac
done

command -v rg >/dev/null 2>&1 || { echo "sweep.sh: ripgrep (rg) is not installed. Fix: brew install ripgrep" >&2; exit 2; }
[ ${#TERMS[@]} -gt 0 ] || { echo "sweep.sh: give at least one search term. Usage: sweep.sh '<old-name>' ['<issue>'] ['<new-name>']" >&2; exit 2; }

if [ -z "$REPO" ]; then
  REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "sweep.sh: not in a git repository. Fix: run inside the checkout, or pass --repo <path>." >&2; exit 2; }
fi
[ -d "$REPO" ] || { echo "sweep.sh: repo not found: $REPO" >&2; exit 2; }
REPO="$(cd "$REPO" && pwd -P)"

if [ -z "$WIKI" ] && [ -d "$REPO/docs/wiki" ]; then WIKI="docs/wiki"; fi
if [ -n "$WIKI" ] && [ ! -d "$REPO/$WIKI" ]; then
  echo "sweep.sh: wiki root not found: $REPO/$WIKI. Fix: pass --wiki <path relative to the repo>." >&2; exit 2
fi

if [ -z "$MEMORY" ]; then
  # Claude Code keys project memory by the absolute path, with every / and . as -.
  # A worktree has its own key, so also try the main checkout's key.
  for root in "$REPO" "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##')"; do
    [ -n "$root" ] || continue
    cand="$HOME/.claude/projects/$(printf '%s' "$root" | sed 's#[/.]#-#g')/memory"
    if [ -d "$cand" ]; then MEMORY="$cand"; break; fi
  done
elif [ ! -d "$MEMORY" ]; then
  echo "sweep.sh: memory directory not found: $MEMORY" >&2; exit 2
fi

PAT=()
for t in "${TERMS[@]}"; do PAT+=(-e "$t"); done

TOTAL=0
HITFILE=$(mktemp)
trap 'rm -f "$HITFILE"' EXIT

# search <root> [rg args...] — append hits to $HITFILE. rg exits 1 for no match and
# 2 for an error; an error must stop the sweep, never read as "no hits".
search() {
  local root="$1"; shift
  local status=0
  # rg matches -g globs against the path as given, so search the repo from its top with
  # repo-relative paths; then '!/docs/wiki/**' means exactly that folder.
  case "$root" in
    "$REPO") root="." ;;
    "$REPO"/*) root="${root#"$REPO"/}" ;;
  esac
  (cd "$REPO" && rg --with-filename --line-number --no-heading --color never --hidden -g '!.git' --context "$CTX" \
     "${PAT[@]}" "$@" "$root") >> "$HITFILE" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "sweep.sh: rg failed (exit $status) while searching $root, so this sweep is incomplete." >&2
    echo "  Fix: check each term is a valid rg regex (try: rg -e '<term>' --files-with-matches .)." >&2
    exit 2
  fi
}

strip() { sed "s#^\./##; s#^${MEMORY:-/nonexistent}/#memory/#"; }

# section <title> <root-dir> [rg args...]
section() {
  local title="$1" root="$2"; shift 2
  [ -e "$root" ] || return 0
  : > "$HITFILE"
  search "$root" "$@"
  local n; n=$(grep -c . < "$HITFILE" || true)
  [ "${n:-0}" -eq 0 ] && return 0
  TOTAL=$((TOTAL + n))
  printf '\n=== %s  (%s lines)\n' "$title" "$n"
  strip < "$HITFILE"
}

echo "sweep: ${TERMS[*]}"
echo "repo:  $REPO"
echo "wiki:  ${WIKI:-(none found; pass --wiki)}"
echo "memory: ${MEMORY:-(none found; pass --memory)}"

# ---- 1. Agent memory. NOT a git repository: a deletion here is UNRECOVERABLE. ----
[ -n "$MEMORY" ] && section "MEMORY (not git — deletion is permanent)" "$MEMORY"

# ---- 2. The wiki: pages, folder notes and the .log entries that cite them. ----
[ -n "$WIKI" ] && section "WIKI  $WIKI/" "$REPO/$WIKI"

# ---- 3. Root guides that override default agent behaviour. ----
for f in CLAUDE.md AGENTS.md CONTEXT.md README.md CONTRIBUTING.md; do
  section "ROOT  $f" "$REPO/$f"
done

# ---- 4. Other documentation: ADRs, plans, specs, human-facing docs. ----
# A superseded plan is the classic reimplementation trap.
DOC_GLOBS=(-g '!node_modules')
[ -n "$WIKI" ] && DOC_GLOBS+=(-g "!/$WIKI/**")
section "DOCS  docs/ (outside the wiki)" "$REPO/docs" "${DOC_GLOBS[@]}"

# ---- 5. Skill and agent instructions, one section per harness. ----
section "SKILLS  .claude/skills/ (Claude)" "$REPO/.claude/skills"
section "SKILLS  .agents/skills/ (Codex)"  "$REPO/.agents/skills"
section "AGENTS  .claude/agents/"          "$REPO/.claude/agents"
section "AGENTS  .codex/"                  "$REPO/.codex"

# ---- 6. Code: comments and live lines. Line-shape heuristic; see the header warning. ----
EXCLUDE=(-g '!node_modules' -g '!.venv' -g '!venv' -g '!dist' -g '!build' -g '!.next' -g '!out'
         -g '!*.lock' -g '!*lock.json' -g '!*lock.yaml' -g '!/docs/**'
         -g '!/.claude/**' -g '!/.agents/**' -g '!/.codex/**'
         -g '!/CLAUDE.md' -g '!/AGENTS.md' -g '!/CONTEXT.md' -g '!/README.md' -g '!/CONTRIBUTING.md')
[ -n "$WIKI" ] && EXCLUDE+=(-g "!/$WIKI/**")
TEST_GLOBS=(-g '**/test/**' -g '**/tests/**' -g '**/__tests__/**' -g '**/e2e/**' -g '**/guards/**'
            -g '*_test.*' -g 'test_*' -g '*.test.*' -g '*.spec.*')
NOT_TESTS=(-g '!**/test/**' -g '!**/tests/**' -g '!**/__tests__/**' -g '!**/e2e/**' -g '!**/guards/**'
           -g '!*_test.*' -g '!test_*' -g '!*.test.*' -g '!*.spec.*')

: > "$HITFILE"
search "$REPO" "${EXCLUDE[@]}" "${NOT_TESTS[@]}"
COMMENTISH='^[^:]+:[0-9]+: *([#*]|//|/\*|<!--|"""|'"'''"'|--)'
COMMENTS=$(grep -E "$COMMENTISH" < "$HITFILE" || true)
LIVE=$(grep -Ev "$COMMENTISH" < "$HITFILE" || true)

if [ -n "$COMMENTS" ]; then
  n=$(printf '%s\n' "$COMMENTS" | grep -c . || true)
  TOTAL=$((TOTAL + n))
  printf '\n=== CODE — COMMENTS & DOCSTRINGS  (%s lines)\n' "$n"
  printf '%s\n' "$COMMENTS" | strip
fi

if [ -n "$LIVE" ]; then
  n=$(printf '%s\n' "$LIVE" | grep -c . || true)
  TOTAL=$((TOTAL + n))
  printf '\n=== ⚠️  CODE — LIVE (not comment-shaped)  (%s lines)\n' "$n"
  echo '    If the thing you are forgetting still appears in RUNNING code, your premise'
  echo '    may be wrong. Read these before you delete a single word. See SKILL.md step 1.'
  printf '%s\n' "$LIVE" | strip
fi

# ---- 7. Tests and guards. A guard pinning removed behaviour goes red on the RIGHT fix. ----
: > "$HITFILE"
search "$REPO" "${EXCLUDE[@]}" "${TEST_GLOBS[@]}"
n=$(grep -c . < "$HITFILE" || true)
if [ "${n:-0}" -gt 0 ]; then
  TOTAL=$((TOTAL + n))
  printf '\n=== TESTS & GUARDS  (%s lines)\n' "$n"
  echo '    A guard asserting the OLD behaviour turns red when someone does the right'
  echo '    thing — which reads as "your change is wrong". Keep the intent, rewrite the'
  echo '    assertion; never just delete a guard to make a colour change.'
  strip < "$HITFILE"
fi

printf '\n---\n'
if [ "$TOTAL" -eq 0 ]; then
  echo "NO HITS for: ${TERMS[*]}"
  echo "Either it is already forgotten, or the term is wrong. Try the OLD name, the NEW"
  echo "name, and the issue number separately before concluding there is nothing to do."
  exit 1
fi
echo "$TOTAL matching lines across the homes above. Every one is a decision:"
echo "  erase (the default) / narrow / rewrite to current state / mark 'Removed in #<n>.'"
echo "  See SKILL.md. Never replace deleted text with a note describing what was there."
exit 0
