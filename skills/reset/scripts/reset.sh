#!/usr/bin/env bash
# reset.sh — the git/gh plumbing behind the `reset` skill (see ../SKILL.md).
#
# The skill's SKILL.md is the orchestrator; this script does the deterministic,
# cwd-safe parts. The one thing it CANNOT do is move the calling session's cwd
# out of a worktree before deleting it — that's the harness ExitWorktree tool's
# job (or Orca's worktree removal). So `remove` here is the fallback path only.
#
# Verbs:
#   reset.sh state                          # JSON: where are we, is there work to finish (no side effects)
#   reset.sh save [commit message...]       # commit (dirty) + push branch + ensure an open PR exists
#   reset.sh remove <worktree> <main_root>  # FALLBACK: git worktree remove --force + prune; refuses the main checkout
#   reset.sh freshen <main_root>            # git checkout <base> + pull --ff-only origin <base>
#
# Base branch: $RESET_BASE, else origin/HEAD, else main.
# Trailers: set COMMIT_TRAILERS to the trailer lines the session requires (for example
# the Co-Authored-By line from the harness attribution). PR_FOOTER is appended to a new PR body.
# Auth: GH_USE_KEYRING=1 drops GITHUB_TOKEN so the gh keyring login is used.
set -euo pipefail

# --- serialise prune and add against every other agent --------------------
# `git worktree prune` deletes any administrative directory under
# `.git/worktrees/` whose `gitdir` file is absent. A `git worktree add` that is
# still writing its bookkeeping is in exactly that state, so a prune running
# beside it deletes that add's own bookkeeping and the add dies with
#     fatal: failed to read .git/worktrees/<name>/commondir
# exit 128. Many agents share this one checkout, so the overlap is real:
# measured on git 2.49.0 at roughly 8 failures per 1200 concurrent adds.
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

GH() {
  if [ "${GH_USE_KEYRING:-0}" = "1" ]; then env -u GITHUB_TOKEN gh "$@"; else gh "$@"; fi
}

_base() {
  if [ -n "${RESET_BASE:-}" ]; then printf '%s\n' "$RESET_BASE"; return; fi
  local b
  b="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  b="${b#origin/}"
  printf '%s\n' "${b:-main}"
}

# Resolve worktree/main-root/branch. GIT_DIR==GIT_COMMON => main working tree.
_paths() {
  GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
  GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
  MAIN_ROOT=$(git -C "$GIT_COMMON/.." rev-parse --show-toplevel 2>/dev/null || echo "")
  WORKTREE=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  [ "$GIT_DIR" = "$GIT_COMMON" ] && IN_WORKTREE=no || IN_WORKTREE=yes
}

_trailers() { printf '%s\n' "${COMMIT_TRAILERS:-}"; }

_pr_footer() { printf '%s\n' "${PR_FOOTER:-}"; }

_commit() {
  if [ -n "${COMMIT_TRAILERS:-}" ]; then git commit -q "$@" -m "$(_trailers)"; else git commit -q "$@"; fi
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  state)
    _paths
    dirty=no; [ -n "$(git status --porcelain)" ] && dirty=yes
    base=$(_base)
    pr=$(GH pr list --head "$BRANCH" --state open --json url --jq '.[0].url // ""' 2>/dev/null || echo "")
    python3 - "$IN_WORKTREE" "$BRANCH" "$WORKTREE" "$MAIN_ROOT" "$dirty" "$pr" "$base" <<'PY'
import json, sys
iw, branch, wt, root, dirty, pr, base = sys.argv[1:8]
print(json.dumps({
    "in_worktree": iw == "yes",
    "branch": branch,
    "base": base,
    "on_base": branch == base,
    "worktree": wt,
    "main_root": root,
    "dirty": dirty == "yes",
    "pr_url": pr or None,
}))
PY
    ;;

  save)
    _paths
    if [ "$IN_WORKTREE" != yes ]; then
      echo "refusing: not inside a worktree (nothing to finish)" >&2; exit 2
    fi
    base=$(_base)
    case "$BRANCH" in
      "$base"|main|master) echo "refusing: on $BRANCH — reset never finishes onto the base branch" >&2; exit 2 ;;
      HEAD)        echo "refusing: detached HEAD — no branch to push/PR" >&2; exit 2 ;;
    esac

    msg="$*"
    if [ -n "$(git status --porcelain)" ]; then
      files=$(git status --porcelain | sed 's/^...//')
      git add -A
      if [ -n "$msg" ]; then
        _commit -m "$msg"
      else
        _commit -m "chore(reset): finish $BRANCH" -m "$(printf 'Changed:\n%s' "$files")"
      fi
      echo "committed $(git rev-parse --short HEAD) on $BRANCH"
    else
      echo "nothing to commit on $BRANCH"
    fi

    git push -q -u origin "$BRANCH"
    echo "pushed $BRANCH"

    pr=$(GH pr list --head "$BRANCH" --state open --json url --jq '.[0].url // ""' 2>/dev/null || echo "")

    # No OPEN PR — before creating one, check whether the branch's most recent PR
    # (any state) already covers this exact commit. Squash-merges break commit-graph
    # ancestry (the branch's original commit is never actually an ancestor of main),
    # so a branch whose PR was already squash-merged still looks "ahead" — without
    # this check that falsely triggers a brand-new duplicate PR for already-landed
    # work every time `save` runs again with nothing new to commit.
    if [ -z "$pr" ]; then
      head_sha=$(git rev-parse HEAD)
      last=$(GH pr list --head "$BRANCH" --state all --json number,url,state,headRefOid \
        --jq 'sort_by(.number) | reverse | .[0] // empty' 2>/dev/null || echo "")
      if [ -n "$last" ]; then
        fields=$(printf '%s' "$last" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("headRefOid",""), d.get("state",""), d.get("url",""), d.get("number",""))
')
        read -r last_sha last_state last_url last_num <<< "$fields"
        if [ "$last_sha" = "$head_sha" ]; then
          case "$last_state" in
            MERGED)
              pr="$last_url"
              echo "branch already merged via $pr (no new commits since) — not opening a duplicate" >&2
              ;;
            CLOSED)
              if GH pr reopen "$last_num" >/dev/null 2>&1; then
                pr="$last_url"
                echo "reopened $pr (no new commits since it was closed)" >&2
              fi
              ;;
          esac
        fi
      fi
    fi

    if [ -z "$pr" ]; then
      title="$BRANCH"
      if [ -n "$msg" ]; then title="${msg%%$'\n'*}"; fi
      body=$(printf 'Automated finish of `%s` via the reset skill.\n\n%s' "$BRANCH" "$(_pr_footer)")
      if ! out=$(GH pr create --base "$base" --head "$BRANCH" --title "$title" --body "$body" 2>&1); then
        echo "reset: gh pr create failed for $BRANCH -> $base: $out" >&2
        echo "  Repair: run 'gh auth status', then 'gh pr create --base $base --head $BRANCH' by hand." >&2
        exit 1
      fi
      pr=$(printf '%s\n' "$out" | grep -Eo 'https://github.com/[^ ]+/pull/[0-9]+' | head -1 || true)
    fi
    echo "PR_URL=${pr:-none}"
    echo "WORKTREE=$WORKTREE"
    echo "MAIN_ROOT=$MAIN_ROOT"
    ;;

  remove)
    wt="${1:?worktree path required}"; root="${2:?main root required}"
    [ -n "$wt" ] && [ -n "$root" ] || { echo "bad args" >&2; exit 2; }
    wt_real=$(cd "$wt" 2>/dev/null && pwd -P) || { echo "refusing: '$wt' does not exist" >&2; exit 2; }
    root_real=$(cd "$root" 2>/dev/null && pwd -P) || { echo "refusing: main root '$root' does not exist" >&2; exit 2; }
    [ "$wt_real" != "$root_real" ] || { echo "refusing: '$wt' is the main checkout" >&2; exit 2; }
    git -C "$root" worktree list --porcelain | grep -qxF "worktree $wt_real" \
      || { echo "refusing: '$wt' is not a registered worktree of $root (see: git -C $root worktree list)" >&2; exit 2; }
    # Under the lock: this prune deletes the bookkeeping of any `worktree add`
    # another agent is part-way through in this checkout, killing it with
    # "failed to read .git/worktrees/<name>/commondir".
    wt_lock_acquire "$root" || { echo "could not take the worktree lock" >&2; exit 2; }
    # `set -e` is on, so the failure must be caught inline: a bare call would
    # abort before the lock is released and leave it blocking every later run.
    rc=0; git -C "$root" worktree remove --force "$wt" || rc=$?
    git -C "$root" worktree prune
    wt_lock_release
    [ "$rc" -eq 0 ] || { echo "worktree remove failed for $wt" >&2; exit "$rc"; }
    echo "removed worktree $wt"
    ;;

  freshen)
    root="${1:?main root required}"
    base=$(cd "$root" && _base)
    git -C "$root" checkout -q "$base"
    git -C "$root" pull --ff-only origin "$base"
    echo "$base @ $(git -C "$root" rev-parse --short HEAD)"
    ;;

  help|--help|-h)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;

  *)
    echo "unknown verb '$cmd' — run 'reset.sh help'" >&2
    exit 1
    ;;
esac
