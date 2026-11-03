#!/usr/bin/env bash
# Deterministic PR-feedback scanner for the work-heavy-auto pipeline — a SCRIPT
# decides what counts as new human feedback; agents only relay its output.
# (A model that judges this misses comments; a script does not.)
#
# Scans the board's review and progress cards, finds each card's
# claude/issue-<n> PR, and reports every UNHANDLED human feedback comment
# across ALL FOUR surfaces:
#   issue   — comments on the issue itself    repos/…/issues/<n>/comments
#   pr      — PR conversation comments        repos/…/issues/<pr>/comments
#   review  — review bodies                   repos/…/pulls/<pr>/reviews
#   inline  — inline review comments          repos/…/pulls/<pr>/comments
#
# A comment is FEEDBACK unless it is from a bot or from the pipeline itself
# (body contains "<!-- work-heavy-auto" or starts with "**work-heavy-auto" — every
# comment the pipeline/orchestrator posts must match one of those — or it is a
# "**Smoke tested" review, which the pipeline posts and must not read back as a
# human asking for changes).
# A feedback comment is HANDLED when any of:
#   - it predates the PR (plan-phase conversation, consumed by the plan pass);
#   - it predates the branch's last commit (a later push addressed it);
#   - its id is ACKED: some pipeline comment contains "ack:<id1>,<id2>,…"
#     (the revision agents reply with "<!-- work-heavy-auto:revision ack:… -->").
# Everything else is NEW feedback. APPROVED reviews with no body are not
# feedback (the human merges when ready).
#
# Output — ONE JSON object on stdout:
#   {"items":[{number,title,itemId,cardStatus,
#              pr:{number,url,state,isDraft,branch,createdAt,lastCommit},  # state NONE when no PR
#              state,   # latest "<!-- work-heavy-auto:state -->" comment on the OPEN PR, or null:
#                       # {createdAt,attempts,next:"waiting-human"|"resume",nextDetail}
#              smoke:{reviewedAt,stale},  # stale => the branch moved since the last
#                       # browser check, so the PR is NOT verified at its current head
#              checks:{state,failing},    # FAILING|PENDING|PASSING|NONE + failing check names
#              newFeedback:[{id,surface,author,createdAt,path,body}]}]}
#
# WHY `checks` EXISTS. A PR that goes red AFTER its agent parked with
# "- next: waiting-human" must not read as green and waiting for review. A red PR
# re-enters as `resume` whatever its state comment says: read the state, do not
# trust a written claim.
#
# CANCELLED is deliberately NOT a failure: CI with cancel-in-progress leaves
# cancelled runs behind every superseded push. Counting those would resume every
# active PR on every pass.
#
# Usage: pr_feedback.sh [--issue N] [--exclude N,N,…]
#   --exclude skips those issues entirely (e.g. one being handled outside this
#   pipeline) — they are never scanned, so no revision/close action can fire.
# Repository: $GH_REPO (OWNER/REPO), else `gh repo view` in the current checkout.
# Token: GH_USE_KEYRING=1 drops GITHUB_TOKEN so the gh keyring login is used.
# Board: GH_PROJECT_OWNER / GH_PROJECT_NUMBER, read through board.sh. Columns
# scanned: WORK_READY_COL_PROGRESS (default "In progress") and
# WORK_READY_COL_REVIEW (default "In review").
set -euo pipefail

SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BOARD_SH="$SD/../board/board.sh"
[ -x "$BOARD_SH" ] || { echo "pr_feedback.sh: board.sh is missing or not executable at $BOARD_SH. Repair: reinstall the plugin (claude plugin update ndev) so scripts/board/ sits beside scripts/work/" >&2; exit 2; }
GHSH="$SD/../github/gh.sh"
[ -x "$GHSH" ] || { echo "pr_feedback.sh: gh.sh is missing or not executable at $GHSH. Repair: reinstall the plugin (claude plugin update ndev) so scripts/github/ sits beside scripts/work/" >&2; exit 2; }
for tool in gh jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "pr_feedback.sh: $tool is not on PATH. Repair: install $tool" >&2; exit 2; }
done
REPO="${GH_REPO:-}"
if [ -z "$REPO" ]; then
  repo_json="$("$GHSH" repo)" || {
    echo "pr_feedback.sh: cannot find the GitHub repository for $(pwd) (see the message above)" >&2
    echo "  Repair: run inside the checkout, set GH_REPO=OWNER/REPO, or run 'gh auth login'" >&2
    exit 2; }
  REPO="$(jq -r .repo <<<"$repo_json")"
fi
export GH_REPO="$REPO"
COL_PROGRESS="${WORK_READY_COL_PROGRESS:-In progress}"
COL_REVIEW="${WORK_READY_COL_REVIEW:-In review}"

ONLY=""
EXCLUDE=""   # comma-separated issue numbers to skip entirely
while [ $# -gt 0 ]; do
  case "$1" in
    --issue) ONLY="$2"; shift 2 ;;
    --exclude) EXCLUDE="$2"; shift 2 ;;
    *) echo "usage: pr_feedback.sh [--issue N] [--exclude N,N,…]" >&2; exit 2 ;;
  esac
done

# Read the board first: a failed read inside a process substitution would lose its
# exit status and report an empty, clean board.
board_out="$("$BOARD_SH" items)" || {
  echo "pr_feedback.sh: board.sh items failed (exit $?); see its message above" >&2; exit 2; }
cards="$(jq -c --arg p "$COL_PROGRESS" --arg r "$COL_REVIEW" 'select(.status == $r or .status == $p)' <<<"$board_out")" || {
  echo "pr_feedback.sh: board.sh items printed output that is not JSON lines" >&2; exit 2; }

items=()
while IFS= read -r card; do
  [ -n "$card" ] || continue
  n=$(jq -r .number <<<"$card")
  [ -n "$ONLY" ] && [ "$n" != "$ONLY" ] && continue
  case ",$EXCLUDE," in *",$n,"*) continue ;; esac

  # A PR as {number,url,state,isDraft,createdAt,headRefName}, state OPEN, MERGED or CLOSED.
  as_pr='{number, url, state: (if .merged then "MERGED" elif .state == "open" then "OPEN" else "CLOSED" end), isDraft: .draft, createdAt: .created_at, headRefName: .head.ref}'
  found=$("$GHSH" pr-list --head "claude/issue-$n" --state all --limit 1) || {
    echo "pr_feedback.sh: cannot read the PR of issue #$n in $REPO (see the message above)" >&2; exit 2; }
  pr=$(jq -sc "(.[0] | if . == null then null else $as_pr end)" <<<"$found")
  if [ "$pr" = "null" ]; then
    # Batched work (work-heavy skill, references/prs.md): the issue may be covered by another
    # issue's batch PR — branch claude/issue-<lead>, body "Closes #<n>". The search is
    # fuzzy, so verify with a strict body regex; prefer an OPEN PR, else the newest.
    cands=$("$GHSH" pr-search "\"Closes #$n\" in:body" --limit 10) || {
      echo "pr_feedback.sh: cannot search the PRs that close issue #$n in $REPO (see the message above)" >&2; exit 2; }
    pr=$(while IFS= read -r cand; do
            [ -n "$cand" ] || continue
            cnum=$(jq -r .number <<<"$cand")
            "$GHSH" pr-read "$cnum" \
              | jq -c "$as_pr" \
              | jq -c --argjson c "$cand" '. + {body: $c.body}' || exit 1
          done <<<"$cands" | jq -sc --arg n "$n" '[.[]
              | select(.headRefName | startswith("claude/"))
              | select(.body | test("(?i)closes #\($n)([^0-9]|$)"))]
            | sort_by(.createdAt) | reverse
            | (map(select(.state == "OPEN")) + .)
            | (.[0] // null) | if . == null then null else del(.body) end') || {
      echo "pr_feedback.sh: cannot read a PR that may close issue #$n in $REPO (see the message above)" >&2; exit 2; }
  fi
  if [ "$pr" = "null" ]; then
    items+=("$(jq -c '{number, title, itemId, cardStatus: .status,
      pr: {number: 0, url: "", state: "NONE", isDraft: false, branch: "", createdAt: "", lastCommit: ""},
      state: null, checks: {state: "NONE", failing: []}, newFeedback: []}' <<<"$card")")
    continue
  fi

  prnum=$(jq -r .number <<<"$pr")
  prstate=$(jq -r .state <<<"$pr")
  dates=$("$GHSH" pr-commit-dates "$prnum") || {
    echo "pr_feedback.sh: cannot read the commits of PR #$prnum in $REPO (see the message above)" >&2; exit 2; }
  last=$(sort <<<"$dates" | tail -1)
  headsha=$("$GHSH" pr-read "$prnum" | jq -r .head.sha) || {
    echo "pr_feedback.sh: cannot read PR #$prnum in $REPO (see the message above)" >&2; exit 2; }

  # Check status at the PR's current head: CheckRun entries ONLY (CI workflow
  # jobs). Commit StatusContext entries from third-party integrations are left out:
  # a standing account or permission failure there would resume nearly every PR on
  # every pass, and a guard that fires on healthy input teaches agents to ignore it.
  checks=$("$GHSH" commit-checks "$headsha" --pr "$prnum" | jq -c '
    [.check_runs[]?
      | if (.conclusion // "") != ""
        then {name: (.name // "?"), verdict: .conclusion}
        else {name: (.name // "?"), verdict: (.status // "PENDING")} end]
    | (map(select(.verdict | ascii_upcase
        | . == "FAILURE" or . == "TIMED_OUT" or . == "ACTION_REQUIRED"
          or . == "STARTUP_FAILURE" or . == "ERROR")) | map(.name)) as $bad
    | (map(select(.verdict | ascii_upcase
        | . == "PENDING" or . == "QUEUED" or . == "IN_PROGRESS" or . == "WAITING")) | length) as $wait
    | {state: (if ($bad | length) > 0 then "FAILING"
               elif $wait > 0 then "PENDING"
               elif (. | length) > 0 then "PASSING"
               else "NONE" end),
       failing: $bad}' 2>&1) || {
      echo "pr_feedback.sh: cannot read the check status of PR #$prnum in $REPO: $checks" >&2
      echo "  Repair: run 'gh api rate_limit' to see each quota, check 'gh auth status', or set GH_USE_KEYRING=1" >&2
      exit 2; }
  prj=$(jq -c --arg lc "$last" \
        '{number, url, state, isDraft, branch: .headRefName, createdAt, lastCommit: $lc}' <<<"$pr")

  if [ "$prstate" != "OPEN" ]; then # merged/closed: the loop is over, no comment scan
    items+=("$(jq -c --argjson pr "$prj" \
      '{number, title, itemId, cardStatus: .status, pr: $pr, state: null,
        checks: {state: "NONE", failing: []}, newFeedback: []}' <<<"$card")")
    continue
  fi

  # All four surfaces, normalized to {id,surface,author,bot,createdAt,path,body}.
  feedback=$("$GHSH" feedback "$n" "$prnum") || {
    echo "pr_feedback.sh: cannot read the comments and reviews of PR #$prnum in $REPO (see the message above)" >&2; exit 2; }
  all=$(jq -sc '[.[] | select(.state != "PENDING")
                     | select((.state == "APPROVED" and (.body // "") == "") | not)
                     | {id, surface, author: .user.login, bot: (.user.type == "Bot"),
                        createdAt: (.created_at // .submitted_at), path, body: (.body // "")}]' <<<"$feedback")

  items+=("$(jq -cn --argjson card "$card" --argjson pr "$prj" --argjson all "$all" \
              --argjson checks "$checks" '
    # A smoke review (posted by work F4) is the pipeline talking to a human. It is
    # posted AFTER the last commit by definition, so without this the pipeline would
    # read its own browser check back as feedback to action. Two forms are matched:
    # "<!-- work-heavy-auto:smoke -->" and the plain "**Smoke tested" heading.
    def is_smoke: .surface == "review"
      and (.body | (startswith("<!-- work-heavy-auto:smoke") or startswith("**Smoke tested")));
    def is_pipeline: is_smoke or (.body | (contains("<!-- work-heavy-auto") or startswith("**work-heavy-auto")));
    ($all | map(select(is_pipeline) | .body | [scan("ack:([0-9][0-9,]*)")] | flatten)
          | flatten | map(split(",")) | flatten | map(select(length > 0))) as $acks
    # Continuation state: the LATEST "<!-- work-heavy-auto:state -->" comment a per-issue agent
    # left on the PR conversation when it dropped out. attempts/next are the only lines the
    # pipeline parses; the rest of the body is prose for the next agent. A malformed or
    # missing next line reads as waiting-human (never spawn a resume agent on garbage).
    | ($all | map(select(.surface == "pr" and (.body | startswith("<!-- work-heavy-auto:state"))))
            | sort_by(.createdAt) | last) as $sc
    # The newest smoke review, and whether the branch has moved since it was posted.
    # A smoke review is pinned to the commit it opened in a browser; a later push makes it
    # a claim about superseded code. `stale: true` means the PR needs re-checking in a
    # browser before it can be called verified — see the work-heavy skill, F4 step 5.
    | ($all | map(select(is_smoke)) | sort_by(.createdAt) | last) as $sm
    | {number: $card.number, title: $card.title, itemId: $card.itemId, cardStatus: $card.status,
       pr: $pr,
       smoke: {reviewedAt: ($sm.createdAt // null),
               stale: (($sm == null) or ($pr.lastCommit > $sm.createdAt))},
       checks: $checks,
       state: (if $sc == null then null else
         {createdAt: $sc.createdAt,
          attempts: ((($sc.body | capture("- attempts: (?<a>[0-9]+)").a) // "0") | tonumber),
          next: (if ($sc.body | test("- next: resume")) then "resume" else "waiting-human" end),
          nextDetail: (($sc.body | capture("- next: (?<d>[^\n]*)").d) // "")} end),
       newFeedback: ($all | map(
         select(.bot | not) | select(is_pipeline | not)
         | select(.createdAt > $pr.createdAt)
         | select(.createdAt > $pr.lastCommit)
         | select((.id | tostring) as $i | ($acks | index($i)) | not)
         | {id, surface, author, createdAt, path, body}) | sort_by(.createdAt))}
  ')")
done <<<"$cards"

if [ ${#items[@]} -eq 0 ]; then
  echo '{"items": []}'
else
  printf '%s\n' "${items[@]}" | jq -s '{items: .}'
fi
