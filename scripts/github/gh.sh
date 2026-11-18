#!/usr/bin/env bash
# Compact GitHub reads and writes. Each read prints one JSON object per line. All of ndev reaches
# GitHub through this script, so the rule below holds in one place.
#
# The rule: the gh command first, and REST when it fails. The two use separate quotas (gh commands
# spend GraphQL points, gh api spends REST calls), so one still answers when the other is used up.
# Both routes print the same shape, the shape of REST. A note on stderr says when REST answered.
#   A read, or a write that changes nothing when repeated, goes to REST on any failure.
#   A post (comment, review, new issue or PR) goes to REST on a rate limit only: after another
#   failure it may already be on GitHub, and a second try would post it twice.
#
# Usage:
#   gh.sh repo                                         # {repo}. Reads the origin remote: no GitHub call
#   gh.sh default-branch                               # {default_branch}
#   gh.sh issue-read <n>                               # {number,title,state,body,url}
#   gh.sh pr-read <n>                                  # {number,state,merged,draft,mergeable,mergeable_state,...}
#   gh.sh pr-list [--head <branch>] [--state open|closed|all] [--limit <n>]     # one line per PR
#   gh.sh pr-rows [--limit <n>]     # your open PRs with merge state and checks, in one call; gh's shape; no REST route
#   gh.sh commit-checks <sha> [--pr <n>]               # {check_runs,statuses}. --pr: one gh call, only the runs of the PR's branch
#   gh.sh feedback <issue> <pr>                        # one line per comment, review and inline comment
#   gh.sh comment <n> --body <t>                       # issue or PR
#   gh.sh pr-review <n> --commit <sha> --body <t>      # a comment review
#   gh.sh pr-ready <n>                                 # leave draft. REST has no way to do this
#   gh.sh label <n> <label>                            # issue or PR
#   gh.sh pr-merge <n> --method merge|squash|rebase [--stack]   # a stacked PR goes through merge-async; --stack lets it merge the open PRs below
#   gh.sh me                                           # {login} of the signed-in user
#   gh.sh repo-read                                    # {full_name,default_branch,allow_merge_commit,...}
#   gh.sh pr-commit-messages <n>                       # the commit messages of a PR
#   gh.sh rerun-failed <run id>                        # rerun the failed jobs of an Actions run
#   gh.sh issue-search <query> [--limit <n>]           # open issues: one line of {number,title,url} each
#   gh.sh view-json pr|issue <n|branch|url> --fields <f>   # gh's own shape for fields REST lacks. No REST route
#   gh.sh view-json pr --open [--limit <n>] --fields <f>    # one line per open PR, gh's shape. No REST route
#   gh.sh run-status <run id>                          # {status} of an Actions run
#   gh.sh pr-diff <n>                                  # the diff of a PR
#   gh.sh pr-commit-dates <n>                          # one committer date per line
#   gh.sh pr-search <query> [--limit <n>]              # PRs of any state: {number,title,state,merged,created_at,merged_at,url,user,body}
#   gh.sh pr-reopen <n>
#   gh.sh project-list <owner>                         # the owner's project boards. GraphQL only: no REST route
#   gh.sh api <arguments of gh api>                    # for an endpoint that has no gh command
#   gh.sh milestones                                   # all milestones with exact titles
#   gh.sh issues-by-milestone "<title>"                # issues in a milestone (exact title)
#   gh.sh issue-new --title <t> --body-file <f> [--label <l>]... [--assignee <login>]... [--milestone <n>] [--type <t>]
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
#   gh.sh board fields                                 # each field: {name,type,options}
#   gh.sh board set <itemId> <field> <value>           # single-select, iteration, number, text or date
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
    || die "board commands need GH_PROJECT_OWNER and GH_PROJECT_NUMBER, and .neil-dev.json names no board. Repair: run /dev-setup in Claude Code, or find them with: gh project list --owner <owner>"
}

project_id() {
  local id
  id="$(GH project view "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" --format json --jq .id 2>&1)" \
    || die "cannot read project $GH_PROJECT_OWNER/$GH_PROJECT_NUMBER: $id. If the token lacks the project scope, run: gh auth refresh -s project (or set GH_USE_KEYRING=1)" 1
  printf '%s\n' "$id"
}

# Every board field with its type, single-select options and iterations, as GitHub's GraphQL JSON.
board_fields_raw() {
  local pid="$1" json
  json="$(GH api graphql -f query='
    query {
      node(id: "'"$pid"'") {
        ... on ProjectV2 {
          fields(first: 100) {
            nodes {
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { options { id name } }
              ... on ProjectV2IterationField { configuration { iterations { id title startDate } } }
            }
          }
        }
      }
    }' 2>&1)" \
    || die "cannot list fields of project $GH_PROJECT_OWNER/$GH_PROJECT_NUMBER: $json. If the token lacks the project scope, run: gh auth refresh -s project (or set GH_USE_KEYRING=1)" 1
  printf '%s\n' "$json"
}

# One line per field: {name,type,options}. options are single-select names or iteration titles.
board_fields() {
  board_fields_raw "$(project_id)" | jq -c '
    .data.node.fields.nodes[] | select(.name)
    | {name, type: .dataType, options: (((.options // []) | map(.name)) + ((.configuration.iterations // []) | map(.title)))}'
}

# Sets one field of a card, by field name and value, for every type a board item holds itself.
# Names match case-insensitively. A bad name or value stops before any edit, listing the choices.
board_set() {
  local item="$1" field="$2" value="$3" pid spec
  pid="$(project_id)"
  spec="$(board_fields_raw "$pid" | FIELD="$field" VALUE="$value" python3 -I -c '
import json, os, re, sys
want, value = os.environ["FIELD"], os.environ["VALUE"]
fields = [f for f in json.load(sys.stdin)["data"]["node"]["fields"]["nodes"] if f.get("name")]
field = next((f for f in fields if f["name"].casefold() == want.casefold()), None)
if field is None:
    sys.exit("gh.sh: project has no field %r. Fields: %s" % (want, [f["name"] for f in fields]))
kind = field.get("dataType")
def pick(choices, key):
    for c in choices:
        if c[key].casefold() == value.casefold():
            return c["id"]
    sys.exit("gh.sh: field %r has no option %r. Options: %s" % (field["name"], value, [c[key] for c in choices]))
if kind == "SINGLE_SELECT":
    flag, val = "--single-select-option-id", pick(field.get("options", []), "name")
elif kind == "ITERATION":
    flag, val = "--iteration-id", pick(field.get("configuration", {}).get("iterations", []), "title")
elif kind == "NUMBER":
    try: float(value)
    except ValueError: sys.exit("gh.sh: field %r is a number field; %r is not a number" % (field["name"], value))
    flag, val = "--number", value
elif kind == "DATE":
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        sys.exit("gh.sh: field %r is a date field; give YYYY-MM-DD, not %r" % (field["name"], value))
    flag, val = "--date", value
elif kind == "TEXT":
    flag, val = "--text", value
else:
    sys.exit("gh.sh: field %r (%s) belongs to the issue, not the board card; set it on the issue (labels, assignees, milestone, title) with gh.sh issue-new or gh issue edit" % (field["name"], kind))
print(field["id"]); print(flag); print(val)
')" || exit 2
  local fid flag val
  { IFS= read -r fid; IFS= read -r flag; IFS= read -r val; } <<<"$spec"
  GH project item-edit --id "$item" --project-id "$pid" --field-id "$fid" "$flag" "$val" >/dev/null
  echo "set $item $field -> $value"
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
              content { ... on Issue { number title url author { login } } ... on PullRequest { number title url author { login } } }
              status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            }
          }
        }
      }
    }' \
  | jq -c --arg want "$want" '
      .data.node.items.nodes[]
      | {number: .content.number, title: .content.title, status: (.status.name // null), itemId: .id, url: .content.url, author: (.content.author.login // null)}
      | select($want == "" or .status == $want)'
}

# --- the gh command first, then REST ---------------------------------------
REPAIR_QUOTA="Repair: run 'gh api rate_limit' to see each quota and when it is back; run 'gh auth status' if neither quota is used up."
one_line() { tr '\n' ' ' <"$1" | cut -c1-500; }
# The error text of a command: its stderr, or its stdout when stderr is empty.
said() {
  local text
  text="$(one_line "$1")"
  [ -n "$text" ] || text="$(tr '\n' ' ' <<<"$2" | cut -c1-500)"
  printf '%s' "${text:-no output}"
}

# gh_first <what> <jq filter, or "" to print as it came> <REST function> <arguments of gh>...
# The REST function prints the same shape. GH_FIRST_POST=1 sends a rate-limit failure only to REST.
gh_first() {
  local what="$1" filter="$2" rest="$3" err out code=0 why rcode=0 rwhy
  shift 3
  err="$(mktemp)"
  out="$(GH "$@" 2>"$err")" || code=$?
  if [ "$code" -eq 0 ]; then
    rm -f "$err"
    if [ -z "$filter" ]; then [ -z "$out" ] || printf '%s\n' "$out"; return 0; fi
    jq -c "$filter" <<<"$out" || die "$what: gh $1 $2 printed output that this script cannot read: ${out:0:300}" 1
    return 0
  fi
  why="$(said "$err" "$out")"
  if [ "${GH_FIRST_POST:-0}" = 1 ] && ! grep -qi 'rate limit' <"$err"; then
    rm -f "$err"
    die "$what: gh $1 $2 exited $code: $why. REST was not tried, because this may already be posted. Repair: look in $REPO on GitHub for it ($what), then run this again if it is not there." 1
  fi
  echo "gh.sh: $what: gh $1 $2 exited $code ($why). Trying REST." >&2
  out="$("$rest" 2>"$err")" || rcode=$?
  if [ "$rcode" -eq 0 ]; then
    rm -f "$err"
    echo "gh.sh: $what: REST answered." >&2
    [ -z "$out" ] || printf '%s\n' "$out"
    return 0
  fi
  rwhy="$(said "$err" "$out")"
  rm -f "$err"
  die "$what failed both ways. gh $1 $2 exited $code: $why. REST exited $rcode: $rwhy. $REPAIR_QUOTA" 1
}

# rest_first <what> <REST function> <GraphQL function>: for a read that has no gh command.
rest_first() {
  local what="$1" err out code=0 why gcode=0 gwhy
  err="$(mktemp)"
  out="$("$2" 2>"$err")" || code=$?
  if [ "$code" -ne 0 ]; then
    why="$(said "$err" "$out")"
    echo "gh.sh: $what: no gh command exists and REST exited $code ($why). Trying GraphQL." >&2
    out="$("$3" 2>"$err")" || gcode=$?
    if [ "$gcode" -ne 0 ]; then
      gwhy="$(said "$err" "$out")"
      rm -f "$err"
      die "$what failed both ways. REST exited $code: $why. GraphQL exited $gcode: $gwhy. $REPAIR_QUOTA" 1
    fi
  fi
  rm -f "$err"
  [ -z "$out" ] || printf '%s\n' "$out"
}

PR_FIELDS="number,state,isDraft,mergeable,mergeStateStatus,body,createdAt,headRefOid,headRefName,baseRefName,title,url,author,mergeCommit,isCrossRepository"
PR_FROM_GH='{number, title, state: (if .state == "MERGED" then "closed" else (.state | ascii_downcase) end), merged: (.state == "MERGED"), draft: .isDraft,
  mergeable: (if .mergeable == "MERGEABLE" then true elif .mergeable == "CONFLICTING" then false else null end),
  mergeable_state: (.mergeStateStatus | ascii_downcase), body, created_at: .createdAt, head: {sha: .headRefOid, ref: .headRefName, crossRepository: .isCrossRepository},
  base: {ref: .baseRefName}, url, user: {login: .author.login}, merge_commit_sha: .mergeCommit.oid}'
PR_FROM_REST='{number, title, state, merged: (.merged // false), draft, mergeable, mergeable_state, body, created_at, head: {sha: .head.sha, ref: .head.ref, crossRepository: (if .head.repo and .base.repo then .head.repo.id != .base.repo.id else null end)},
  base: {ref: .base.ref}, url: .html_url, user: {login: .user.login}, merge_commit_sha}'
LISTED_OBJ_GH='{number, title, state: (if .state == "MERGED" then "closed" else (.state | ascii_downcase) end), merged: (.state == "MERGED"), draft: .isDraft,
  created_at: .createdAt, head: {sha: .headRefOid, ref: .headRefName}, url, user: {login: .author.login}}'
LISTED_OBJ_REST='{number, title, state, merged: (.merged_at != null), draft, created_at, head: {sha: .head.sha, ref: .head.ref}, url: .html_url, user: {login: .user.login}}'
LISTED_FROM_GH=".[] | $LISTED_OBJ_GH"
LISTED_FROM_REST=".[] | $LISTED_OBJ_REST"
# A search finds a PR without its branch. It carries the body and the merge time.
FOUND_FROM_GH='.[] | {number, title, state: (if .state == "MERGED" then "closed" else (.state | ascii_downcase) end), merged: (.state == "MERGED"),
  created_at: .createdAt, merged_at: .mergedAt, url, user: {login: .author.login}, body: (.body // "")}'
FOUND_FROM_REST='.items[] | {number, title, state, merged: (.pull_request.merged_at != null), created_at, merged_at: .pull_request.merged_at, url: .html_url, user: {login: .user.login}, body: (.body // "")}'

ROLLUP_TO_CHECKS='{check_runs: [.[] | select(.__typename == "CheckRun")
    | {name, started_at: (.startedAt // null), status: (.status | ascii_downcase), conclusion: (if (.conclusion // "") == "" then null else (.conclusion | ascii_downcase) end)}],
  statuses: [.[] | select(.__typename == "StatusContext") | {context, state: (.state | ascii_downcase)}]}'

rest_default_branch() { GH api "repos/$REPO" | jq -c '{default_branch}'; }
default_branch() {
  gh_first "default branch of $REPO" '{default_branch: .defaultBranchRef.name}' rest_default_branch repo view "$REPO" --json defaultBranchRef
}

rest_checks() {
  local runs statuses
  runs="$(GH api "repos/$REPO/commits/$sha/check-runs?per_page=100&filter=latest")" || return $?
  statuses="$(GH api "repos/$REPO/commits/$sha/status?per_page=100")" || return $?
  jq -cn --argjson runs "$runs" --argjson statuses "$statuses" \
    '{check_runs: [$runs.check_runs[] | {name, started_at, status, conclusion}], statuses: [$statuses.statuses[] | {context, state}]}'
}

graph_checks() {
  GH api graphql -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F sha="$sha" -f query='query($owner: String!, $name: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } } }' \
    | jq -c '[.data.repository.object.statusCheckRollup.contexts.nodes[]?] | '"$ROLLUP_TO_CHECKS"
}
checks_of_commit() { rest_first "read the checks of $sha in $REPO" rest_checks graph_checks; }

# The checks of a PR. Two PRs from two branches can have the same head commit, and GitHub lists
# checks by commit, so the rollup of one PR holds the runs of the other. A run counts for this PR
# only when its check suite is on the PR's head branch, or on no branch.
PR_CHECKS_QUERY='query($owner: String!, $name: String!, $sha: GitObjectID!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { headRefName } object(oid: $sha) { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion startedAt checkSuite { branch { name } } } ... on StatusContext { context state } } } } } } } }'
PR_CHECKS_FROM_GRAPH='.data.repository as $r | $r.pullRequest.headRefName as $b
  | [$r.object.statusCheckRollup.contexts.nodes[]? | select(.__typename != "CheckRun" or (.checkSuite.branch.name // $b) == $b)] | '"$ROLLUP_TO_CHECKS"
rest_pr_checks() {
  local pull branch runs suites statuses
  pull="$(GH api "repos/$REPO/pulls/$pr")" || return $?
  branch="$(jq -r '.head.ref' <<<"$pull")" || return $?
  runs="$(GH api "repos/$REPO/commits/$sha/check-runs?per_page=100&filter=latest")" || return $?
  suites="$(GH api "repos/$REPO/commits/$sha/check-suites?per_page=100")" || return $?
  statuses="$(GH api "repos/$REPO/commits/$sha/status?per_page=100")" || return $?
  jq -cn --arg b "$branch" --argjson runs "$runs" --argjson suites "$suites" --argjson statuses "$statuses" \
    '($suites.check_suites | map({key: (.id | tostring), value: .head_branch}) | from_entries) as $on
    | {check_runs: [$runs.check_runs[] | select(($on[.check_suite.id | tostring] // $b) == $b) | {name, started_at, status, conclusion}],
       statuses: [$statuses.statuses[] | {context, state}]}'
}

FEEDBACK_QUERY='query($owner: String!, $name: String!, $issue: Int!, $pr: Int!) { repository(owner: $owner, name: $name) {
  issue(number: $issue) { comments(first: 100) { nodes { databaseId body createdAt author { __typename login } } } }
  pullRequest(number: $pr) {
    comments(first: 100) { nodes { databaseId body createdAt author { __typename login } } }
    reviews(first: 100) { nodes { databaseId body state submittedAt author { __typename login }
      comments(first: 100) { nodes { databaseId body createdAt author { __typename login } } } } }
  } } }'
FEEDBACK_FROM_GRAPH='def who: {login: (if .author == null then "unknown" elif .author.__typename == "Bot" then "\(.author.login)[bot]" else .author.login end),
    type: (if .author.__typename == "Bot" then "Bot" else "User" end)};
  def note($surface): {id: .databaseId, surface: $surface, path: (.path // null), body, user: who, created_at: .createdAt};
  .data.repository as $r | ($r.issue.comments.nodes[] | note("issue")), ($r.pullRequest.comments.nodes[] | note("pr")),
  ($r.pullRequest.reviews.nodes[] | ({id: .databaseId, surface: "review", path: null, body, user: who, submitted_at: .submittedAt, state}), (.comments.nodes[] | note("inline")))'
FEEDBACK_FROM_REST='.[] | {id, surface: $surface, path: (.path // null), body, user: {login: .user.login, type: .user.type}} + (if .submitted_at then {submitted_at, state} else {created_at} end)'
rest_feedback() {
  local path
  local pair
  for pair in "issue:issues/$issue/comments" "pr:issues/$pr/comments" "review:pulls/$pr/reviews" "inline:pulls/$pr/comments"; do
    GH api "repos/$REPO/${pair#*:}?per_page=100" | jq -c --arg surface "${pair%%:*}" "$FEEDBACK_FROM_REST" || return 1
  done
}

graph_deps() {
  GH api graphql -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F n="$n" -f query="query(\$owner: String!, \$name: String!, \$n: Int!) { repository(owner: \$owner, name: \$name) { issue(number: \$n) { $field(first: 100) { nodes { number title state url } } } } }" \
    | jq -c --arg f "$field" '.data.repository.issue[$f].nodes[] | {number, title, state: (.state | ascii_downcase), url}'
}
rest_deps() { GH api "repos/$REPO/issues/$n/dependencies/$path?per_page=100" | jq -c '.[] | {number, title, state, url: .html_url}'; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  repo)
    need_repo
    jq -cn --arg repo "$REPO" '{repo: $repo}'
    ;;

  default-branch)
    need_repo
    default_branch
    ;;

  issue-read)
    need_repo
    n="${1:?issue number required}"
    rest_issue() { GH api "repos/$REPO/issues/$n" | jq -c '{number, title, state, body, url: .html_url}'; }
    gh_first "read issue #$n of $REPO" '{number, title, state: (.state | ascii_downcase), body, url}' rest_issue issue view "$n" --repo "$REPO" --json number,title,state,body,url
    ;;

  pr-read)
    need_repo
    n="${1:?PR number required}"
    rest_pr() { GH api "repos/$REPO/pulls/$n" | jq -c "$PR_FROM_REST"; }
    gh_first "read PR #$n of $REPO" "$PR_FROM_GH" rest_pr pr view "$n" --repo "$REPO" --json "$PR_FIELDS"
    ;;

  pr-list)
    need_repo
    head=""; state="open"; limit="100"
    while [ $# -gt 0 ]; do
      case "$1" in
        --head)  head="$2"; shift 2 ;;
        --state) state="$2"; shift 2 ;;
        --limit) limit="$2"; shift 2 ;;
        *) die "usage: gh.sh pr-list [--head <branch>] [--state open|closed|all] [--limit <n>]" ;;
      esac
    done
    args=(pr list --repo "$REPO" --state "$state" --limit "$limit" --json number,title,state,isDraft,createdAt,headRefOid,headRefName,url,author)
    [ -z "$head" ] || args+=(--head "$head")
    rest_list() {
      local query="state=$state&per_page=100"
      [ -z "$head" ] || query="$query&head=${REPO%%/*}:$head"
      GH api --paginate "repos/$REPO/pulls?$query" | jq -c "$LISTED_FROM_REST" | head -n "$limit"
    }
    gh_first "list the PRs of $REPO" "$LISTED_FROM_GH" rest_list "${args[@]}"
    ;;

  pr-rows)
    need_repo
    limit="100"
    while [ $# -gt 0 ]; do
      case "$1" in
        --limit) limit="$2"; shift 2 ;;
        *) die "usage: gh.sh pr-rows [--limit <n>]" ;;
      esac
    done
    err="$(mktemp)"; code=0
    out="$(GH pr list --repo "$REPO" --state open --author "@me" --limit "$limit" \
      --json number,title,headRefName,state,isDraft,mergeable,mergeStateStatus,mergeCommit,headRefOid,createdAt,statusCheckRollup 2>"$err")" || code=$?
    why="$(one_line "$err")"; rm -f "$err"
    [ "$code" -eq 0 ] || die "list the open PRs of $REPO with their checks: gh pr list exited $code: $why. REST has no one-call route: read each with gh.sh pr-read and gh.sh commit-checks."
    jq -c '.[]' <<<"$out"
    ;;

  commit-checks)
    need_repo
    sha="${1:?commit sha required}"; shift
    pr=""
    if [ "${1:-}" = "--pr" ]; then pr="${2:?PR number required}"; fi
    if [ -z "$pr" ]; then
      # gh has no command for the checks of a commit.
      checks_of_commit
    else
      # gh pr view gives no branch for a check, so one GraphQL call reads the commit and the PR branch.
      gh_first "read the checks of $sha for PR #$pr of $REPO" "$PR_CHECKS_FROM_GRAPH" rest_pr_checks api graphql -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F sha="$sha" -F pr="$pr" -f query="$PR_CHECKS_QUERY"
    fi
    ;;

  feedback)
    # One GraphQL query reads all four lists. `gh pr view` cannot do this: its comments have no
    # numeric id and do not mark a bot, and no gh command reads inline comments.
    need_repo
    issue="${1:?issue number required}"; pr="${2:?PR number required}"
    gh_first "read the feedback of PR #$pr of $REPO" "$FEEDBACK_FROM_GRAPH" rest_feedback api graphql -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F issue="$issue" -F pr="$pr" -f query="$FEEDBACK_QUERY"
    ;;

  comment)
    need_repo
    n="${1:?issue or PR number required}"; shift
    [ "${1:-}" = "--body" ] || die "usage: gh.sh comment <n> --body <t>"
    body="${2:-}"; [ -n "$body" ] || die "comment: the body is empty"
    rest_comment() { GH api -X POST "repos/$REPO/issues/$n/comments" -f "body=$body" --jq .html_url; }
    GH_FIRST_POST=1 gh_first "comment on #$n" "" rest_comment issue comment "$n" --repo "$REPO" --body "$body"
    ;;

  comment-edit)
    need_repo
    id="${1:?comment id required}"; shift
    [ "${1:-}" = "--body" ] || die "usage: gh.sh comment-edit <id> --body <t>"
    body="${2:-}"; [ -n "$body" ] || die "comment-edit: the body is empty"
    GH api -X PATCH "repos/$REPO/issues/comments/$id" -f "body=$body" --jq .html_url
    ;;

  pr-review)
    need_repo
    n="${1:?PR number required}"; shift
    commit=""; body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --commit) commit="$2"; shift 2 ;;
        --body)   body="$2"; shift 2 ;;
        *) die "usage: gh.sh pr-review <n> --commit <sha> --body <t>" ;;
      esac
    done
    [ -n "$commit" ] && [ -n "$body" ] || die "pr-review: --commit and --body are both required"
    rest_review() { GH api -X POST "repos/$REPO/pulls/$n/reviews" -f event=COMMENT -f "commit_id=$commit" -f "body=$body" --jq .html_url; }
    GH_FIRST_POST=1 gh_first "review of #$n" "" rest_review pr review "$n" --repo "$REPO" --comment --body "$body"
    ;;

  pr-ready)
    need_repo
    n="${1:?PR number required}"
    err="$(mktemp)"; code=0
    GH pr ready "$n" --repo "$REPO" 2>"$err" || code=$?
    why="$(one_line "$err")"; rm -f "$err"
    [ "$code" -eq 0 ] || die "mark PR #$n of $REPO ready: gh pr ready exited $code: $why. REST has no way to leave draft, so there is no second route. $REPAIR_QUOTA" 1
    ;;

  label)
    need_repo
    n="${1:?issue or PR number required}"; lab="${2:?label required}"
    rest_label() { GH api -X POST "repos/$REPO/issues/$n/labels" -f "labels[]=$lab" --jq 'length'; }
    gh_first "label #$n" "" rest_label pr edit "$n" --repo "$REPO" --add-label "$lab"
    ;;

  pr-merge)
    need_repo
    n="${1:?PR number required}"; shift
    [ "${1:-}" = "--method" ] || die "usage: gh.sh pr-merge <n> --method merge|squash|rebase [--stack]"
    method="${2:-}"
    case "$method" in merge|squash|rebase) ;; *) die "pr-merge: --method is merge, squash or rebase, not '$method'" ;; esac
    whole_stack="${3:-}"
    case "$whole_stack" in ''|--stack) ;; *) die "usage: gh.sh pr-merge <n> --method merge|squash|rebase [--stack]" ;; esac
    rest_merge() { GH api -X PUT "repos/$REPO/pulls/$n/merge" -f "merge_method=$method" --jq .sha; }
    # A stacked PR: gh pr merge and PUT .../merge both refuse it, so the gh-first rule cannot hold.
    # Only the asynchronous endpoint merges it, and that also merges each open PR below it.
    is_stack_refusal() { grep -qiE 'part of a stack|stacked PRs|asynchronous merge' "$1"; }
    merge_stacked() {
      local pr_json pos size sha started id status result tries perr last snum serr stack_json below unread
      pr_json="$(GH api "repos/$REPO/pulls/$n")" || die "merge PR #$n of $REPO: GitHub says it is in a stack, and its REST record could not be read (exit $?). Repair: gh api repos/$REPO/pulls/$n --jq .stack" 1
      pos="$(jq -r '.stack.position // empty' <<<"$pr_json")"; size="$(jq -r '.stack.size // "?"' <<<"$pr_json")"
      sha="$(jq -r '.head.sha // empty' <<<"$pr_json")"
      [ -n "$pos" ] && [ -n "$sha" ] || die "merge PR #$n of $REPO: GitHub says it is in a stack, but its REST record has no stack.position or head.sha (stack: $(jq -c '.stack' <<<"$pr_json")). Repair: merge it in the GitHub web page" 1
      if [ "$pos" != 1 ] && [ -z "$whole_stack" ]; then
        # Only an open PR below it is merged with it, so read the stack: GitHub keeps the position of a merged PR.
        snum="$(jq -r '.stack.number // empty' <<<"$pr_json")"; serr="$(mktemp)"; below="" unread=""
        if [ -z "$snum" ]; then unread="its REST record has no stack.number"
        elif ! stack_json="$(GH api "repos/$REPO/stacks/$snum" 2>"$serr")"; then unread="gh api repos/$REPO/stacks/$snum exited $? ($(said "$serr" "$stack_json"))"
        elif ! below="$(jq -r --argjson n "$n" '(.pull_requests // []) as $p | ($p | map(.number) | index($n)) as $i
          | if $i == null then error("the stack does not list PR #\($n)") else [$p[:$i][] | select(.state == "open") | "#\(.number)"] | join(", ") end' <<<"$stack_json" 2>"$serr")"; then unread="stack $snum: $(one_line "$serr")"
        fi
        rm -f "$serr"
        [ -z "$unread" ] || die "merge PR #$n of $REPO: it is $pos of $size in a stack, and a merge of it also merges each open PR below it. The PRs below it could not be read: $unread. Repair: gh api repos/$REPO/stacks/${snum:-<stack number>} to see them, then merge the bottom PR of the stack first, or pass --stack (merge.sh <pr> --stack) to merge them all." 1
        [ -z "$below" ] || die "merge PR #$n of $REPO: it is $pos of $size in a stack, and a merge of it also merges the $(awk -F', ' '{print NF}' <<<"$below") open PR(s) below it ($below). Repair: merge the bottom PR of the stack first, or pass --stack (merge.sh <pr> --stack) to merge them all." 1
        echo "gh.sh: merge PR #$n of $REPO: no PR below it in stack $snum is open, so this merges it alone." >&2
      fi
      echo "gh.sh: merge PR #$n of $REPO: it is $pos of $size in a stack. Merging through merge-async at $sha." >&2
      started="$(GH api -X PUT "repos/$REPO/pulls/$n/merge-async" -f "sha=$sha" -f "merge_method=$method" -f merge_action=direct_merge)" \
        || die "merge PR #$n of $REPO: merge-async refused it (exit $?), see above. Repair: read the stack with gh api repos/$REPO/pulls/$n --jq .stack" 1
      # The answer is {"status":"pending","details":{"uuid":...}}: the request is accepted, not merged.
      id="$(jq -r 'if type == "string" then . else (.details.uuid? // .uuid // .id // .request_id // empty) end' <<<"$started" 2>/dev/null || true)"
      [ -n "$id" ] || die "merge PR #$n of $REPO: merge-async answered with no request id (looked for details.uuid, uuid, id and request_id): ${started:0:300}. GitHub can still merge it. Repair: read it with gh pr view $n --repo $REPO --json state,mergeCommit, and run the merge again only when it is still open." 1
      result="$started"; tries="${GH_MERGE_ASYNC_TRIES:-120}"; perr="$(mktemp)"; last=""
      while :; do
        status="$(jq -r '.status? // "pending"' <<<"$result" 2>/dev/null || echo pending)"
        case "$status" in
          merged) rm -f "$perr"; echo "gh.sh: merge PR #$n of $REPO: merge-async request $id merged." >&2; return 0 ;;
          enqueued) die "merge PR #$n of $REPO: merge-async request $id put it in the merge queue; it is not merged yet. Repair: run the merge again after the queue merges it (it then counts as merged)." 1 ;;
          failed) die "merge PR #$n of $REPO: merge-async request $id failed: $(jq -c 'del(.status)' <<<"$result" | cut -c1-400). Repair: fix what GitHub names, then merge again." 1 ;;
        esac
        tries=$((tries - 1))
        [ "$tries" -gt 0 ] || die "merge PR #$n of $REPO: merge-async request $id is still $status${last:+ (the last read of the request: $last)}, and the PR does not read merged. GitHub can still merge it. Repair: gh api repos/$REPO/pulls/$n/merge-async/$id, or gh pr view $n --repo $REPO --json state,mergeCommit" 1
        sleep "${GH_MERGE_ASYNC_PERIOD:-5}"
        if result="$(GH api "repos/$REPO/pulls/$n/merge-async/$id" 2>"$perr")"; then last=""; continue; fi
        # The request could not be read, but the PR itself shows whether GitHub merged it.
        last="exit $? ($(said "$perr" "$result"))"; result='{"status":"pending"}'
        pr_json="$(GH api "repos/$REPO/pulls/$n" 2>"$perr")" || die "merge PR #$n of $REPO: neither merge-async request $id ($last) nor the PR could be read (exit $?: $(said "$perr" "$pr_json")). GitHub can still merge it. Repair: gh pr view $n --repo $REPO --json state,mergeCommit" 1
        case "$(jq -r '"\(.merged) \(.state)"' <<<"$pr_json")" in
          true*) rm -f "$perr"; echo "gh.sh: merge PR #$n of $REPO: merge-async request $id could not be read ($last), but PR #$n of $REPO reads merged." >&2; return 0 ;;
          *closed) die "merge PR #$n of $REPO: after merge-async request $id, the PR is closed and not merged. Repair: gh pr view $n --repo $REPO" 1 ;;
        esac
      done
    }
    merr="$(mktemp)"; mcode=0
    mout="$(GH pr merge "$n" --repo "$REPO" "--$method" 2>"$merr")" || mcode=$?
    if [ "$mcode" -eq 0 ]; then rm -f "$merr"; [ -z "$mout" ] || printf '%s\n' "$mout"; exit 0; fi
    if is_stack_refusal "$merr"; then rm -f "$merr"; merge_stacked; exit 0; fi
    mwhy="$(said "$merr" "$mout")"
    echo "gh.sh: merge PR #$n of $REPO: gh pr merge exited $mcode ($mwhy). Trying REST." >&2
    rcode=0
    mout="$(rest_merge 2>"$merr")" || rcode=$?
    if [ "$rcode" -eq 0 ]; then rm -f "$merr"; echo "gh.sh: merge PR #$n of $REPO: REST answered." >&2; [ -z "$mout" ] || printf '%s\n' "$mout"; exit 0; fi
    if is_stack_refusal "$merr"; then rm -f "$merr"; merge_stacked; exit 0; fi
    rwhy="$(said "$merr" "$mout")"; rm -f "$merr"
    die "merge PR #$n of $REPO failed both ways. gh pr merge exited $mcode: $mwhy. REST exited $rcode: $rwhy. $REPAIR_QUOTA" 1
    ;;

  me)
    rest_me() { GH api user | jq -c '{login}'; }
    gh_first "read the signed-in user" '{login: .data.viewer.login}' rest_me api graphql -f query='{viewer{login}}'
    ;;

  repo-read)
    need_repo
    rest_repo() { GH api "repos/$REPO" | jq -c '{full_name, default_branch, allow_merge_commit, allow_squash_merge, allow_rebase_merge}'; }
    gh_first "read $REPO" '{full_name: .nameWithOwner, default_branch: .defaultBranchRef.name, allow_merge_commit: .mergeCommitAllowed, allow_squash_merge: .squashMergeAllowed, allow_rebase_merge: .rebaseMergeAllowed}' \
      rest_repo repo view "$REPO" --json nameWithOwner,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed
    ;;

  pr-commit-messages)
    need_repo
    n="${1:?PR number required}"
    rest_messages() { GH api "repos/$REPO/pulls/$n/commits?per_page=100" --jq '.[].commit.message'; }
    gh_first "read the commits of PR #$n of $REPO" "" rest_messages pr view "$n" --repo "$REPO" --json commits --jq '.commits[] | .messageHeadline + "\n\n" + .messageBody'
    ;;

  rerun-failed)
    need_repo
    n="${1:?run id required}"
    rest_rerun() { GH api -X POST "repos/$REPO/actions/runs/$n/rerun-failed-jobs"; }
    gh_first "rerun the failed jobs of run $n of $REPO" "" rest_rerun run rerun "$n" --repo "$REPO" --failed
    ;;

  issue-search)
    need_repo
    q="${1:?search query required}"; shift
    limit=100
    if [ "${1:-}" = "--limit" ]; then limit="${2:?--limit needs a number}"; fi
    rest_search() { GH api -X GET search/issues -f "q=repo:$REPO is:issue is:open $q" -f "per_page=$limit" | jq -c '.items[] | {number, title, url: .html_url}'; }
    gh_first "search the issues of $REPO" '.[] | {number, title, url}' rest_search issue list --repo "$REPO" --state open --search "$q" --limit "$limit" --json number,title,url
    ;;

  view-json)
    # gh's own shape, for a caller that needs fields REST does not give (reviewDecision, the check rollup, closing issues). No REST route.
    need_repo
    kind="${1:?pr or issue required}"; shift
    case "$kind" in pr|issue) ;; *) die "usage: gh.sh view-json pr|issue <number|branch|url> --fields <f> | view-json pr --open [--limit <n>] --fields <f>" ;; esac
    sel=""; fields=""; open=0; limit=100
    while [ $# -gt 0 ]; do
      case "$1" in
        --fields) fields="${2:?--fields needs a list}"; shift 2 ;;
        --open)   open=1; shift ;;
        --limit)  limit="${2:?--limit needs a number}"; shift 2 ;;
        *) sel="$1"; shift ;;
      esac
    done
    [ -n "$fields" ] || die "view-json: --fields is required"
    err="$(mktemp)"; code=0
    if [ "$open" = 1 ]; then
      [ "$kind" = pr ] || die "view-json: --open is for pr only"
      out="$(GH pr list --repo "$REPO" --state open --limit "$limit" --json "$fields" 2>"$err")" || code=$?
    else
      [ -n "$sel" ] || die "view-json: give a number, a branch or a URL"
      out="$(GH "$kind" view "$sel" --repo "$REPO" --json "$fields" 2>"$err")" || code=$?
    fi
    why="$(said "$err" "$out")"; rm -f "$err"
    [ "$code" -eq 0 ] || die "read $kind ${sel:-list} of $REPO as gh json ($fields): gh exited $code: $why. REST has no route for these fields: use pr-read, issue-read or commit-checks for the REST shape. $REPAIR_QUOTA" 1
    if [ "$open" = 1 ]; then jq -c '.[]' <<<"$out"; else jq -c . <<<"$out"; fi
    ;;

  run-status)
    need_repo
    n="${1:?run id required}"
    rest_run() { GH api "repos/$REPO/actions/runs/$n" | jq -c '{status}'; }
    gh_first "read run $n of $REPO" '{status}' rest_run run view "$n" --repo "$REPO" --json status
    ;;

  pr-diff)
    need_repo
    n="${1:?PR number required}"
    rest_diff() { GH api -H "Accept: application/vnd.github.diff" "repos/$REPO/pulls/$n"; }
    gh_first "read the diff of PR #$n of $REPO" "" rest_diff pr diff "$n" --repo "$REPO"
    ;;

  pr-commit-dates)
    need_repo
    n="${1:?PR number required}"
    rest_dates() { GH api --paginate "repos/$REPO/pulls/$n/commits?per_page=100" --jq '.[].commit.committer.date'; }
    gh_first "read the commit dates of PR #$n of $REPO" "" rest_dates pr view "$n" --repo "$REPO" --json commits --jq '.commits[].committedDate'
    ;;

  pr-search)
    need_repo
    q="${1:?search query required}"; shift
    limit=100
    if [ "${1:-}" = "--limit" ]; then limit="${2:?--limit needs a number}"; fi
    rest_found() { GH api -X GET search/issues --paginate -f "q=repo:$REPO is:pr $q" -f per_page=100 | jq -c "$FOUND_FROM_REST" | head -n "$limit"; }
    gh_first "search the PRs of $REPO" "$FOUND_FROM_GH" rest_found pr list --repo "$REPO" --state all --search "$q" --limit "$limit" --json number,title,state,createdAt,mergedAt,url,author,body
    ;;

  pr-reopen)
    need_repo
    n="${1:?PR number required}"
    rest_reopen() { GH api -X PATCH "repos/$REPO/pulls/$n" -f state=open --jq .html_url; }
    gh_first "reopen PR #$n of $REPO" "" rest_reopen pr reopen "$n" --repo "$REPO"
    ;;

  project-list)
    owner="${1:?owner required}"
    GH project list --owner "$owner" --format json --limit 30
    ;;

  api)
    GH api "$@"
    ;;

  milestones)
    need_repo
    GH api "repos/$REPO/milestones?state=all&per_page=100" \
      --jq '.[] | {title, state, open_issues, closed_issues, due_on, number}'
    ;;

  issues-by-milestone)
    need_repo
    want="${1:?milestone title required}"
    # REST: issues need the milestone number, and the list also holds pull requests.
    mnum="$(GH api --paginate "repos/$REPO/milestones?state=all&per_page=100" --jq ".[] | select(.title == \"$want\") | .number" | head -1)"
    [ -n "$mnum" ] || die "issues-by-milestone: no milestone titled '$want' in $REPO"
    GH api --paginate "repos/$REPO/issues?milestone=$mnum&state=all&per_page=100" \
      --jq '.[] | select(.pull_request == null) | {number, title, state: (.state | ascii_upcase), milestone: .milestone.title, labels: [.labels[].name], url: .html_url}'
    ;;

  issue-new)
    need_repo
    title=""; bodyfile=""; extra=(); ghextra=(); milestone=""; type=""
    usage="usage: gh.sh issue-new --title <t> --body-file <f> [--label <l>]... [--assignee <login>]... [--milestone <n>] [--type <t>]"
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)     title="$2"; shift 2 ;;
        --body-file) bodyfile="$2"; shift 2 ;;
        --label)     extra+=(-f "labels[]=$2"); ghextra+=(--label "$2"); shift 2 ;;
        --assignee)  extra+=(-f "assignees[]=$2"); ghextra+=(--assignee "$2"); shift 2 ;;
        --milestone) [[ "$2" =~ ^[0-9]+$ ]] || die "issue-new: --milestone takes the milestone number (gh.sh milestones), not '$2'"
                     extra+=(-F "milestone=$2"); milestone="$2"; shift 2 ;;
        --type)      extra+=(-f "type=$2"); type="$2"; shift 2 ;;
        *) die "$usage" ;;
      esac
    done
    [ -n "$title" ] && [ -n "$bodyfile" ] || die "issue-new: --title and --body-file are both required"
    check_body "$bodyfile"
    rest_issue_new() { GH api -X POST "repos/$REPO/issues" -f "title=$title" -F "body=@$bodyfile" ${extra[@]+"${extra[@]}"} --jq .html_url; }
    if [ -n "$milestone$type" ]; then
      # gh takes a milestone by title and has no flag for a type, so these go to REST.
      url="$(rest_issue_new)" || die "create the issue '$title' in $REPO: REST failed. $REPAIR_QUOTA" 1
    else
      url="$(GH_FIRST_POST=1 gh_first "create the issue '$title' in $REPO" "" rest_issue_new issue create --repo "$REPO" --title "$title" --body-file "$bodyfile" ${ghextra[@]+"${ghextra[@]}"} | tail -n 1)"
    fi
    jq -cn --arg url "$url" '{number: ($url | split("/") | last | tonumber), url: $url}'
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
    [ -n "$base" ] || base="$(default_branch | jq -r .default_branch)"
    check_body "$bodyfile"
    rest_pr_new() { GH api -X POST "repos/$REPO/pulls" -f "title=$title" -F "body=@$bodyfile" -f "head=$head" -f "base=$base" -F "draft=$draft" --jq '.html_url'; }
    ghdraft=(--draft); [ "$draft" = true ] || ghdraft=()
    url="$(GH_FIRST_POST=1 gh_first "create the PR '$head' -> '$base' in $REPO" "" rest_pr_new pr create --repo "$REPO" --head "$head" --base "$base" --title "$title" --body-file "$bodyfile" ${ghdraft[@]+"${ghdraft[@]}"} | tail -n 1)"
    jq -cn --arg url "$url" '{url: $url}'
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
        n="$parent"; path=""; field=subIssues
        rest_subs() { GH api "repos/$REPO/issues/$n/sub_issues?per_page=100" | jq -c '.[] | {number, title, state, url: .html_url}'; }
        rest_first "read the sub-issues of #$n of $REPO" rest_subs graph_deps
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
        path=blocked_by; field=blockedBy
        if [ "$sub" = blocking ]; then path=blocking; field=blocking; fi
        rest_first "read the dependencies of #$n of $REPO" rest_deps graph_deps
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
      set)   board_set "${1:?item id required}" "${2:?field name required}" "${3:?value required}" ;;
      fields) board_fields ;;
      add)
        need_repo
        n="${1:?issue number required}"; column="${2:-}"
        item="$(GH project item-add "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" \
                  --url "https://github.com/$REPO/issues/$n" --format json --jq .id)"
        echo "{\"number\": $n, \"itemId\": \"$item\"}"
        [ -z "$column" ] || board_set "$item" Status "$column"
        ;;
      *) die "usage: gh.sh board items [<column>] | fields | move <itemId> <column> | set <itemId> <field> <value> | add <issue> [<column>]" ;;
    esac
    ;;

  wait-for-pr|wait-for-pr-change)
    exec "$DIR/wait-for-pr-change.sh" "$@"
    ;;

  help|--help|-h)
    sed -n '2,61p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;

  *)
    die "unknown command '$cmd'. Run: gh.sh help" 1
    ;;
esac
