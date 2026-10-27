#!/usr/bin/env bash
# Board reads and moves for the Ready-board skills (work-light-auto, work-heavy-auto,
# work-heavy, goal-work). The GitHub logic lives once in scripts/github/gh.sh;
# this shim maps short keywords to column names.
#
#   board.sh ready                  # cards in the Ready column, one JSON object per line
#   board.sh awaiting               # cards in the Awaiting Feedback column
#   board.sh items                  # every card: {number,title,status,itemId,url}
#   board.sh move <itemId> <status> # status: backlog|ready|progress|review|awaiting|done
#                                   #         or an exact column name
#
# Needs GH_PROJECT_OWNER and GH_PROJECT_NUMBER (the Projects v2 board), from the environment or
# from "github.board" in the project's .neil-dev.json (saved by /dev-setup). Set
# GH_USE_KEYRING=1 when the ambient GITHUB_TOKEN lacks the `project` scope.
# Column names default to the GitHub board template. A board with other names sets
# WORK_READY_COL_BACKLOG, _READY, _PROGRESS, _REVIEW, _AWAITING, _DONE.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GHSH="$DIR/../github/gh.sh"
CONFIG_SH="$DIR/../github/project-config.sh"
die() { echo "board.sh: $1" >&2; [ -n "${2:-}" ] && echo "  Repair: $2" >&2; exit 2; }

[ -f "$CONFIG_SH" ] || die "project-config.sh is missing at $CONFIG_SH" \
  "reinstall the plugin (claude plugin update neil-development) so scripts/github/ sits beside scripts/board/"
# shellcheck source=../github/project-config.sh
. "$CONFIG_SH"
[ -x "$GHSH" ] || die "gh.sh is missing or not executable at $GHSH" \
  "reinstall the plugin (claude plugin update neil-development) so scripts/github/ sits beside scripts/board/"
{ [ -n "${GH_PROJECT_OWNER:-}" ] && [ -n "${GH_PROJECT_NUMBER:-}" ]; } \
  || die "no project board is set (GH_PROJECT_OWNER='${GH_PROJECT_OWNER:-}' GH_PROJECT_NUMBER='${GH_PROJECT_NUMBER:-}')" \
         "run /dev-setup in Claude Code to save the board in .neil-dev.json, or export GH_PROJECT_OWNER=<org-or-user> GH_PROJECT_NUMBER=<n> (find them with 'gh project list --owner <org>')"

column() {
  case "$1" in
    backlog)  echo "${WORK_READY_COL_BACKLOG:-Backlog}" ;;
    ready)    echo "${WORK_READY_COL_READY:-Ready}" ;;
    progress) echo "${WORK_READY_COL_PROGRESS:-In progress}" ;;
    review)   echo "${WORK_READY_COL_REVIEW:-In review}" ;;
    awaiting) echo "${WORK_READY_COL_AWAITING:-Awaiting Feedback}" ;;
    done)     echo "${WORK_READY_COL_DONE:-Done}" ;;
    *)        echo "$1" ;;
  esac
}

cmd="${1:-}"; shift || true
case "$cmd" in
  ready)    exec "$GHSH" board items "$(column ready)" ;;
  awaiting) exec "$GHSH" board items "$(column awaiting)" ;;
  items)    exec "$GHSH" board items ;;
  move)
    item="${1:-}"; status="${2:-}"
    [ -n "$item" ] && [ -n "$status" ] || die "move needs <itemId> <status>, got '${item}' '${status}'" \
      "take the itemId (PVTI_...) from 'board.sh items', not the issue number"
    exec "$GHSH" board move "$item" "$(column "$status")" ;;
  *) die "unknown command '${cmd}'" "use: board.sh ready | awaiting | items | move <itemId> <status>" ;;
esac
