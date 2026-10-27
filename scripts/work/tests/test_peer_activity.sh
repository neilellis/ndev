#!/usr/bin/env bash
# Proves peer_activity.sh in BOTH directions.
#
# The guard exists because worktree_claim.sh reads TREE STATE only. A live session
# that has committed and pushed everything leaves a clean worktree, so the claim
# guard hands it to a second agent and the two then share one branch.
#
# Every rule is proved in both directions. A check that only fires when a peer is
# present is half a guard: a false positive removes an issue from every future pass,
# which is as damaging as the collision it prevents.
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
PEER="$HERE/peer_activity.sh"
# The workflow whose peerVerdicts block case 9+ checks stays with its skill.
WORKFLOW="$HERE/../../skills/work-heavy-auto/scripts/work_ready_workflow.js"
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); echo "  ok   — $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL — $1"; }

# A missing script must NOT read as a pass. Without this every "exit 0" assertion
# below is vacuously true when the guard does not exist.
if [ ! -x "$PEER" ]; then
  echo "CANNOT MEASURE: $PEER is missing or not executable. That is not a pass."
  exit 2
fi
if [ ! -f "$WORKFLOW" ]; then
  echo "CANNOT MEASURE: $WORKFLOW is missing. Repair: run this test from a full plugin checkout (scripts/ beside skills/). That is not a pass."
  exit 2
fi

# A throwaway repository and a throwaway session root, so no real session is read.
# It is a REAL git repository, because the worktrees below must be real LINKED
# worktrees: their in-flight git state lives in the main repository under
# .git/worktrees/<name>/, and a plain directory cannot reproduce that.
new_env() {
  local root; root="$(mktemp -d)"
  mkdir -p "$root/repo/.claude/worktrees" "$root/sessions"
  git init -q "$root/repo"
  git -C "$root/repo" config user.email t@t.t
  git -C "$root/repo" config user.name t
  git -C "$root/repo" branch -q -M main 2>/dev/null
  printf 'base\n' > "$root/repo/f.txt"
  git -C "$root/repo" add f.txt
  git -C "$root/repo" commit -qm base
  echo "$root"
}
# A real linked worktree at the path the pipeline uses. Prints the path.
new_wt() {
  local root="$1" n="$2"
  git -C "$root/repo" worktree add -q -b "claude/issue-$n" "$root/repo/.claude/worktrees/issue-$n" >/dev/null 2>&1
  echo "$root/repo/.claude/worktrees/issue-$n"
}
# The session directory name Claude Code gives a working directory: every character
# that is not a letter, a digit or a hyphen becomes a hyphen.
slug() { printf '%s' "$1" | sed 's/[^A-Za-z0-9-]/-/g'; }

run() { PEER_ACTIVITY_SESSIONS_DIR="$1" "$PEER" "$2" "$3" 2>&1; }

echo "case 1 — no worktree and no session: must PASS (exit 0)"
R="$(new_env)"
out="$(run "$R/sessions" "$R/repo" 42)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 (no peer)" || bad "exit $rc, expected 0 ($out)"

echo "case 2 — worktree present but IDLE, no session, no process: must PASS"
# The false-positive direction. A worktree left behind by a finished pass is the
# common state. Flagging it would retire
# the issue from every future pass.
R="$(new_env)"
W="$(new_wt "$R" 43)"
out="$(run "$R/sessions" "$R/repo" 43)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 (present but idle)" || bad "exit $rc, expected 0 ($out)"

echo "case 3 — session transcript written JUST NOW: must FLAG (exit 5)"
R="$(new_env)"
W="$(new_wt "$R" 44)"
S="$R/sessions/$(slug "$W")"
mkdir -p "$S"; echo '{}' > "$S/abc.jsonl"
out="$(run "$R/sessions" "$R/repo" 44)"; rc=$?
[ "$rc" = 5 ] && ok "exit 5 (live session)" || bad "exit $rc, expected 5 ($out)"
case "$out" in *session*) ok "evidence names the session signal" ;;
              *) bad "evidence does not name the signal ($out)" ;; esac

echo "case 4 — session transcript is OLD: must PASS"
# The same directory, the same file, only the time differs. If this flagged, the
# check would be reading presence and calling it activity.
R="$(new_env)"
W="$(new_wt "$R" 45)"
S="$R/sessions/$(slug "$W")"
mkdir -p "$S"; echo '{}' > "$S/abc.jsonl"
touch -t "$(date -v-6H '+%Y%m%d%H%M' 2>/dev/null || date -d '6 hours ago' '+%Y%m%d%H%M')" "$S/abc.jsonl"
out="$(run "$R/sessions" "$R/repo" 45)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 (stale session)" || bad "exit $rc, expected 0 ($out)"

echo "case 5 — a session in a SUBDIRECTORY of the worktree: must FLAG"
# Claude Code names the directory after the session's working directory, so an
# agent that ran from a subdirectory inside the worktree gets its own slug:
# issue-12 and issue-12-src are two directories for one worktree. Matching the exact slug only would miss the second.
R="$(new_env)"
W="$(new_wt "$R" 46)"
mkdir -p "$W/apps/web"
S="$R/sessions/$(slug "$W/apps/web")"
mkdir -p "$S"; echo '{}' > "$S/abc.jsonl"
out="$(run "$R/sessions" "$R/repo" 46)"; rc=$?
[ "$rc" = 5 ] && ok "exit 5 (session below the worktree)" || bad "exit $rc, expected 5 ($out)"

echo "case 6 — a NEIGHBOUR worktree is live: must PASS for this issue"
# issue-470 must not answer for issue-47. A prefix match without a boundary test
# would flag every issue whose number is a prefix of a live one.
R="$(new_env)"
new_wt "$R" 47 >/dev/null; new_wt "$R" 470 >/dev/null
S="$R/sessions/$(slug "$R/repo/.claude/worktrees/issue-470")"
mkdir -p "$S"; echo '{}' > "$S/abc.jsonl"
out="$(run "$R/sessions" "$R/repo" 47)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 (neighbour is not this issue)" || bad "exit $rc, expected 0 ($out)"
out="$(run "$R/sessions" "$R/repo" 470)"; rc=$?
[ "$rc" = 5 ] && ok "exit 5 (the neighbour itself IS flagged)" || bad "exit $rc, expected 5 ($out)"

echo "case 7 — a REAL running process holding the worktree path: must FLAG"
# Signal B, proved with a real process, never a stub. This is the case the session
# signal cannot see: an agent runs tests inside the worktree while its transcript
# lives under the shared checkout's directory, so no session directory exists
# for the worktree.
R="$(new_env)"
W="$(new_wt "$R" 48)"
sh -c "cd '$W' && sleep 25" &
PEER_PID=$!
sleep 1
out="$(run "$R/sessions" "$R/repo" 48)"; rc=$?
[ "$rc" = 5 ] && ok "exit 5 (live process)" || bad "exit $rc, expected 5 ($out)"
case "$out" in *process*) ok "evidence names the process signal" ;;
              *) bad "evidence does not name the signal ($out)" ;; esac
kill "$PEER_PID" 2>/dev/null
wait "$PEER_PID" 2>/dev/null
sleep 1
out="$(run "$R/sessions" "$R/repo" 48)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 once the process exits" || bad "exit $rc, expected 0 ($out)"

echo "case 8 — the check must not see ITSELF as a peer"
# The caller's own command line can carry the worktree path. If the process scan
# counted its own ancestry, every issue would flag and the pass would do nothing.
R="$(new_env)"
W="$(new_wt "$R" 49)"
out="$(sh -c "cd '$W' && PEER_ACTIVITY_SESSIONS_DIR='$R/sessions' '$PEER' '$R/repo' 49" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 (self and ancestors excluded)" || bad "exit $rc, expected 0 ($out)"

echo "case 9 — the session root is MISSING: must be CANNOT MEASURE (exit 2)"
# Fail closed. An unreadable signal is not an absent peer, and a pass that reads
# it as one dispatches straight into the collision this guard exists to stop.
R="$(new_env)"
out="$(run "$R/sessions-does-not-exist" "$R/repo" 50)"; rc=$?
[ "$rc" = 2 ] && ok "exit 2 (cannot measure)" || bad "exit $rc, expected 2 ($out)"

echo "case 10 — a missing repository directory: must be CANNOT MEASURE (exit 2)"
R="$(new_env)"
out="$(run "$R/sessions" "$R/no-such-repo" 51)"; rc=$?
[ "$rc" = 2 ] && ok "exit 2 (cannot measure)" || bad "exit $rc, expected 2 ($out)"

echo "case A — a REAL rebase in flight: must FLAG (exit 5)"
# The collision this guard exists for: two agents in one worktree, both
# mid-rebase. One loses a resolved rebase to the other's `git rebase --abort`. NEITHER TREE WAS DIRTY — both were clean between
# commits — so worktree_claim.sh saw nothing to refuse.
# The rebase is created by really running git, never by making a directory, because
# a hand-made path would let the check pass while it read the wrong location.
R="$(new_env)"
W="$(new_wt "$R" 60)"
printf 'theirs\n' > "$R/repo/f.txt"
git -C "$R/repo" commit -qam theirs
printf 'ours\n' > "$W/f.txt"
git -C "$W" commit -qam ours
git -C "$W" rebase main >/dev/null 2>&1   # conflicts, and STOPS mid-rebase
gitdir="$(git -C "$W" rev-parse --absolute-git-dir)"
if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then
  ok "the fixture really is mid-rebase ($gitdir)"
else
  bad "CANNOT MEASURE: the fixture is not mid-rebase, so the next assertion proves nothing"
fi
out="$(run "$R/sessions" "$R/repo" 60)"; rc=$?
[ "$rc" = 5 ] && ok "exit 5 (rebase in flight)" || bad "exit $rc, expected 5 ($out)"
case "$out" in *rebase*) ok "evidence names the rebase" ;;
              *) bad "evidence does not name the rebase ($out)" ;; esac
git -C "$W" rebase --abort >/dev/null 2>&1
out="$(run "$R/sessions" "$R/repo" 60)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 once the rebase is finished" || bad "exit $rc, expected 0 ($out)"

echo "case B — a REAL merge in flight: must FLAG (exit 5)"
R="$(new_env)"
W="$(new_wt "$R" 61)"
printf 'theirs\n' > "$R/repo/f.txt"
git -C "$R/repo" commit -qam theirs
printf 'ours\n' > "$W/f.txt"
git -C "$W" commit -qam ours
git -C "$W" merge main >/dev/null 2>&1     # conflicts, leaving MERGE_HEAD
gitdir="$(git -C "$W" rev-parse --absolute-git-dir)"
[ -e "$gitdir/MERGE_HEAD" ] && ok "the fixture really is mid-merge" \
  || bad "CANNOT MEASURE: the fixture is not mid-merge"
out="$(run "$R/sessions" "$R/repo" 61)"; rc=$?
[ "$rc" = 5 ] && ok "exit 5 (merge in flight)" || bad "exit $rc, expected 5 ($out)"

echo "case C — the MAIN repository is mid-rebase, the worktree is not: must PASS"
# The path test. A linked worktree keeps its in-flight state under
# .git/worktrees/<name>/, not in the main .git. A check that read the main .git
# would flag every worktree whenever anyone rebased the shared checkout.
R="$(new_env)"
W="$(new_wt "$R" 62)"
mkdir -p "$R/repo/.git/rebase-merge"
out="$(run "$R/sessions" "$R/repo" 62)"; rc=$?
[ "$rc" = 0 ] && ok "exit 0 (the main repository's state is not this worktree's)" \
  || bad "exit $rc, expected 0 — the check is reading the wrong git directory ($out)"
rmdir "$R/repo/.git/rebase-merge"

echo "case D — a directory at the worktree path that git cannot read: CANNOT MEASURE"
# Clean is not free, and unreadable is not clear. This matches worktree_claim.sh,
# which exits 2 for the same condition.
R="$(new_env)"
mkdir -p "$R/repo/.claude/worktrees/issue-63"
out="$(run "$R/sessions" "$R/repo" 63)"; rc=$?
[ "$rc" = 2 ] && ok "exit 2 (cannot measure)" || bad "exit $rc, expected 2 ($out)"

echo "case 11 — the staleness window is a named constant, not a magic number"
if grep -qE '^[A-Z_]*WINDOW[A-Z_]*=' "$PEER"; then
  ok "a named window constant is present"
else
  bad "no named window constant found"
fi

echo "case 12 — the workflow's own verdict logic (peerVerdicts), both directions"
# Extracted from work_ready_workflow.js through its BEGIN/END markers, never from a
# copy: the workflow runtime evaluates that file as one script, so a duplicate here
# would drift and leave this suite green while the shipped gate fails open.
node - "$WORKFLOW" <<'NODE'
const { readFileSync } = require('node:fs')
const src = readFileSync(process.argv[2], 'utf8')
const m = src.match(/\/\/ --- BEGIN peerVerdicts[\s\S]*?\n([\s\S]*?)\/\/ --- END peerVerdicts ---/)
if (!m) {
  console.log('  FAIL — the peerVerdicts block was not found in work_ready_workflow.js (CANNOT MEASURE)')
  process.exit(1)
}
const peerVerdicts = new Function(m[1] + '\nreturn peerVerdicts')()
let bad = 0
const ok = (t) => console.log('  ok   — ' + t)
const no = (t) => { bad++; console.log('  FAIL — ' + t) }
const t = (name, got, want) => (got === want ? ok(name) : no(name + ' (got ' + got + ', wanted ' + want + ')'))

const clear = { items: [{ number: 1, exitCode: 0, evidence: 'no peer activity for #1' }] }
t('a measured exit 0 is NOT owned', peerVerdicts(clear, [1]).size, 0)

const live = { items: [{ number: 1, exitCode: 5, evidence: 'process 99 holds the worktree' }] }
t('a measured exit 5 IS owned', peerVerdicts(live, [1]).size, 1)
t('the evidence reaches the report',
  peerVerdicts(live, [1]).get(1), 'process 99 holds the worktree')

const cannot = { items: [{ number: 1, exitCode: 2, evidence: 'session root missing' }] }
t('exit 2 fails CLOSED, not open', peerVerdicts(cannot, [1]).size, 1)

t('a candidate with no verdict is owned', peerVerdicts({ items: [] }, [7]).size, 1)
t('a dead relay agent owns every candidate', peerVerdicts(null, [7, 8]).size, 2)
t('a verdict for an unasked issue is ignored',
  peerVerdicts({ items: [{ number: 9, exitCode: 5 }] }, [1, 9]).has(1), true)
t('...and does not clear the asked one', peerVerdicts({ items: [{ number: 9, exitCode: 0 }] }, [9]).size, 0)
process.exit(bad ? 1 : 0)
NODE
if [ $? = 0 ]; then PASS=$((PASS+8)); else FAIL=$((FAIL+1)); fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = 0 ]
