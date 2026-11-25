#!/usr/bin/env bash
# Deterministic artefact gates for a work-heavy-auto unit. A non-trivial issue may not
# leave the implement loop until ALL pass:
#   A) a PLAN OF RECORD in the pull request body, not the opening placeholder
#      ("plan incoming"). The body is the plan: a human reads it and the next pass
#      resumes from it.
#   B) the plan names its TEST ENTRY POINT: a "Test entry point: <where the test
#      goes>" line or heading. "Seam:" is accepted as an older spelling.
#   C) an issue-pinned UNIT test: a file whose name starts issue_<n>_ or
#      test_issue_<n>_, outside any e2e/ or integration/ directory.
#   D) an issue-pinned END-TO-END test: the same file names, inside an e2e/ or
#      integration/ directory. "End-to-end" is the top of the stack that changed:
#      a browser for a web app, the CLI for a command-line tool.
#
# A project with another layout sets GATES_UNIT_RE and GATES_E2E_RE: extended
# regular expressions over `git ls-tree` paths, where {n} stands for the issue.
#
# The judgement lives here, not in a model. Agents run this script and relay its
# JSON verdict.
#
# Usage: gates.sh <issue-number> <git-ref> <pr-number>
#   e.g. gates.sh 42 origin/claude/issue-42 1300
# Repository: $GH_REPO (OWNER/REPO), else the origin remote of the current checkout.
# Token: GH_USE_KEYRING=1 drops GITHUB_TOKEN so the gh keyring login is used.
# Prints one JSON object {number, pass, missing[]}.
# Exit 0 = pass, 1 = fail, 2 = could not measure (never a silent pass).
set -euo pipefail

n="${1:?issue number required (usage: gates.sh <issue> <ref> <pr>)}"
ref="${2:?git ref required, e.g. origin/claude/issue-42 or HEAD}"
pr="${3:-}"

json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
die2() { printf '{"number": %s, "pass": null, "error": %s}\n' "$n" "$(json_str "$1")"; exit 2; }

[ -n "$pr" ] || die2 "pr number required: the plan of record lives in the PR body (usage: gates.sh <issue> <ref> <pr>)"

GHSH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/../github/gh.sh"
[ -x "$GHSH" ] || die2 "gh.sh is missing or not executable at $GHSH. Repair: reinstall the plugin (claude plugin update ndev) so scripts/github/ sits beside scripts/work/"

repo="${GH_REPO:-}"
if [ -z "$repo" ]; then
  repo_err="$(mktemp)"
  repo="$("$GHSH" repo 2>"$repo_err" | jq -r .repo)" \
    || die2 "cannot find the GitHub repository: $(cat "$repo_err"). Repair: run inside the checkout, set GH_REPO=OWNER/REPO, or run 'gh auth login'"
  rm -f "$repo_err"
fi

body_err="$(mktemp)"; trap 'rm -f "$body_err"' EXIT
body=$(GH_REPO="$repo" "$GHSH" pr-read "$pr" 2>"$body_err" | jq -r '.body // ""') \
  || die2 "could not read the body of PR #${pr} in ${repo}: $(cat "$body_err"). Repair: check 'gh auth status' or set GH_USE_KEYRING=1"

files=$(git ls-tree -r --name-only "$ref" 2>&1) \
  || die2 "git ls-tree failed for ref ${ref}: ${files}. Repair: fetch the branch ('git fetch origin') or pass HEAD"

default_unit_re='(^|/)(test_)?issue_{n}_[^/]+$'
default_e2e_re='(^|/)(e2e|integration)/(.*/)?(test_)?issue_{n}_[^/]+$'
unit_re="${GATES_UNIT_RE:-$default_unit_re}"
e2e_re="${GATES_E2E_RE:-$default_e2e_re}"
unit_re="${unit_re//"{n}"/$n}"
e2e_re="${e2e_re//"{n}"/$n}"

missing=()

# A) The body still holds the placeholder the draft PR opens with.
if grep -qF 'plan incoming' <<<"$body"; then
  missing+=("plan: PR #${pr} body is still the opening placeholder. Write the plan of record into it (work-heavy skill F2)")
fi

# B) A labelled line ("Test entry point:", "**Test entry point:**", "- Seam:") or a
#    markdown heading ("## Test entry point").
if ! grep -qiE -e '^[[:space:]]*([-*][[:space:]]*)?(\*\*)?(test entry points?|seams?)(\*\*)?[[:space:]]*:' \
               -e '^[[:space:]]*#{1,6}[[:space:]]*(\*\*)?(test entry points?|seams?)\b' <<<"$body"; then
  missing+=("test entry point: PR #${pr} body names no test entry point. Add a 'Test entry point: <where the test goes, what it asserts>' line (work-heavy skill F2)")
fi

# C) Unit: a pinned file that is NOT under e2e/ or integration/.
if ! grep -E "$unit_re" <<<"$files" | grep -qvE "$e2e_re"; then
  missing+=("unit-test: no file matching ${unit_re} outside e2e/ or integration/ at ${ref}")
fi

# D) End-to-end.
if ! grep -qE "$e2e_re" <<<"$files"; then
  missing+=("e2e-test: no file matching ${e2e_re} at ${ref}")
fi

if [ ${#missing[@]} -eq 0 ]; then
  printf '{"number": %s, "pass": true, "missing": []}\n' "$n"
  exit 0
fi
printf '{"number": %s, "pass": false, "missing": [' "$n"
for i in "${!missing[@]}"; do
  [ "$i" -gt 0 ] && printf ', '
  printf '%s' "$(json_str "${missing[$i]}")"
done
printf ']}\n'
exit 1
