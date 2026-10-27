#!/usr/bin/env bash
# Compact GitHub reads and writes. Each read prints one JSON object per line.
#
# Usage:
#   gh.sh milestones                                   # all milestones with exact titles
#   gh.sh issues-by-milestone "<title>"                # issues in a milestone (exact title)
#   gh.sh issue-new --title <t> --body-file <f> [--label <l>]...
#   gh.sh issue-edit <n> [--title <t>] [--body-file <f>]
#   gh.sh pr-new --title <t> --body-file <f> [--base <b>] [--head <h>] [--ready]   # draft by default
#   gh.sh pr-edit <n> [--title <t>] [--body <t> | --body-file <f>]               # REST edit
#   gh.sh unlabel <n> <label>                          # issue or PR
#   gh.sh labelled <label>                             # open issues and PRs with this label
#   gh.sh unpushed                                     # local commits on no remote
#   gh.sh subissues link <parent> <child>... | list <parent>
#   gh.sh blocked-by add|remove <n> <blocker>... | list <n> | blocking <n>
#   gh.sh board items [<column>]                       # needs GH_PROJECT_OWNER, GH_PROJECT_NUMBER
#   gh.sh board move <itemId> <column>                 # column display name, e.g. "In progress"
#   gh.sh board set <itemId> <field> <option>          # any single-select field, e.g. Priority
#   gh.sh board add <issue> [<column>]
#   gh.sh wait-for-pr <n> [options]                    # runs wait-for-pr-change.sh
#   gh.sh help
#
# Environment: GH_REPO, GH_USE_KEYRING, GH_PROJECT_OWNER, GH_PROJECT_NUMBER (see lib.sh).
# GH_PROSE_CHECK, if set, is a command run as `$GH_PROSE_CHECK <body-file>` before a post;
# a failure refuses the post.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"

die() { echo "gh.sh: $1" >&2; exit "${2:-2}"; }

need_repo() { gh_resolve_repo || exit 1; }

check_body() {
  local file="$1"
  [ -f "$file" ] || die "no such body file: $file. Write the body to a file first."
  if [ -n "${GH_PROSE_CHECK:-}" ]; then
    # shellcheck disable=SC2086 # GH_PROSE_CHECK can hold a command and its arguments.
    if ! $GH_PROSE_CHECK "$file"; then
      die "refusing to post: '$GH_PROSE_CHECK $file' reported errors. Fix them in $file and run again." 3
    fi
  fi
}

# --- project board ---------------------------------------------------------
board_env() {
  [ -n "${GH_PROJECT_OWNER:-}" ] && [ -n "${GH_PROJECT_NUMBER:-}" ] \
    || die "board commands need GH_PROJECT_OWNER and GH_PROJECT_NUMBER. Find them with: gh project list --owner <owner>"
}

project_id() {
  local id
  id="$(GH project view "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" --format json --jq .id 2>&1)" \
    || die "cannot read project $GH_PROJECT_OWNER/$GH_PROJECT_NUMBER: $id. If the token lacks the project scope, run: gh auth refresh -s project (or set GH_USE_KEYRING=1)" 1
  printf '%s\n' "$id"
}

# Print "<fieldId> <optionId>" for a single-select field and option, matched by name (case-insensitive).
field_option() {
  local field="$1" option="$2" json
  json="$(GH project field-list "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" --format json 2>&1)" \
    || die "cannot list fields of project $GH_PROJECT_OWNER/$GH_PROJECT_NUMBER: $json" 1
  FIELD="$field" OPTION="$option" python3 -c '
import json, os, sys
data = json.load(sys.stdin)
want_field, want_option = os.environ["FIELD"], os.environ["OPTION"]
for field in data.get("fields", []):
    if field.get("name", "").casefold() == want_field.casefold():
        names = [opt.get("name", "") for opt in field.get("options", [])]
        for opt in field.get("options", []):
            if opt.get("name", "").casefold() == want_option.casefold():
                print(field["id"], opt["id"]); sys.exit(0)
        sys.exit("gh.sh: field %r has no option %r. Options: %s" % (want_field, want_option, names))
sys.exit("gh.sh: project has no single-select field %r. List fields with: gh project field-list <number> --owner <owner>" % want_field)
' <<<"$json"
}

board_set() {
  local item="$1" field="$2" option="$3" pid ids
  pid="$(project_id)"
  ids="$(field_option "$field" "$option")" || exit 2
  GH project item-edit --id "$item" --project-id "$pid" \
    --field-id "${ids%% *}" --single-select-option-id "${ids##* }" >/dev/null
  echo "set $item $field -> $option"
}

# Board cards, optionally filtered by Status column. A lean GraphQL query: it reads only Status.
board_items() {
  local want="${1:-}" pid
  pid="$(project_id)"
  GH api graphql --paginate -f query='
    query($endCursor: String) {
      node(id: "'"$pid"'") {
        ... on ProjectV2 {
          items(first: 100, after: $endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              content { ... on Issue { number title url } ... on PullRequest { number title url } }
              status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            }
          }
        }
      }
    }' \
  | jq -c --arg want "$want" '
      .data.node.items.nodes[]
      | {number: .content.number, title: .content.title, status: (.status.name // null), itemId: .id, url: .content.url}
      | select($want == "" or .status == $want)'
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  milestones)
    need_repo
    GH api "repos/$REPO/milestones?state=all&per_page=100" \
      --jq '.[] | {title, state, open_issues, closed_issues, due_on, number}'
    ;;

  issues-by-milestone)
    need_repo
    want="${1:?milestone title required}"
    GH issue list --repo "$REPO" --milestone "$want" --state all --limit 200 \
      --json number,title,state,labels,milestone,url \
      --jq '.[] | {number, title, state, milestone: .milestone.title, labels: [.labels[].name], url}'
    ;;

  issue-new)
    need_repo
    title=""; bodyfile=""; labels=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)     title="$2"; shift 2 ;;
        --body-file) bodyfile="$2"; shift 2 ;;
        --label)     labels+=(-f "labels[]=$2"); shift 2 ;;
        *) die "usage: gh.sh issue-new --title <t> --body-file <f> [--label <l>]..." ;;
      esac
    done
    [ -n "$title" ] && [ -n "$bodyfile" ] || die "issue-new: --title and --body-file are both required"
    check_body "$bodyfile"
    url="$(GH api -X POST "repos/$REPO/issues" -f "title=$title" -F "body=@$bodyfile" ${labels[@]+"${labels[@]}"} --jq '.html_url')"
    echo "{\"url\": \"$url\"}"
    ;;

  issue-edit)
    need_repo
    n="${1:?issue number required}"; shift
    args=(); bodyfile=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)     args+=(-f "title=$2"); shift 2 ;;
        --body-file) bodyfile="$2"; args+=(-F "body=@$2"); shift 2 ;;
        *) die "usage: gh.sh issue-edit <n> [--title <t>] [--body-file <f>]" ;;
      esac
    done
    [ ${#args[@]} -gt 0 ] || die "issue-edit: nothing to change"
    [ -z "$bodyfile" ] || check_body "$bodyfile"
    GH api -X PATCH "repos/$REPO/issues/$n" "${args[@]}" --jq '{number, url: .html_url}' | jq -c .
    ;;

  pr-new)
    need_repo
    title=""; bodyfile=""; base=""; head=""; draft="true"
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)     title="$2"; shift 2 ;;
        --body-file) bodyfile="$2"; shift 2 ;;
        --base)      base="$2"; shift 2 ;;
        --head)      head="$2"; shift 2 ;;
        --draft)     draft="true"; shift ;;
        --ready)     draft="false"; shift ;;
        *) die "usage: gh.sh pr-new --title <t> --body-file <f> [--base <b>] [--head <h>] [--ready]" ;;
      esac
    done
    [ -n "$title" ] && [ -n "$bodyfile" ] || die "pr-new: --title and --body-file are both required"
    [ -n "$head" ] || head="$(git rev-parse --abbrev-ref HEAD)"
    [ -n "$base" ] || base="$(GH repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)"
    check_body "$bodyfile"
    url="$(GH api -X POST "repos/$REPO/pulls" -f "title=$title" -F "body=@$bodyfile" \
             -f "head=$head" -f "base=$base" -F "draft=$draft" --jq '.html_url')"
    echo "{\"url\": \"$url\"}"
    ;;

  pr-edit)
    # REST edit. `gh pr edit` fails on some repositories (Projects classic GraphQL deprecation).
    need_repo
    n="${1:?PR number required}"; shift || true
    args=(); tmpf=""; bodyfile=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)     args+=(-f "title=$2"); shift 2 ;;
        --body)      tmpf="$(mktemp)"; printf '%s' "$2" > "$tmpf"; args+=(-F "body=@$tmpf"); bodyfile="$tmpf"; shift 2 ;;
        --body-file) bodyfile="$2"; args+=(-F "body=@$2"); shift 2 ;;
        *) die "pr-edit: unknown argument '$1' (use --title, --body or --body-file)" ;;
      esac
    done
    [ ${#args[@]} -gt 0 ] || die "pr-edit: nothing to change"
    [ -z "$bodyfile" ] || check_body "$bodyfile"
    GH api -X PATCH "repos/$REPO/pulls/$n" "${args[@]}" --jq '{number, url: .html_url}'
    if [ -n "$tmpf" ]; then rm -f "$tmpf"; fi
    ;;

  unlabel)
    need_repo
    n="${1:?issue or PR number required}"; lab="${2:?label required}"
    GH api -X DELETE "repos/$REPO/issues/$n/labels/$lab" >/dev/null
    echo "removed '$lab' from #$n"
    ;;

  labelled)
    need_repo
    lab="${1:?label required}"
    GH api "repos/$REPO/issues?labels=$lab&state=open&per_page=100" \
      --jq '.[] | {number, title, kind: (if .pull_request then "pr" else "issue" end), url: .html_url}'
    ;;

  unpushed)
    # Commits on a local branch and on no remote: work lost if a branch or worktree is discarded.
    git log --branches --not --remotes --format='%h%x09%D%x09%s' \
      | python3 -c '
import sys, json
n = 0
for line in sys.stdin:
    sha, refs, sub = (line.rstrip("\n").split("\t", 2) + ["", "", ""])[:3]
    print(json.dumps({"sha": sha, "refs": refs.strip(), "subject": sub})); n += 1
if n == 0:
    print(json.dumps({"unpushed": 0}))
'
    ;;

  subissues)
    need_repo
    sub="${1:-help}"; shift || true
    case "$sub" in
      link)
        parent="${1:?parent issue number required}"; shift
        [ $# -gt 0 ] || die "usage: gh.sh subissues link <parent> <child>..."
        for c in "$@"; do
          dbid="$(GH api "repos/$REPO/issues/$c" --jq '.id')"
          GH api -X POST "repos/$REPO/issues/$parent/sub_issues" -F "sub_issue_id=$dbid" >/dev/null
          echo "linked #$c -> #$parent"
        done
        ;;
      list)
        parent="${1:?parent issue number required}"
        GH api "repos/$REPO/issues/$parent/sub_issues?per_page=100" --jq '.[] | {number, title, state, url: .html_url}'
        ;;
      *) die "usage: gh.sh subissues link <parent> <child>... | list <parent>" ;;
    esac
    ;;

  blocked-by)
    # A hard dependency: the blocker must close first. Two cards you work yourself are a commit order in one PR, not a block.
    need_repo
    sub="${1:-help}"; shift || true
    case "$sub" in
      add|remove)
        n="${1:?issue number required}"; shift
        [ $# -gt 0 ] || die "usage: gh.sh blocked-by $sub <n> <blocker>..."
        for b in "$@"; do
          dbid="$(GH api "repos/$REPO/issues/$b" --jq '.id')"
          if [ "$sub" = add ]; then
            GH api -X POST "repos/$REPO/issues/$n/dependencies/blocked_by" -F "issue_id=$dbid" >/dev/null
            echo "#$n blocked by #$b"
          else
            GH api -X DELETE "repos/$REPO/issues/$n/dependencies/blocked_by/$dbid" >/dev/null
            echo "#$n no longer blocked by #$b"
          fi
        done
        ;;
      list|blocking)
        n="${1:?issue number required}"
        path=blocked_by; [ "$sub" = blocking ] && path=blocking
        GH api "repos/$REPO/issues/$n/dependencies/$path?per_page=100" --jq '.[] | {number, title, state, url: .html_url}'
        ;;
      *) die "usage: gh.sh blocked-by add|remove <n> <blocker>... | list <n> | blocking <n>" ;;
    esac
    ;;

  board)
    board_env
    sub="${1:-help}"; shift || true
    case "$sub" in
      items) board_items "${1:-}" ;;
      move)  board_set "${1:?item id (PVTI_...) required}" Status "${2:?column name required}" ;;
      set)   board_set "${1:?item id required}" "${2:?field name required}" "${3:?option name required}" ;;
      add)
        need_repo
        n="${1:?issue number required}"; column="${2:-}"
        item="$(GH project item-add "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" \
                  --url "https://github.com/$REPO/issues/$n" --format json --jq .id)"
        echo "{\"number\": $n, \"itemId\": \"$item\"}"
        [ -z "$column" ] || board_set "$item" Status "$column"
        ;;
      *) die "usage: gh.sh board items [<column>] | move <itemId> <column> | set <itemId> <field> <option> | add <issue> [<column>]" ;;
    esac
    ;;

  wait-for-pr|wait-for-pr-change)
    exec "$DIR/wait-for-pr-change.sh" "$@"
    ;;

  help|--help|-h)
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;

  *)
    die "unknown command '$cmd'. Run: gh.sh help" 1
    ;;
esac
