#!/usr/bin/env bash
# Answer whether another live session is working an issue's worktree.
#
# Usage:  peer_activity.sh <repoDir> <issueNumber>
#
# Exit codes (the caller must branch on these — a non-zero is never a pass):
#   0  clear   — no evidence of a peer; the issue is safe to dispatch
#   2  cannot measure — a signal could not be read; refuse rather than guess
#   5  peer active — another session is working this worktree; do NOT dispatch
#
# 3 and 4 stay free, so this script and worktree_claim.sh never give one number
# two meanings. That is why an active peer is 5 and not 3.
#
# Why this exists. worktree_claim.sh reads tree state: it refuses a dirty worktree
# (exit 3) and one with unpushed commits (exit 4). A live session that has
# committed and pushed everything leaves a clean worktree. The claim guard would
# then give it to a second agent, and the two would corrupt one branch.
#
# Signals, in the order they are checked:
# C. A git operation in flight (rebase-merge, rebase-apply, MERGE_HEAD,
#    CHERRY_PICK_HEAD) in the worktree's own git directory. This is state, not a
#    guess, so it settles the question alone. A clean tree is NOT evidence that
#    nobody holds a worktree. A linked worktree keeps this state under
#    .git/worktrees/<name>/ of the main repository, so the path comes from
#    `git rev-parse --absolute-git-dir`, never from <worktree>/.git.
# A. A session transcript written in the window. Claude Code keeps one directory
#    per working directory under ~/.claude/projects/ (every character that is not
#    a letter, digit or hyphen becomes a hyphen) and appends to a .jsonl file on
#    every turn. It cannot see a session that runs in the shared checkout and
#    works on the worktree by absolute path; signal B covers that.
# B. A running process whose arguments hold the worktree path. It cannot see an
#    idle session between turns; signal A covers that.
#
# Rejected signal: file modification times in the worktree. `git worktree add`
# and package installs stamp many files, so the signal reports presence, not
# activity, and would retire most issues.
#
# The window applies to signal A only. A live session writes its transcript every
# few seconds; idle directories are hours old. 30 minutes sits well inside that
# gap. A tool call longer than the window is a running process, so signal B
# catches it. Override with PEER_ACTIVITY_WINDOW_MIN.
set -uo pipefail

# Minutes. See the reason above.
PEER_WINDOW_MINUTES="${PEER_ACTIVITY_WINDOW_MIN:-30}"
SESSIONS_ROOT="${PEER_ACTIVITY_SESSIONS_DIR:-$HOME/.claude/projects}"

REPO="${1:?repoDir required}"
N="${2:?issue number required}"

WT="$REPO/.claude/worktrees/issue-$N"

die() { echo "peer_activity: $2" >&2; exit "$1"; }

[ -d "$REPO" ] || die 2 "$REPO is not a directory — cannot measure peer activity"
[ -d "$SESSIONS_ROOT" ] || die 2 "the session root $SESSIONS_ROOT does not exist.
That is not proof that nobody is working #$N. Set PEER_ACTIVITY_SESSIONS_DIR or refuse the issue."

# The session directory name Claude Code gives a working directory.
slug="$(printf '%s' "$WT" | sed 's/[^A-Za-z0-9-]/-/g')" \
  || die 2 "cannot build the session directory name for $WT"

evidence=""

# --- Signal C: a rebase or a merge left in flight ------------------------------
# Checked first: it is the only signal that settles the question by itself.
if [ -d "$WT" ]; then
  # git walks UP from any directory, so a plain directory sitting at the worktree
  # path resolves to the MAIN repository and would be measured against its state.
  # Insist that the path really is the root of its own checkout before believing
  # any answer about it.
  top="$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null)" \
    || die 2 "$WT exists but git cannot read it — refusing to report #$N as clear"
  if [ "$(cd "$top" 2>/dev/null && pwd -P)" != "$(cd "$WT" 2>/dev/null && pwd -P)" ]; then
    die 2 "$WT is not the root of a git worktree (git reports $top) — cannot measure #$N"
  fi
  gitdir="$(git -C "$WT" rev-parse --absolute-git-dir 2>/dev/null)" \
    || die 2 "cannot resolve the git directory of $WT"
  [ -n "$gitdir" ] || die 2 "git returned no git directory for $WT — cannot measure"
  for state in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD; do
    if [ -e "$gitdir/$state" ]; then
      evidence="a git operation is in flight in $WT ($state is present in $gitdir)"
      break
    fi
  done
fi

# --- Signal A: a session transcript written inside the window -----------------
# The exact slug is the session that ran from the worktree root. "$slug-…" is a
# session that ran from a directory below it, which Claude Code names separately
# (issue-12 and issue-12-src are two directories for one worktree). The trailing hyphen is the boundary test that keeps issue-470 from
# answering for issue-47.
for d in "$SESSIONS_ROOT/$slug" "$SESSIONS_ROOT/$slug"-*; do
  [ -n "$evidence" ] && break
  [ -d "$d" ] || continue
  hit="$(find "$d" -type f -name '*.jsonl' -mmin "-$PEER_WINDOW_MINUTES" 2>/dev/null | head -1)" \
    || die 2 "cannot read the session directory $d"
  if [ -n "$hit" ]; then
    evidence="a session transcript under $(basename "$d") was written in the last $PEER_WINDOW_MINUTES minutes"
    break
  fi
done

# --- Signal B: a running process holding the worktree path --------------------
# Exclude this process and every one of its ancestors. The caller's own command
# line can carry the worktree path, and counting it would flag every issue.
if [ -z "$evidence" ]; then
  own=" $$ "
  p="$$"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    [ -n "$p" ] && [ "$p" != 0 ] && [ "$p" != 1 ] || break
    own="$own$p "
  done
  listing="$(ps -Ao pid=,args= 2>/dev/null)" \
    || die 2 "cannot list running processes — refusing to report #$N as clear"
  while IFS= read -r line; do
    pid="${line%% *}"
    case "$own" in *" $pid "*) continue ;; esac
    case "$line" in
      *"$WT "*|*"$WT/"*|*"$WT'"*|*"$WT\""*|*"$WT") evidence="process $pid holds $WT in its arguments"; break ;;
    esac
  done <<EOF
$(printf '%s\n' "$listing" | sed 's/^ *//')
EOF
fi

if [ -n "$evidence" ]; then
  echo "$evidence"
  exit 5
fi

echo "no peer activity for #$N (no rebase or merge in flight, no session transcript in the last $PEER_WINDOW_MINUTES minutes, no process holding $WT)"
exit 0
