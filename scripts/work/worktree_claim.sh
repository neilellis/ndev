#!/usr/bin/env bash
# Claim the worktree for one task without destroying anybody's work.
#
# Usage:  worktree_claim.sh <repoDir> <task> <baseRef> [<worktreeParent>]
#   <task>            issue number (gives branch <prefix>issue-<n>) or exact branch slug
#   <baseRef>         e.g. origin/main
#   <worktreeParent>  default <repoDir>/.claude/worktrees. Pass the Orca or other
#                     worktree folder when the project uses one.
#   WORKTREE_BRANCH_PREFIX  branch prefix (default "claude/")
#
# Exit codes (the caller must branch on these; a non-zero is never a pass):
#   0  ready          the worktree is prepared; its path is the last stdout line
#   2  cannot measure git did not answer; refuse rather than guess
#   3  dirty          the worktree holds uncommitted or untracked work; NOT yours
#   4  unpushed       the branch holds commits that are not on the remote; NOT yours
#
# The rule is fail closed. A worktree that already exists belongs to somebody
# until proved otherwise, and "proved" means committed AND pushed. This script
# never runs `worktree remove --force` and never runs `branch -D`.
# `git worktree add -B` reports a branch reset only as "was at <sha>", so a
# careless claim can silently discard another session's unpushed commits.
set -uo pipefail

# --- serialise prune and add against every other agent --------------------
# `git worktree prune` deletes any administrative directory under
# `.git/worktrees/` whose `gitdir` file is absent. A `git worktree add` that is
# still writing its bookkeeping is in exactly that state, so a prune running
# beside it deletes that add's own bookkeeping and the add dies with
#     fatal: failed to read .git/worktrees/<name>/commondir
# exit 128. Many agents can share one checkout, so the overlap is real.
# The prune cannot simply be dropped — without it an add at a stale-registered
# path fails with "is a missing but already registered worktree" — so prune and
# add are held together under one lock. `mkdir` is the primitive because it is
# atomic and macOS has no `flock`.
WT_LOCK=""
wt_lock_acquire() {
  local repo="$1" waited=0 common
  common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)" || return 2
  WT_LOCK="$common/worktree-add.lock.d"
  while ! mkdir "$WT_LOCK" 2>/dev/null; do
    # Reclaim only a lock whose holder is provably gone, else a killed agent
    # blocks every later run for ever.
    if [ -f "$WT_LOCK/pid" ]; then
      local holder; holder="$(cat "$WT_LOCK/pid" 2>/dev/null || echo "")"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$WT_LOCK"; continue; fi
    fi
    if [ "$waited" -ge 1200 ]; then
      echo "worktree lock still held after 120s: $WT_LOCK" >&2
      WT_LOCK=""; return 3
    fi
    sleep 0.1; waited=$((waited + 1))
  done
  echo "$$" > "$WT_LOCK/pid"
}
wt_lock_release() { [ -n "$WT_LOCK" ] && rm -rf "$WT_LOCK"; WT_LOCK=""; return 0; }

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0
fi
REPO="${1:?usage: worktree_claim.sh <repoDir> <task> <baseRef> [<worktreeParent>]}"
TASK="${2:?task (issue number or branch slug) required}"
BASE="${3:?base ref required, e.g. origin/main}"
PARENT="${4:-$REPO/.claude/worktrees}"

case "$TASK" in
  *[!0-9]*) LEAF="$TASK"; N="$TASK" ;;
  *)        LEAF="issue-$TASK"; N="#$TASK" ;;
esac
[[ "$LEAF" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { echo "worktree_claim: task '$TASK' is not a branch slug" >&2; exit 2; }
BRANCH="${WORKTREE_BRANCH_PREFIX-claude/}$LEAF"
WT="$PARENT/$LEAF"

die() { echo "worktree_claim: $2" >&2; exit "$1"; }

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die 2 "$REPO is not a git repository"
# A stale origin makes the unpushed-commit check below wrong, so a failed fetch stops the claim.
if ! fetch_out="$(git -C "$REPO" fetch origin --quiet 2>&1)"; then
  die 2 "git fetch origin failed in $REPO: $fetch_out
Repair: check the network and 'git -C $REPO remote -v', then run the claim again."
fi

if [ -d "$WT" ]; then
  git -C "$WT" rev-parse --git-dir >/dev/null 2>&1 \
    || die 2 "$WT exists but git cannot read it — refusing to touch it"

  # Uncommitted or untracked work.
  status="$(git -C "$WT" status --porcelain 2>/dev/null)" \
    || die 2 "cannot read the status of $WT"
  if [ -n "$status" ]; then
    echo "$status" >&2
    die 3 "$WT holds uncommitted work (above). Another session is most likely live in it.
Do NOT remove or reset it. Report the task as owned and move on."
  fi

  # Committed but never pushed. Recreating the worktree would reset these away.
  head="$(git -C "$WT" rev-parse HEAD 2>/dev/null)" || die 2 "cannot read HEAD of $WT"
  if git -C "$WT" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1; then
    unpushed="$(git -C "$WT" rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null)" \
      || die 2 "cannot compare $BRANCH with its remote"
  else
    unpushed="$(git -C "$WT" rev-list --count "$BASE..HEAD" 2>/dev/null)" \
      || die 2 "cannot compare $WT with the base ref $BASE. Repair: check that $BASE exists ('git -C $REPO rev-parse $BASE')"
  fi
  if [ "${unpushed:-0}" != "0" ]; then
    die 4 "$WT is $unpushed commit(s) ahead of the remote at $head.
Those commits exist nowhere else. Do NOT reset the branch. Report the task as owned and move on."
  fi

  # Clean and fully pushed: reuse it as it stands. Never re-create, because
  # re-creating is what resets the branch.
  echo "worktree_claim: reusing the existing clean worktree for $N" >&2
  echo "$WT"
  exit 0
fi

# No worktree on disk. A local branch may still carry unpushed commits, and
# `worktree add -B` would reset it, so check before creating.
if git -C "$REPO" rev-parse --verify --quiet "$BRANCH" >/dev/null 2>&1; then
  if git -C "$REPO" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1; then
    ahead="$(git -C "$REPO" rev-list --count "origin/$BRANCH..$BRANCH" 2>/dev/null)" \
      || die 2 "cannot compare the local branch $BRANCH with origin/$BRANCH"
  else
    ahead="$(git -C "$REPO" rev-list --count "$BASE..$BRANCH" 2>/dev/null)" \
      || die 2 "cannot compare the local branch $BRANCH with the base ref $BASE. Repair: check that $BASE exists ('git -C $REPO rev-parse $BASE')"
  fi
  if [ "${ahead:-0}" != "0" ]; then
    die 4 "the local branch $BRANCH is $ahead commit(s) ahead of the remote.
Creating the worktree with -B would reset them away. Report the task as owned and move on."
  fi
fi

mkdir -p "$PARENT"

wt_lock_acquire "$REPO" || die 2 "could not take the worktree lock for $N. If no claim is running, remove the stale lock: rm -rf \"$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/worktree-add.lock.d\""
if ! prune_out="$(git -C "$REPO" worktree prune 2>&1)"; then
  wt_lock_release
  die 2 "git worktree prune failed in $REPO for $N: $prune_out"
fi

# -B is safe ONLY because the checks above proved nothing unpushed is at risk.
if ! git -C "$REPO" worktree add "$WT" -B "$BRANCH" "$BASE" >/dev/null 2>&1; then
  # Re-run for the message. The lock is still held, so the retry sees the same
  # state the failure saw and the reported reason is the real one.
  git -C "$REPO" worktree add "$WT" -B "$BRANCH" "$BASE" >&2
  wt_lock_release
  die 2 "could not create the worktree for $N"
fi
wt_lock_release

echo "$WT"
exit 0
