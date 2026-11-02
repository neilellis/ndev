#!/usr/bin/env bash
# Fetch merged pull requests in a window and chunk their bodies for sub-agent summarisation.
#
#   fetch-prs.sh --since 2026-07-29 [--author LOGIN|me|all] [--chunks N] [--count-only]
#   fetch-prs.sh --period 7d        [--author LOGIN|me|all] [--chunks N]
#   --repo OWNER/REPO               default: GH_REPO, else the current checkout
#
# Writes prs.json + chunk1.md..chunkN.md into the scratchpad (or --out DIR) and prints the paths.
# --count-only prints just the total and exits — use it to get the denominator for "113 of 134".
set -euo pipefail

SINCE=""
PERIOD=""
AUTHOR="me"
CHUNKS=5
COUNT_ONLY=0
OUT="${CLAUDE_SCRATCHPAD:-}"
REPO_ARG="${GH_REPO:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --since)      SINCE="$2"; shift 2 ;;
    --period)     PERIOD="$2"; shift 2 ;;
    --author)     AUTHOR="$2"; shift 2 ;;
    --chunks)     CHUNKS="$2"; shift 2 ;;
    --out)        OUT="$2"; shift 2 ;;
    --repo)       REPO_ARG="$2"; shift 2 ;;
    --count-only) COUNT_ONLY=1; shift ;;
    -h|--help)    sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- resolve the window ------------------------------------------------------
if [ -z "$SINCE" ]; then
  [ -n "$PERIOD" ] || PERIOD=7d
  n="${PERIOD%[dwm]}"; unit="${PERIOD##*[0-9]}"
  case "$unit" in
    d|"") days=$n ;;
    w)    days=$((n * 7)) ;;
    m)    days=$((n * 30)) ;;
    *)    echo "bad --period '$PERIOD' (use 7d, 2w, 1m or --since YYYY-MM-DD)" >&2; exit 2 ;;
  esac
  # BSD date (macOS) first, GNU date second.
  SINCE=$(date -v-"${days}"d +%Y-%m-%d 2>/dev/null || date -d "${days} days ago" +%Y-%m-%d)
fi

# --- resolve the author ------------------------------------------------------
# GH_USE_KEYRING=1 drops GITHUB_TOKEN so the gh keyring login is used.
GH() {
  if [ "${GH_USE_KEYRING:-0}" = "1" ]; then env -u GITHUB_TOKEN gh "$@"; else gh "$@"; fi
}

if [ -z "$REPO_ARG" ]; then
  REPO_ARG="$(GH api 'repos/{owner}/{repo}' --jq .full_name)" || {
    echo "fetch-prs.sh: cannot find the GitHub repository for $(pwd). Pass --repo OWNER/REPO or run 'gh auth status'." >&2
    exit 2
  }
fi

case "$AUTHOR" in
  all)  AUTHOR_Q="" ;;
  me|"") AUTHOR_Q="author:$(GH api user --jq .login)" ;;
  *)    AUTHOR_Q="author:$AUTHOR" ;;
esac

QUERY="merged:>=$SINCE $AUTHOR_Q"

# --- fetch -------------------------------------------------------------------
if [ "$COUNT_ONLY" = "1" ]; then
  GH api -X GET search/issues -f q="repo:$REPO_ARG is:pr is:merged $QUERY" -f per_page=100 --paginate --jq '.items[] | {number}' | jq -s . | python3 -c \
    'import json,sys; n=len(json.load(sys.stdin)); print(n); sys.exit("fetch-prs.sh: reached the 500-PR limit; the count is a lower bound. Use a shorter --since window.") if n>=500 else None'
  exit 0
fi

if [ -z "$OUT" ]; then
  OUT=$(mktemp -d "${TMPDIR:-/tmp}/report-work-done.XXXXXX")
fi
mkdir -p "$OUT"

# REST search (its own quota, not GraphQL); the search API returns at most 1000 results.
GH api -X GET search/issues -f q="repo:$REPO_ARG is:pr is:merged $QUERY" -f per_page=100 --paginate \
  --jq '.items[] | {number, title, mergedAt: .pull_request.merged_at, author: {login: .user.login}, body: (.body // "")}' \
  | jq -s . > "$OUT/prs.json"

# --- chunk (stride, so every chunk sees a mix of dates and topics) -----------
python3 - "$OUT" "$CHUNKS" "$SINCE" "$QUERY" <<'PY'
import json, sys, collections
out, chunks, since, query = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
prs = json.load(open(f"{out}/prs.json"))
prs.sort(key=lambda p: p["number"])
if len(prs) >= 500:
    sys.exit("fetch-prs.sh: reached the 500-PR limit; results are incomplete. Use a shorter --since window and run again.")

print(f"window:  merged >= {since}")
print(f"query:   {query}")
print(f"total:   {len(prs)} merged pull requests")
by = collections.Counter(p["author"]["login"] for p in prs)
print("authors: " + ", ".join(f"{k} {v}" for k, v in by.most_common()))

if len(prs) < 15:
    print("\nFewer than 15 — read them yourself, skip the fan-out.")

n = max(1, min(chunks, 6))
for i in range(n):
    part = prs[i::n]
    if not part:
        continue
    path = f"{out}/chunk{i+1}.md"
    with open(path, "w") as f:
        for p in sorted(part, key=lambda x: x["number"]):
            body = (p["body"] or "")[:2500]
            f.write(f"## #{p['number']} ({p['mergedAt'][:10]}) {p['title']}\n\n{body}\n\n---\n\n")
    print(f"  {path}  ({len(part)} pull requests)")
PY
