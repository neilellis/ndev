#!/usr/bin/env bash
# Proves worktree_claim.sh in BOTH directions.
#
# The guard exists because the old worktree block ran `git worktree remove --force`,
# `git branch -D` and `git worktree add -B` unconditionally. That can discard the
# unpushed commits of a live session and delete its working directory. `git worktree add -B` reports the loss only as the routine phrase
# `was at <sha>`, so nothing in the output reads as damage.
#
# Each case asserts the exit code AND that the work is still on disk. A guard that
# refuses but has already deleted the files is not a guard.
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
CLAIM="$HERE/worktree_claim.sh"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ok   — $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL — $1"; }

# A missing script must NOT read as a pass. Without this, the "no destructive
# command present" and "commit survived" assertions are vacuously true when the
# guard does not exist — a green run that proves nothing.
if [ ! -x "$CLAIM" ]; then
  echo "CANNOT MEASURE: $CLAIM is missing or not executable. That is not a pass."
  exit 2
fi

# A throwaway origin + clone, so no real repository is touched.
new_repo() {
  local root; root="$(mktemp -d)"
  git init -q --bare "$root/origin.git"
  git clone -q "$root/origin.git" "$root/repo" 2>/dev/null
  git -C "$root/repo" config user.email t@t.t
  git -C "$root/repo" config user.name t
  echo base > "$root/repo/f.txt"
  git -C "$root/repo" add f.txt
  git -C "$root/repo" commit -qm base
  git -C "$root/repo" push -q origin HEAD:main 2>/dev/null
  git -C "$root/repo" branch -q -M main
  mkdir -p "$root/repo/.claude/worktrees"
  echo "$root"
}

echo "case 1 — no worktree yet, clean: must CREATE and exit 0"
R="$(new_repo)"
out="$("$CLAIM" "$R/repo" 42 origin/main 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc, expected 0 ($out)"
[ -d "$R/repo/.claude/worktrees/issue-42" ] && ok "worktree created" || bad "worktree missing"

echo "case 2 — worktree holds UNCOMMITTED work: must REFUSE and keep the file"
R="$(new_repo)"
"$CLAIM" "$R/repo" 43 origin/main >/dev/null 2>&1
echo "precious" > "$R/repo/.claude/worktrees/issue-43/uncommitted.txt"
out="$("$CLAIM" "$R/repo" 43 origin/main 2>&1)"; rc=$?
[ "$rc" = 3 ] && ok "exit 3 (dirty)" || bad "exit $rc, expected 3 ($out)"
[ -f "$R/repo/.claude/worktrees/issue-43/uncommitted.txt" ] \
  && [ "$(cat "$R/repo/.claude/worktrees/issue-43/uncommitted.txt")" = precious ] \
  && ok "uncommitted file survived untouched" || bad "THE GUARD DESTROYED THE FILE"

echo "case 3 — branch has UNPUSHED commits: must REFUSE and keep them"
R="$(new_repo)"
"$CLAIM" "$R/repo" 44 origin/main >/dev/null 2>&1
W="$R/repo/.claude/worktrees/issue-44"
echo change > "$W/f.txt"
git -C "$W" commit -qam "unpushed work"
sha="$(git -C "$W" rev-parse HEAD)"
out="$("$CLAIM" "$R/repo" 44 origin/main 2>&1)"; rc=$?
[ "$rc" = 4 ] && ok "exit 4 (unpushed)" || bad "exit $rc, expected 4 ($out)"
now="$(git -C "$W" rev-parse HEAD 2>/dev/null || true)"
# The emptiness check matters: if the worktree is gone, both sides are empty and a
# bare equality test reports success while the commit is destroyed.
if [ -n "$now" ] && [ "$now" = "$sha" ]; then
  ok "unpushed commit still at HEAD"
else
  bad "THE GUARD DISCARDED THE COMMIT (HEAD now '${now:-<worktree gone>}')"
fi

echo "case 4 — worktree clean and fully pushed: must REUSE and exit 0"
R="$(new_repo)"
"$CLAIM" "$R/repo" 45 origin/main >/dev/null 2>&1
W="$R/repo/.claude/worktrees/issue-45"
echo change > "$W/f.txt"
git -C "$W" commit -qam pushed
git -C "$W" push -q -u origin claude/issue-45 2>/dev/null
sha="$(git -C "$W" rev-parse HEAD)"
out="$("$CLAIM" "$R/repo" 45 origin/main 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 (reuse)" || bad "exit $rc, expected 0 ($out)"
[ "$(git -C "$W" rev-parse HEAD)" = "$sha" ] \
  && ok "reuse did not reset the branch" || bad "reuse RESET the branch"

echo "case 5 — the destructive commands must not appear in the script at all"
# Strip comment lines first. The script documents the banned commands on purpose,
# and matching that prose would fail the guard for explaining itself.
if sed 's/#.*//' "$CLAIM" | grep -qE 'worktree remove --force|branch -D'; then
  bad "script still contains worktree remove --force or branch -D"
else
  ok "no unconditional destructive command present"
fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = 0 ]
