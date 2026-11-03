#!/usr/bin/env bash
# Merge one pull request through REST, and name the migrations to run after it.
#
# Usage: merge.sh <pr> [--repo owner/name] [--method merge|squash|rebase]
#
# Safe to run twice: a merged pull request is not merged again. A migration is a path in the
# marked section of the PR body, written by the addMigration tool.
#
# Prints JSON: {"pr":n,"merged":true,"alreadyMerged":bool,"sha":"...","base":"...","migrations":[...]}
# Exit: 0 merged, 1 GitHub refused (the message names the reason), 2 bad usage or no PR read.
set -euo pipefail

die() { echo "merge.sh: $2" >&2; exit "$1"; }
pr="" repo="${GH_REPO:-}" method=merge
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo needs owner/name}"; shift 2 ;;
    --method) method="${2:?--method needs merge, squash or rebase}"; shift 2 ;;
    -*) die 2 "unknown option $1. Usage: merge.sh <pr> [--repo owner/name] [--method merge|squash|rebase]" ;;
    *) pr="$1"; shift ;;
  esac
done
case "$pr" in ''|*[!0-9]*) die 2 "the pull request must be a number, and it is \"$pr\"" ;; esac
case "$method" in merge|squash|rebase) ;; *) die 2 "--method is \"$method\"; use merge, squash or rebase" ;; esac
if [ -z "$repo" ]; then
  # Local git: this costs no GitHub call.
  origin="$(git remote get-url origin)" || die 2 "this folder has no origin remote. Pass --repo owner/name"
  repo="$(sed -E 's#^.*github\.com[:/]##; s#\.git$##; s#/$##' <<<"$origin")"
  case "$repo" in */*) ;; *) die 2 "the origin \"$origin\" is not a GitHub repository. Pass --repo owner/name" ;; esac
fi

GHSH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../github" && pwd)/gh.sh"
export GH_REPO="$repo"
json="$(bash "$GHSH" pr-read "$pr")" || die 2 "gh.sh could not read PR #$pr of $repo (exit $?), see above"
migrations="$(jq -c '[(.body // "") | split("\n") as $l
  | ($l | index("<!-- ndev:migrations -->")) as $a | ($l | index("<!-- /ndev:migrations -->")) as $b
  | if $a and $b then $l[$a:$b][] else empty end
  | capture("^- `(?<p>[^`]+)`").p]' <<<"$json")"
base="$(jq -r .base.ref <<<"$json")"
already=false
if [ "$(jq -r .merged <<<"$json")" = true ]; then
  already=true
  sha="$(jq -r .merge_commit_sha <<<"$json")"
else
  state="$(jq -r .state <<<"$json")"
  [ "$state" = open ] || die 1 "PR #$pr of $repo is $state and not merged"
  [ "$(jq -r .draft <<<"$json")" = false ] || die 1 "PR #$pr of $repo is a draft. Repair: gh pr ready $pr --repo $repo"
  bash "$GHSH" pr-merge "$pr" --method "$method" >&2 || die 1 "GitHub refused the merge of PR #$pr of $repo (exit $?), see above"
  # The merge has happened, so a failed read here must not stop the migrations.
  if ! sha="$(bash "$GHSH" pr-read "$pr" | jq -er '.merge_commit_sha // empty')"; then
    echo "merge.sh: PR #$pr is merged, but its merge sha could not be read. Repair: gh pr view $pr --repo $repo --json mergeCommit" >&2
    sha=unknown
  fi
fi
jq -cn --argjson pr "$pr" --argjson already "$already" --arg sha "$sha" --arg base "$base" --argjson migrations "$migrations" \
  '{pr:$pr,merged:true,alreadyMerged:$already,sha:$sha,base:$base,migrations:$migrations}'
