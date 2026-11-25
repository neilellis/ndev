#!/usr/bin/env bash
# Poll a GitHub pull request until its status, checks, comments, or reviews change.
#
# Usage:
#   wait-for-pr-change.sh <pr_number> [--interval 30] [--timeout <secs>] [--json] [--verbose] [--skip-success]
#
# Options:
#   <pr_number>            PR number (e.g. 1724 or #1724) or GitHub PR URL
#   --interval <seconds>   Polling interval in seconds (default: 30)
#   --timeout <seconds>    Max duration in seconds before giving up (default: 0 = no timeout)
#   --repo <owner/repo>    Repository (default: {{repo}} from lib.sh)
#   --json                 Output detected change in JSON format
#   -v, --verbose          Print timestamp and status on each polling cycle
#   --skip-success         Ignore successful intermediate checks until CI completes or fails
#   -h, --help             Show this help message
#
# Exit codes:
#   0: A status change was detected
#   1: Error (invalid PR, network failure on start)
#   2: Timeout reached without changes
#   130: Interrupted by user (SIGINT)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"

PR_RAW=""
INTERVAL=30
TIMEOUT=0
REPO_NAME="$REPO"
OUTPUT_JSON=false
VERBOSE=false
SKIP_SUCCESS=false

usage() {
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --interval|-i)
      INTERVAL="${2:?--interval requires a number of seconds}"
      shift 2
      ;;
    --timeout|-t)
      TIMEOUT="${2:?--timeout requires a number of seconds}"
      shift 2
      ;;
    --repo|-R)
      REPO_NAME="${2:?--repo requires OWNER/REPO}"
      shift 2
      ;;
    --json)
      OUTPUT_JSON=true
      shift
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    --skip-success)
      SKIP_SUCCESS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$PR_RAW" ]; then
        PR_RAW="$1"
        shift
      else
        echo "wait-for-pr-change.sh: unexpected argument '$1'" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

if [ -z "$PR_RAW" ]; then
  echo "wait-for-pr-change.sh: PR number is required" >&2
  usage >&2
  exit 1
fi

# Clean up PR number (strip leading '#' or parse from URL if passed)
PR_NUM="$(echo "$PR_RAW" | sed -E 's/.*\/pull\/([0-9]+).*/\1/' | sed 's/^#//')"
if ! [[ "$PR_NUM" =~ ^[0-9]+$ ]]; then
  echo "wait-for-pr-change.sh: invalid PR number '$PR_RAW'" >&2
  exit 1
fi

trap 'echo ""; echo "wait-for-pr-change.sh: interrupted by user" >&2; exit 130' INT TERM

# Run python engine to manage snapshots, polling, and diff detection
python3 - "$PR_NUM" "$INTERVAL" "$TIMEOUT" "$REPO_NAME" "$OUTPUT_JSON" "$VERBOSE" "$SKIP_SUCCESS" <<'EOF'
import sys
import os
import time
import json
import subprocess

pr_num = sys.argv[1]
interval = int(sys.argv[2])
timeout = int(sys.argv[3])
repo = sys.argv[4]
output_json = (sys.argv[5].lower() == "true")
verbose = (sys.argv[6].lower() == "true")
skip_success = (sys.argv[7].lower() == "true")

def gh_env():
    e = dict(os.environ)
    e.pop("GITHUB_TOKEN", None)
    return e

FIELDS = "state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,title,labels,comments,reviews,statusCheckRollup,updatedAt"

def fetch_pr():
    cmd = [
        "gh", "pr", "view", pr_num,
        "--repo", repo,
        "--json", FIELDS
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, env=gh_env())
    if res.returncode != 0:
        return None, res.stderr.strip()
    try:
        return json.loads(res.stdout), None
    except Exception as e:
        return None, str(e)

def read_pages(text):
    # gh api --paginate prints the pages as JSON documents one after the other. This reads each one.
    # The --slurp flag would make one array of them, but gh before 2.48 does not have it.
    decoder = json.JSONDecoder()
    pages = []
    pos = 0
    while True:
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos == len(text):
            return pages
        page, pos = decoder.raw_decode(text, pos)
        pages.append(page)

def fetch_workflows(head_sha, head_branch, pr_number):
    endpoint = f"repos/{repo}/actions/runs?head_sha={head_sha}&per_page=100"
    cmd = ["gh", "api", "--paginate", endpoint]
    res = subprocess.run(cmd, capture_output=True, text=True, env=gh_env())
    if res.returncode != 0:
        return None, f"'gh api --paginate {endpoint}' exited {res.returncode}: {res.stderr.strip()}"
    try:
        pages = read_pages(res.stdout)
    except ValueError as e:
        return None, f"'gh api --paginate {endpoint}' printed output that is not JSON ({e}): {res.stdout[:300]!r}"
    try:
        runs = []
        for page in pages:
            if not isinstance(page, dict) or not isinstance(page.get("workflow_runs"), list):
                return None, "workflow API returned an invalid page"
            runs.extend(page["workflow_runs"])
        latest = {}
        for run in runs:
            if run.get("head_sha") != head_sha:
                return None, "workflow API returned a run for a different head SHA"
            if run.get("head_branch") not in (None, head_branch):
                continue
            pull_requests = run.get("pull_requests") or []
            if pull_requests and not any(str(pr.get("number")) == str(pr_number) for pr in pull_requests):
                continue
            workflow_key = (
                run.get("workflow_id") or run.get("name") or run.get("id"),
                run.get("event") or "",
                run.get("head_branch") or "",
            )
            if workflow_key is None:
                return None, "workflow API returned a run without workflow identity"
            try:
                run_number = int(run.get("run_number") or 0)
            except (TypeError, ValueError):
                return None, "workflow API returned an invalid run number"
            identity = str(workflow_key)
            previous = latest.get(identity)
            if previous is None or run_number >= previous[0]:
                latest[identity] = (run_number, run)
        return [item[1] for item in latest.values()], None
    except Exception as e:
        return None, str(e)

def newest_runs(checks_raw):
    latest = {}
    for c in checks_raw:
        key = (c.get("workflowName") or "", c.get("name") or c.get("context") or "")
        started = c.get("startedAt") or ("" if c.get("status") == "COMPLETED" or c.get("state") else "9999")
        if key not in latest or started >= latest[key][0]:
            latest[key] = (started, c)
    return [item[1] for item in latest.values()]

def normalize_snapshot(data):
    comments = data.get("comments", []) or []
    last_c = comments[-1] if comments else {}
    reviews = data.get("reviews", []) or []
    last_r = reviews[-1] if reviews else {}
    checks_raw = newest_runs(data.get("statusCheckRollup", []) or [])

    checks = []
    completed_count = 0
    in_progress_count = 0
    queued_count = 0
    success_count = 0
    failure_count = 0
    skipped_count = 0
    neutral_count = 0
    non_success_count = 0

    for c in checks_raw:
        typename = c.get("__typename", "")
        if typename == "CheckRun":
            name = c.get("name", "")
            status = c.get("status", "")
            conclusion = c.get("conclusion", "")
            if status == "COMPLETED":
                completed_count += 1
                if conclusion == "SUCCESS":
                    success_count += 1
                elif conclusion == "SKIPPED":
                    skipped_count += 1
                elif conclusion == "NEUTRAL":
                    neutral_count += 1
                elif conclusion in ("FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"):
                    failure_count += 1
                    non_success_count += 1
                else:
                    # A terminal check without a successful conclusion is a failure in skip-success mode.
                    non_success_count += 1
            elif status == "IN_PROGRESS":
                in_progress_count += 1
            elif status == "QUEUED":
                queued_count += 1
            checks.append({"name": name, "status": status, "conclusion": conclusion})
        elif typename == "StatusContext":
            context = c.get("context", "")
            state = c.get("state", "")
            if state == "SUCCESS":
                completed_count += 1
                success_count += 1
            elif state in ("FAILURE", "ERROR"):
                completed_count += 1
                failure_count += 1
                non_success_count += 1
            elif state == "PENDING":
                in_progress_count += 1
            checks.append({"name": context, "status": state, "conclusion": state})

    checks.sort(key=lambda x: x["name"])

    author_login = ""
    if last_c and isinstance(last_c.get("author"), dict):
        author_login = last_c["author"].get("login", "")

    review_author = ""
    if last_r and isinstance(last_r.get("author"), dict):
        review_author = last_r["author"].get("login", "")

    return {
        "state": data.get("state"),
        "isDraft": data.get("isDraft"),
        "mergeable": data.get("mergeable"),
        "mergeStateStatus": data.get("mergeStateStatus"),
        "reviewDecision": data.get("reviewDecision") or "",
        "headRefOid": (data.get("headRefOid") or "")[:7],
        "fullHeadRefOid": data.get("headRefOid") or "",
        "headRefName": data.get("headRefName") or "",
        "title": data.get("title") or "",
        "labels": sorted([l.get("name", "") for l in data.get("labels", []) if isinstance(l, dict)]),
        "comments_count": len(comments),
        "last_comment_id": last_c.get("id"),
        "last_comment_author": author_login,
        "reviews_count": len(reviews),
        "last_review_state": last_r.get("state"),
        "last_review_author": review_author,
        "checks_total": len(checks),
        "checks_completed": completed_count,
        "checks_in_progress": in_progress_count,
        "checks_queued": queued_count,
        "checks_success": success_count,
        "checks_failure": failure_count,
        "checks_skipped": skipped_count,
        "checks_neutral": neutral_count,
        "checks_non_success": non_success_count,
        "checks": checks,
    }

def print_summary(snap, prefix="  "):
    state_str = snap["state"]
    if snap["isDraft"]:
        state_str += " (draft)"
    else:
        state_str += " (ready for review)"

    checks_str = f"{snap['checks_completed']}/{snap['checks_total']} completed"
    if snap['checks_in_progress'] > 0:
        checks_str += f" ({snap['checks_in_progress']} in progress)"
    if snap['checks_failure'] > 0:
        checks_str += f" ({snap['checks_failure']} failed)"

    print(f"{prefix}• State: {state_str}")
    print(f"{prefix}• Branch: {snap['headRefName']} ({snap['headRefOid']})")
    print(f"{prefix}• Mergeable: {snap['mergeable']} (status: {snap['mergeStateStatus']})")
    rev_dec = snap['reviewDecision'] or 'none'
    print(f"{prefix}• Reviews: {snap['reviews_count']} (decision: {rev_dec})")
    print(f"{prefix}• Comments: {snap['comments_count']}")
    print(f"{prefix}• Checks: {checks_str}")
    if snap['labels']:
        print(f"{prefix}• Labels: {', '.join(snap['labels'])}")

def diff_snapshots(s1, s2):
    changes = []
    change_dict = {}

    if s1["state"] != s2["state"]:
        msg = f"State changed: {s1['state']} -> {s2['state']}"
        changes.append(msg)
        change_dict["state"] = {"old": s1["state"], "new": s2["state"]}

    if s1["isDraft"] != s2["isDraft"]:
        d_old = "draft" if s1["isDraft"] else "ready for review"
        d_new = "draft" if s2["isDraft"] else "ready for review"
        msg = f"Draft status changed: {d_old} -> {d_new}"
        changes.append(msg)
        change_dict["isDraft"] = {"old": s1["isDraft"], "new": s2["isDraft"]}

    if s1["mergeable"] != s2["mergeable"] or s1["mergeStateStatus"] != s2["mergeStateStatus"]:
        msg = f"Mergeability changed: {s1['mergeable']} ({s1['mergeStateStatus']}) -> {s2['mergeable']} ({s2['mergeStateStatus']})"
        changes.append(msg)
        change_dict["mergeability"] = {
            "old": {"mergeable": s1["mergeable"], "status": s1["mergeStateStatus"]},
            "new": {"mergeable": s2["mergeable"], "status": s2["mergeStateStatus"]}
        }

    if s1["fullHeadRefOid"] != s2["fullHeadRefOid"]:
        msg = f"Head commit updated: {s1['headRefOid']} -> {s2['headRefOid']}"
        changes.append(msg)
        change_dict["headCommit"] = {"old": s1["fullHeadRefOid"], "new": s2["fullHeadRefOid"]}

    if s1["comments_count"] != s2["comments_count"] or s1["last_comment_id"] != s2["last_comment_id"]:
        author = s2.get("last_comment_author") or "unknown"
        msg = f"Comments updated: count {s1['comments_count']} -> {s2['comments_count']} (latest by @{author})"
        changes.append(msg)
        change_dict["comments"] = {"old_count": s1["comments_count"], "new_count": s2["comments_count"], "latest_author": author}

    if s1["reviewDecision"] != s2["reviewDecision"] or s1["reviews_count"] != s2["reviews_count"]:
        msg = f"Reviews updated: count {s1['reviews_count']} -> {s2['reviews_count']} (decision: '{s1['reviewDecision']}' -> '{s2['reviewDecision']}')"
        changes.append(msg)
        change_dict["reviews"] = {
            "old_count": s1["reviews_count"],
            "new_count": s2["reviews_count"],
            "old_decision": s1["reviewDecision"],
            "new_decision": s2["reviewDecision"]
        }

    if s1["labels"] != s2["labels"]:
        msg = f"Labels changed: {s1['labels']} -> {s2['labels']}"
        changes.append(msg)
        change_dict["labels"] = {"old": s1["labels"], "new": s2["labels"]}

    if s1["title"] != s2["title"]:
        msg = f"Title changed: '{s1['title']}' -> '{s2['title']}'"
        changes.append(msg)
        change_dict["title"] = {"old": s1["title"], "new": s2["title"]}

    c1_map = {c["name"]: c for c in s1["checks"]}
    c2_map = {c["name"]: c for c in s2["checks"]}
    check_diffs = []
    for name, c2 in c2_map.items():
        c1 = c1_map.get(name)
        if not c1:
            check_diffs.append(f"added '{name}' ({c2['status']}: {c2['conclusion'] or 'pending'})")
        elif c1 != c2:
            s1_str = c1["status"] + (f": {c1['conclusion']}" if c1["conclusion"] else "")
            s2_str = c2["status"] + (f": {c2['conclusion']}" if c2["conclusion"] else "")
            check_diffs.append(f"'{name}': {s1_str} -> {s2_str}")

    for name in c1_map:
        if name not in c2_map:
            check_diffs.append(f"removed '{name}'")

    if check_diffs:
        summary = f"Checks updated ({s2['checks_completed']}/{s2['checks_total']} completed, {s2['checks_failure']} failed): " + "; ".join(check_diffs[:5])
        if len(check_diffs) > 5:
            summary += f" (+{len(check_diffs) - 5} more)"
        changes.append(summary)
        change_dict["checks"] = {
            "summary": summary,
            "completed": s2["checks_completed"],
            "total": s2["checks_total"],
            "failed": s2["checks_failure"],
            "diffs": check_diffs
        }

    return changes, change_dict

def ci_complete(snap):
    """Return true only when this revision has at least one fully terminal check."""
    return (
        snap["checks_total"] > 0
        and snap["checks_completed"] == snap["checks_total"]
        and snap["checks_in_progress"] == 0
        and snap["checks_queued"] == 0
        and snap["checks_non_success"] == 0
    )

def workflow_state(runs):
    failure = 0
    pending = 0
    completed = 0
    neutral = 0
    for run in runs:
        status = (run.get("status") or "").upper()
        conclusion = (run.get("conclusion") or "").upper()
        if status != "COMPLETED":
            pending += 1
        elif conclusion in ("SUCCESS", "SKIPPED", "NEUTRAL"):
            completed += 1
            if conclusion == "NEUTRAL":
                neutral += 1
        else:
            failure += 1
    return failure, pending, completed, neutral

def skip_success_result(snap, reason, elapsed=0, polls=0, workflow_runs=None):
    changes = [reason]
    details = {"checks": {
        "completed": snap["checks_completed"],
        "total": snap["checks_total"],
        "failed": snap["checks_non_success"],
    }}
    snapshot = dict(snap)
    if workflow_runs is not None:
        wf_failure, wf_pending, wf_completed, wf_neutral = workflow_state(workflow_runs)
        details["workflows"] = {"completed": wf_completed, "total": len(workflow_runs), "failed": wf_failure, "neutral": wf_neutral}
        snapshot["workflow_runs_total"] = len(workflow_runs)
        snapshot["workflow_runs_completed"] = wf_completed
        snapshot["workflow_runs_in_progress"] = wf_pending
        snapshot["workflow_runs_failure"] = wf_failure
    if output_json:
        print(json.dumps({
            "pr": int(pr_num),
            "repo": repo,
            "elapsed_seconds": elapsed,
            "polls": polls,
            "changes": changes,
            "details": details,
            "snapshot": snapshot,
        }))
    else:
        print(f"\n[{time.strftime('%X')}] {reason}")
        print("\nCurrent state:")
        print_summary(snap)
    sys.stdout.flush()
    sys.exit(0)

# Initial snapshot
initial_data, err = fetch_pr()
if err:
    sys.stderr.write(f"wait-for-pr-change.sh: failed to fetch PR #{pr_num}: {err}\n")
    sys.exit(1)

initial_snap = normalize_snapshot(initial_data)

if skip_success:
    if initial_snap["checks_non_success"] > 0:
        skip_success_result(initial_snap, "CI failure detected in the current PR revision")
    initial_workflows, workflow_err = fetch_workflows(initial_snap["fullHeadRefOid"], initial_snap["headRefName"], pr_num)
    if workflow_err:
        sys.stderr.write(f"wait-for-pr-change.sh: failed to fetch workflow runs for PR #{pr_num}: {workflow_err}\n")
        sys.exit(1)
    wf_failure, wf_pending, _, _ = workflow_state(initial_workflows)
    if wf_failure > 0:
        skip_success_result(initial_snap, "CI failure detected in the current PR revision", workflow_runs=initial_workflows)
    if ci_complete(initial_snap) and not wf_pending:
        confirmed_data, confirmed_err = fetch_pr()
        if confirmed_err:
            sys.stderr.write(f"wait-for-pr-change.sh: failed to confirm PR head: {confirmed_err}\n")
            sys.exit(1)
        confirmed_snap = normalize_snapshot(confirmed_data)
        if confirmed_snap["fullHeadRefOid"] != initial_snap["fullHeadRefOid"]:
            initial_snap = confirmed_snap
        else:
            if confirmed_snap["checks_non_success"] > 0:
                skip_success_result(confirmed_snap, "CI failure detected in the current PR revision", workflow_runs=initial_workflows)
            if ci_complete(confirmed_snap) and not wf_pending:
                skip_success_result(confirmed_snap, "CI complete for the current PR revision", workflow_runs=initial_workflows)

if not output_json:
    print(f"Watching PR #{pr_num} ({repo})...")
    print("Initial state:")
    print_summary(initial_snap)
    print(f"Polling every {interval}s for changes...")
    sys.stdout.flush()

start_time = time.time()
poll_count = 0
baseline_snap = initial_snap

while True:
    time.sleep(interval)
    poll_count += 1
    elapsed = int(time.time() - start_time)

    current_data, err = fetch_pr()
    if err:
        sys.stderr.write(f"[{time.strftime('%X')}] Warning: poll failed ({err}), retrying in {interval}s...\n")
        sys.stderr.flush()
        if skip_success and timeout > 0 and elapsed >= timeout:
            if output_json:
                print(json.dumps({"error": "timeout", "elapsed_seconds": elapsed, "polls": poll_count}))
            else:
                sys.stderr.write(f"\nwait-for-pr-change.sh: timeout reached ({timeout}s) without CI completion or failure\n")
            sys.exit(2)
        continue

    current_snap = normalize_snapshot(current_data)
    if skip_success:
        if current_snap["fullHeadRefOid"] != baseline_snap["fullHeadRefOid"]:
            baseline_snap = current_snap
        if current_snap["checks_non_success"] > 0:
            skip_success_result(current_snap, "CI failure detected in the current PR revision", elapsed, poll_count)
        current_workflows, workflow_err = fetch_workflows(current_snap["fullHeadRefOid"], current_snap["headRefName"], pr_num)
        if workflow_err:
            sys.stderr.write(f"wait-for-pr-change.sh: failed to fetch workflow runs for PR #{pr_num}: {workflow_err}\n")
            sys.exit(1)
        wf_failure, wf_pending, _, _ = workflow_state(current_workflows)
        if wf_failure > 0:
            skip_success_result(current_snap, "CI failure detected in the current PR revision", elapsed, poll_count, current_workflows)
        if ci_complete(current_snap) and not wf_pending:
            confirmed_data, confirmed_err = fetch_pr()
            if confirmed_err:
                sys.stderr.write(f"wait-for-pr-change.sh: failed to confirm PR head: {confirmed_err}\n")
                sys.exit(1)
            confirmed_snap = normalize_snapshot(confirmed_data)
            if confirmed_snap["fullHeadRefOid"] != current_snap["fullHeadRefOid"]:
                baseline_snap = confirmed_snap
                continue
            if confirmed_snap["checks_non_success"] > 0:
                skip_success_result(confirmed_snap, "CI failure detected in the current PR revision", elapsed, poll_count, current_workflows)
            if not ci_complete(confirmed_snap) or wf_pending:
                continue
            skip_success_result(confirmed_snap, "CI complete for the current PR revision", elapsed, poll_count, current_workflows)
        if verbose and not output_json:
            print(f"[{time.strftime('%X')}] Poll #{poll_count} ({elapsed}s elapsed): CI still running")
            sys.stdout.flush()
        if timeout > 0 and elapsed >= timeout:
            if output_json:
                print(json.dumps({"error": "timeout", "elapsed_seconds": elapsed, "polls": poll_count}))
            else:
                sys.stderr.write(f"\nwait-for-pr-change.sh: timeout reached ({timeout}s) without CI completion or failure\n")
            sys.exit(2)
        continue

    changes, change_dict = diff_snapshots(initial_snap, current_snap)

    if changes:
        if output_json:
            result = {
                "pr": int(pr_num),
                "repo": repo,
                "elapsed_seconds": elapsed,
                "polls": poll_count,
                "changes": changes,
                "details": change_dict,
                "snapshot": current_snap
            }
            print(json.dumps(result))
        else:
            print(f"\n[{time.strftime('%X')}] Change detected in PR #{pr_num} (after {elapsed}s):")
            for c in changes:
                print(f"  • {c}")
            print("\nCurrent state:")
            print_summary(current_snap)
        sys.stdout.flush()
        sys.exit(0)

    if verbose and not output_json:
        print(f"[{time.strftime('%X')}] Poll #{poll_count} ({elapsed}s elapsed): no change")
        sys.stdout.flush()

    if timeout > 0 and elapsed >= timeout:
        if output_json:
            print(json.dumps({"error": "timeout", "elapsed_seconds": elapsed, "polls": poll_count}))
        else:
            sys.stderr.write(f"\nwait-for-pr-change.sh: timeout reached ({timeout}s) without status changes\n")
        sys.exit(2)
EOF
